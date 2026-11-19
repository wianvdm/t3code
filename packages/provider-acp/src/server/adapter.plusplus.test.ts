// @effect-diagnostics nodeBuiltinImport:off - resolves the existing fake ACP agent from this test file.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { ProjectInstructions } from "@t3tools/provider-core/server/projectInstructions";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import {
  AcpProviderCapabilitiesV2,
  acpScopedNativeId,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
} from "./adapter.ts";

const DRIVER = ProviderDriverKind.make("acp-project-instructions-test");
const INSTRUCTIONS_V1 = {
  id: "instructions-v1",
  text: "<token_efficiency>version one</token_efficiency>",
} as const;
const INSTRUCTIONS_V2 = {
  id: "instructions-v2",
  text: "<token_efficiency>version two</token_efficiency>",
} as const;

const layerHost = Layer.effect(
  ProviderHost.ProviderHost,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-acp-project-instructions-host-",
    });
    const stateDir = path.join(baseDir, "userdata");
    const attachmentsDir = path.join(stateDir, "attachments");
    yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
    return ProviderHost.ProviderHost.of({
      paths: {
        cwd: process.cwd(),
        baseDir,
        stateDir,
        providerStatusCacheDir: path.join(baseDir, "caches"),
        attachmentsDir,
      },
      settings: {
        get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
        changes: Stream.empty,
        subscribe: Effect.succeed(Stream.empty),
      },
      shouldRunBackgroundWork: () => Effect.succeed(true),
      resolveAttachmentPath: () => null,
      credentials: () => Effect.die("Credentials are not used by this test"),
    });
  }),
);

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerHost.pipe(Layer.provide(NodeServices.layer)),
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
  readonly environment?: Readonly<Record<string, string>>;
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
            env: { T3_ACP_SESSION_LIFECYCLE: "1", ...input.environment },
          },
          authMethodId: "test",
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
          ),
        ),
      );
      return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
    });
}

function makeTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly instanceId: ProviderInstanceId;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly modelSelection: ModelSelection;
  readonly now: DateTime.Utc;
  readonly ordinal: number;
  readonly text: string;
  readonly projectInstructions: ProjectInstructions | undefined;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  const suffix = `${input.threadId}:${input.ordinal}`;
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make(`project:${input.threadId}`),
      title: "ACP project instructions test",
      providerInstanceId: input.instanceId,
      modelSelection: input.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId: input.threadId,
    runId: RunId.make(`run:${suffix}`),
    runOrdinal: input.ordinal,
    providerTurnOrdinal: input.ordinal,
    attemptId: RunAttemptId.make(`attempt:${suffix}`),
    rootNodeId: NodeId.make(`node:${suffix}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message:${suffix}`),
      text: input.text,
      attachments: [],
    },
    modelSelection: input.modelSelection,
    runtimePolicy: input.runtimePolicy,
    ...(input.projectInstructions === undefined
      ? {}
      : { projectInstructions: input.projectInstructions }),
  };
}

const makeDeliveryHarness = Effect.fnUntraced(function* (
  environment: Readonly<Record<string, string>> = {},
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../../apps/server/scripts/acp-mock-agent.ts", import.meta.url),
  );
  const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
  const instanceId = ProviderInstanceId.make("acp-project-instructions-test");
  const threadId = ThreadId.make("thread-acp-project-instructions");
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const adapter = yield* makeAcpAdapterV2({
    instanceId,
    flavor: {
      driver: DRIVER,
      capabilities: AcpProviderCapabilitiesV2,
      supportsCompaction: true,
      interruptPromptOnCancel: true,
      makeRuntime: makeMockRuntime({
        childProcessSpawner,
        mockAgentPath,
        protocolEvents,
        environment,
      }),
    },
    selfInvocation: yield* resolveSelfInvocation(),
  });
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: process.cwd(),
  });
  const modelSelection = { instanceId, model: "default" } as const;
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-acp-project-instructions"),
    modelSelection,
    runtimePolicy,
  });
  let providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  let ordinal = 0;

  const startTurn = Effect.fnUntraced(function* (input: {
    readonly text: string;
    readonly projectInstructions?: ProjectInstructions | undefined;
  }) {
    const turnOrdinal = ++ordinal;
    yield* runtime.startTurn(
      makeTurnInput({
        threadId,
        providerThread,
        instanceId,
        runtimePolicy,
        modelSelection,
        now,
        ordinal: turnOrdinal,
        text: input.text,
        projectInstructions: input.projectInstructions,
      }),
    );
    while (true) {
      const event = yield* Queue.take(protocolEvents);
      if (isPromptEvent(event)) {
        return {
          blocks: promptTextBlocks(event),
          providerTurnId: idAllocator.derive.providerTurn({
            driver: DRIVER,
            nativeTurnId: acpScopedNativeId(instanceId, `mock-session-1:turn:${turnOrdinal}`),
          }),
        };
      }
    }
  });

  const awaitTerminal = Effect.fnUntraced(function* (expectedStatus = "completed") {
    const terminal = yield* runtime.events.pipe(
      Stream.filter((event) => event.type === "turn.terminal"),
      Stream.runHead,
    );
    assert.equal(Option.getOrThrow(terminal).status, expectedStatus);
  });

  const runTurn = Effect.fnUntraced(function* (input: {
    readonly text: string;
    readonly projectInstructions?: ProjectInstructions | undefined;
    readonly expectedStatus?: string;
  }) {
    const { blocks } = yield* startTurn(input);
    yield* awaitTerminal(input.expectedStatus);
    return blocks;
  });

  return {
    runTurn,
    startTurn,
    awaitTerminal,
    interruptTurn: (
      providerTurnId: Parameters<typeof runtime.interruptTurn>[0]["providerTurnId"],
    ) => runtime.interruptTurn({ providerThread, providerTurnId }),
    replaceSession: Effect.gen(function* () {
      providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
        forceNewNativeThread: true,
        existingProviderThread: providerThread,
      });
    }),
  };
});

function assertDelivered(
  blocks: ReadonlyArray<{ readonly type: "text"; readonly text: string }>,
  instructions: ProjectInstructions,
) {
  assert.isTrue(blocks.at(-1)?.text.endsWith(instructions.text));
}

function assertNotDelivered(
  blocks: ReadonlyArray<{ readonly type: "text"; readonly text: string }>,
) {
  assert.isFalse(blocks.some((block) => block.text.includes("<token_efficiency>")));
}

describe("ACP project instructions delivery", () => {
  it.live(
    "delivers the first turn inside the trailing runtime block without changing user text",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeDeliveryHarness();
        const blocks = yield* harness.runTurn({
          text: "Keep my request unchanged.",
          projectInstructions: INSTRUCTIONS_V1,
        });
        assert.include(
          blocks[0]?.text,
          "<user_request>\nKeep my request unchanged.\n</user_request>",
        );
        assert.notInclude(blocks[0]?.text, INSTRUCTIONS_V1.text);
        assertDelivered(blocks, INSTRUCTIONS_V1);
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("does not accumulate unchanged instructions on the second turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeDeliveryHarness();
      yield* harness.runTurn({ text: "First", projectInstructions: INSTRUCTIONS_V1 });
      const blocks = yield* harness.runTurn({
        text: "Second",
        projectInstructions: INSTRUCTIONS_V1,
      });
      assertNotDelivered(blocks);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("resends when the instructions id changes", () =>
    Effect.gen(function* () {
      const harness = yield* makeDeliveryHarness();
      yield* harness.runTurn({ text: "First", projectInstructions: INSTRUCTIONS_V1 });
      const blocks = yield* harness.runTurn({
        text: "Changed",
        projectInstructions: INSTRUCTIONS_V2,
      });
      assertDelivered(blocks, INSTRUCTIONS_V2);
      assert.notInclude(blocks.at(-1)?.text, INSTRUCTIONS_V1.text);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("stops delivery after disable without sending retraction text", () =>
    Effect.gen(function* () {
      const harness = yield* makeDeliveryHarness();
      yield* harness.runTurn({ text: "Enabled", projectInstructions: INSTRUCTIONS_V1 });
      const disabled = yield* harness.runTurn({ text: "Disabled" });
      const stillDisabled = yield* harness.runTurn({ text: "Still disabled" });
      assertNotDelivered(disabled);
      assertNotDelivered(stillDisabled);
      assert.isFalse(
        [...disabled, ...stillDisabled].some((block) => /withdraw|retract/i.test(block.text)),
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("reinjects unchanged instructions after observed compaction", () =>
    Effect.gen(function* () {
      const harness = yield* makeDeliveryHarness({ T3_ACP_COMPACTION_PROMPT_ORDINALS: "2" });
      yield* harness.runTurn({ text: "Before compaction", projectInstructions: INSTRUCTIONS_V1 });
      yield* harness.runTurn({ text: "Compact now", projectInstructions: INSTRUCTIONS_V1 });
      const blocks = yield* harness.runTurn({
        text: "After compaction",
        projectInstructions: INSTRUCTIONS_V1,
      });
      assertDelivered(blocks, INSTRUCTIONS_V1);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("skips native slash turns and delivers on the next ordinary turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeDeliveryHarness();
      const slash = yield* harness.runTurn({
        text: "  /native-command",
        projectInstructions: INSTRUCTIONS_V1,
      });
      assert.deepEqual(slash, [{ type: "text", text: "  /native-command" }]);
      const ordinary = yield* harness.runTurn({
        text: "Ordinary turn",
        projectInstructions: INSTRUCTIONS_V1,
      });
      assertDelivered(ordinary, INSTRUCTIONS_V1);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("redelivers on the next turn after an interrupted delivering turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeDeliveryHarness({ T3_ACP_PROMPT_DELAY_MS: "1000" });
      const interrupted = yield* harness.startTurn({
        text: "Interrupt this delivery",
        projectInstructions: INSTRUCTIONS_V1,
      });
      assertDelivered(interrupted.blocks, INSTRUCTIONS_V1);
      yield* harness.interruptTurn(interrupted.providerTurnId);
      yield* harness.awaitTerminal("interrupted");
      const retry = yield* harness.runTurn({
        text: "Retry after interruption",
        projectInstructions: INSTRUCTIONS_V1,
      });
      assertDelivered(retry, INSTRUCTIONS_V1);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("redelivers on the retry after a failed delivering prompt", () =>
    Effect.gen(function* () {
      const harness = yield* makeDeliveryHarness({ T3_ACP_FAIL_PROMPT_ORDINAL: "1" });
      const failed = yield* harness.runTurn({
        text: "Fail this delivery",
        projectInstructions: INSTRUCTIONS_V1,
        expectedStatus: "failed",
      });
      assertDelivered(failed, INSTRUCTIONS_V1);
      const retry = yield* harness.runTurn({
        text: "Retry after failure",
        projectInstructions: INSTRUCTIONS_V1,
      });
      assertDelivered(retry, INSTRUCTIONS_V1);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("redelivers after a delivering prompt ends with an idle error", () =>
    Effect.gen(function* () {
      const harness = yield* makeDeliveryHarness({ T3_ACP_IDLE_ERROR: "1" });
      const failed = yield* harness.runTurn({
        text: "Fail after delivery",
        projectInstructions: INSTRUCTIONS_V1,
        expectedStatus: "failed",
      });
      assertDelivered(failed, INSTRUCTIONS_V1);
      const retry = yield* harness.runTurn({
        text: "Retry after idle error",
        projectInstructions: INSTRUCTIONS_V1,
      });
      assertDelivered(retry, INSTRUCTIONS_V1);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("resends unchanged instructions in a new native session", () =>
    Effect.gen(function* () {
      const harness = yield* makeDeliveryHarness();
      yield* harness.runTurn({ text: "Old session", projectInstructions: INSTRUCTIONS_V1 });
      yield* harness.replaceSession;
      const blocks = yield* harness.runTurn({
        text: "New session",
        projectInstructions: INSTRUCTIONS_V1,
      });
      assertDelivered(blocks, INSTRUCTIONS_V1);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
