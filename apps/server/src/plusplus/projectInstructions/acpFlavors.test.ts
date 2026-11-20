import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProjectInstructions } from "@t3tools/provider-core/server/projectInstructions";
import { GrokSettings } from "@t3tools/provider-grok/settings";
import { makeGrokAdapterV2, makeXAiPromptCompletionRuntime } from "@t3tools/provider-grok/testing";
import { KiroSettings } from "@t3tools/provider-kiro/settings";
import { makeKiroAdapterV2 } from "@t3tools/provider-kiro/testing";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import { makeTurnInput } from "../../orchestration-v2/Adapters/AcpAdapterV2.testkit.ts";
import { makeAntigravityAcpAdapterFlavor } from "../../orchestration-v2/Adapters/AntigravityAdapterV2.ts";

const INSTRUCTIONS = {
  id: "flavor-instructions-v1",
  text: "<token_efficiency>flavor instructions</token_efficiency>",
} as const;
const decodeGrokSettings = Schema.decodeEffect(GrokSettings);
const decodeKiroSettings = Schema.decodeEffect(KiroSettings);

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

function rawProtocolRequest(
  event: EffectAcpProtocol.AcpProtocolLogEvent,
): { readonly method?: unknown; readonly params?: unknown } | undefined {
  if (event.stage !== "raw" || typeof event.payload !== "string") return undefined;
  for (const line of event.payload.split("\n")) {
    const decoded = Option.getOrUndefined(decodeUnknownJson(line.trim()));
    if (typeof decoded === "object" && decoded !== null && "method" in decoded) return decoded;
  }
  return undefined;
}

function isPromptEvent(event: EffectAcpProtocol.AcpProtocolLogEvent): boolean {
  return event.direction === "outgoing" && rawProtocolRequest(event)?.method === "session/prompt";
}

function promptTextBlocks(event: EffectAcpProtocol.AcpProtocolLogEvent) {
  const params = rawProtocolRequest(event)?.params;
  const prompt =
    typeof params === "object" && params !== null ? Reflect.get(params, "prompt") : undefined;
  if (!Array.isArray(prompt)) return [];
  return prompt.flatMap((block) =>
    typeof block === "object" &&
    block !== null &&
    Reflect.get(block, "type") === "text" &&
    typeof Reflect.get(block, "text") === "string"
      ? [{ type: "text" as const, text: Reflect.get(block, "text") as string }]
      : [],
  );
}

function makeMockRuntime(input: {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly mockAgentPath: string;
  readonly protocolEvents: Queue.Queue<EffectAcpProtocol.AcpProtocolLogEvent>;
  readonly wrapRuntime?: (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  ) => AcpSessionRuntime.AcpSessionRuntime["Service"];
}): AcpAdapterV2Flavor["makeRuntime"] {
  return (runtimeInput) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          ...runtimeInput,
          protocolLogging: {
            ...runtimeInput.protocolLogging,
            logIncoming: true,
            logOutgoing: true,
            logger: (event) => Queue.offer(input.protocolEvents, event).pipe(Effect.asVoid),
          },
          spawn: {
            command: process.execPath,
            args: [input.mockAgentPath],
            cwd: runtimeInput.cwd,
            env: { T3_ACP_SESSION_LIFECYCLE: "1" },
          },
          authMethodId: "test",
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
          ),
        ),
      );
      const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
      return input.wrapRuntime?.(runtime) ?? runtime;
    });
}

const awaitTerminal = Effect.fnUntraced(function* (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
) {
  const terminal = yield* runtime.events.pipe(
    Stream.filter((event) => event.type === "turn.terminal"),
    Stream.runHead,
  );
  assert.equal(Option.getOrThrow(terminal).status, "completed");
});

const runTurn = Effect.fnUntraced(function* (input: {
  readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly protocolEvents: Queue.Queue<EffectAcpProtocol.AcpProtocolLogEvent>;
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
}) {
  yield* input.runtime.startTurn(input.turnInput);
  yield* awaitTerminal(input.runtime);
  while (true) {
    const event = yield* Queue.take(input.protocolEvents);
    if (isPromptEvent(event)) return promptTextBlocks(event);
  }
});

function turnWithInstructions(
  base: ProviderAdapter.ProviderAdapterV2TurnInput,
  projectInstructions: ProjectInstructions,
): ProviderAdapter.ProviderAdapterV2TurnInput {
  return { ...base, projectInstructions };
}

const runtimePolicy = (cwd = process.cwd()) =>
  ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "approval-required",
    interactionMode: "default",
    cwd,
  });

describe("ACP flavor project instructions", () => {
  it.live("Grok $skill rewrites to a native slash turn and defers the block", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hostPlatform = yield* HostProcess.Platform;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const catalog = { skills: [{ name: "deploy", source: { path: "/s/deploy/SKILL.md" } }] };
      const grokPath = writeFakeCli({
        directory: yield* fileSystem.makeTempDirectoryScoped(),
        name: "grok",
        source: `process.stdout.write(${JSON.stringify(`${JSON.stringify(catalog)}\n`)});\n`,
        platform: hostPlatform,
      });
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const instanceId = ProviderInstanceId.make("grok-project-instructions");
      const adapter = yield* makeGrokAdapterV2({
        instanceId,
        settings: yield* decodeGrokSettings({ binaryPath: grokPath }),
        environment: { ...process.env },
        hostPlatform,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeMockRuntime({ childProcessSpawner, mockAgentPath, protocolEvents })(input).pipe(
            Effect.flatMap(makeXAiPromptCompletionRuntime),
          ),
      });
      const threadId = ThreadId.make("grok-project-instructions");
      const policy = runtimePolicy();
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("grok-project-instructions"),
        modelSelection,
        runtimePolicy: policy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policy,
      });
      const now = yield* DateTime.now;
      const base = { threadId, providerThread, instanceId, runtimePolicy: policy, now };
      const slash = yield* runTurn({
        runtime,
        protocolEvents,
        turnInput: turnWithInstructions(
          makeTurnInput({ ...base, ordinal: 1, messageText: "$deploy ship it" }),
          INSTRUCTIONS,
        ),
      });
      assert.deepEqual(slash, [{ type: "text", text: "/deploy ship it" }]);
      const ordinary = yield* runTurn({
        runtime,
        protocolEvents,
        turnInput: turnWithInstructions(
          makeTurnInput({ ...base, ordinal: 2, messageText: "Continue" }),
          INSTRUCTIONS,
        ),
      });
      assert.isTrue(ordinary.at(-1)?.text.endsWith(INSTRUCTIONS.text));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("Kiro compactSession uses its native request and reinjects afterward", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const compactRequests = yield* Ref.make<Array<unknown>>([]);
      const instanceId = ProviderInstanceId.make("kiro-project-instructions");
      const adapter = yield* makeKiroAdapterV2({
        instanceId,
        settings: yield* decodeKiroSettings({ enabled: true }),
        environment: {},
        selfInvocation: yield* resolveSelfInvocation(),
        defaultModel: Effect.succeed("default"),
        makeRuntime: makeMockRuntime({
          childProcessSpawner,
          mockAgentPath,
          protocolEvents,
          wrapRuntime: (runtime) => ({
            ...runtime,
            // Kiro offers compaction only when initialize lists its extension method.
            start: () =>
              runtime.start().pipe(
                Effect.map((started) => ({
                  ...started,
                  initializeResult: {
                    ...started.initializeResult,
                    agentCapabilities: {
                      ...started.initializeResult.agentCapabilities,
                      _meta: { kiro: { extensionMethods: ["_kiro/session/compact"] } },
                    },
                  },
                })),
              ),
            request: (method, payload) =>
              method === "_kiro/session/compact"
                ? Ref.update(compactRequests, (requests) => [...requests, payload]).pipe(
                    Effect.as({ success: true }),
                  )
                : runtime.request(method, payload),
          }),
        }),
      });
      const threadId = ThreadId.make("kiro-project-instructions");
      const policy = runtimePolicy();
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("kiro-project-instructions"),
        modelSelection,
        runtimePolicy: policy,
      });
      assert.isDefined(runtime.compactThread);
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policy,
      });
      const now = yield* DateTime.now;
      const base = { threadId, providerThread, instanceId, runtimePolicy: policy, now };
      yield* runTurn({
        runtime,
        protocolEvents,
        turnInput: turnWithInstructions(
          makeTurnInput({ ...base, ordinal: 1, messageText: "Before compact" }),
          INSTRUCTIONS,
        ),
      });
      yield* runtime.startTurn(
        turnWithInstructions(
          makeTurnInput({ ...base, ordinal: 2, messageText: "/compact" }),
          INSTRUCTIONS,
        ),
      );
      yield* awaitTerminal(runtime);
      assert.deepEqual(yield* Ref.get(compactRequests), [{ sessionId: "mock-session-1" }]);
      const afterCompact = yield* runTurn({
        runtime,
        protocolEvents,
        turnInput: turnWithInstructions(
          makeTurnInput({ ...base, ordinal: 3, messageText: "After compact" }),
          INSTRUCTIONS,
        ),
      });
      assert.isTrue(afterCompact.at(-1)?.text.endsWith(INSTRUCTIONS.text));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it("Antigravity keeps its capability-gated PR-linking flag and no compaction", () => {
    const flavor = makeAntigravityAcpAdapterFlavor({
      instanceId: ProviderInstanceId.make("antigravity-project-instructions"),
      random: undefined as never,
      fileSystem: undefined as never,
      path: undefined as never,
      host: undefined as never,
      selfInvocation: undefined as never,
      makeRuntime: () => Effect.die("not spawned in this test"),
      withProcess: (_stop, task) => task,
      defaultModel: Effect.undefined,
    });
    assert.notStrictEqual(flavor.supportsCompaction, true);
    assert.isUndefined(flavor.compactSession);
    assert.isTrue(
      flavor.sessionCarriesPullRequestLinking?.({
        protocolVersion: 1,
        agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } },
        authMethods: [],
        agentInfo: { name: "antigravity", version: "1.4.5" },
      }),
    );
    assert.isFalse(
      flavor.sessionCarriesPullRequestLinking?.({
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [],
        agentInfo: { name: "antigravity", version: "1.5.1" },
      }),
    );
  });
});
