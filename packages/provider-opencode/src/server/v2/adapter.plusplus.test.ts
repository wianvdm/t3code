import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import type { ProjectInstructions } from "@t3tools/plusplus/projectInstructions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { OPENCODE_PROVIDER } from "../adapter.ts";
import * as OpenCode2Client from "./OpenCode2Client.ts";
import * as OpenCode2Server from "./OpenCode2Server.ts";
import * as OpenCode2Adapter from "./adapter.ts";

const INSTANCE_ID = ProviderInstanceId.make("opencode");
const THREAD_ID = ThreadId.make("thread-opencode2-project-instructions");
const SESSION_ID = "ses_opencode2_project_instructions";
const WORKSPACE = "/workspace";
const FIRST: ProjectInstructions = {
  id: "project-instructions-1",
  text: "<token_efficiency>Prefer concise changes.</token_efficiency>",
};
const SECOND: ProjectInstructions = {
  id: "project-instructions-2",
  text: "<token_efficiency>Reuse existing modules.</token_efficiency>",
};

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer({ cwd: WORKSPACE }).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

const terminalOf = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
  runtime.events.pipe(
    Stream.filter(
      (
        event,
      ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
        event.type === "turn.terminal",
    ),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

const makeHarness = Effect.fn("OpenCode2ProjectInstructions.makeHarness")(function* () {
  const nativeEvents = yield* Queue.unbounded<OpenCode2Client.OpenCode2StreamEvent>();
  const instructionWrites: Array<{ readonly key: string; readonly value: string }> = [];
  const promptTexts: Array<string> = [];
  let eventSequence = 0;
  const executionSucceeded = () => {
    eventSequence += 1;
    return Queue.offer(nativeEvents, {
      id: `evt_project_instructions_${eventSequence}`,
      created: 1,
      type: "session.execution.succeeded",
      data: { sessionID: SESSION_ID },
      durable: { aggregateID: SESSION_ID, seq: eventSequence, version: 1 },
    } as OpenCode2Client.OpenCode2StreamEvent).pipe(Effect.asVoid);
  };
  const model = { id: "big-pickle", providerID: "opencode", variant: "default" };
  const client = {
    model: {
      list: () => Effect.succeed({ location: { directory: WORKSPACE }, data: [] }),
    },
    session: {
      get: () =>
        Effect.succeed({
          id: SESSION_ID,
          title: "Project instructions",
          permissions: [],
          model,
          agent: "build",
          location: { directory: WORKSPACE },
        }),
      update: () => Effect.void,
      instructions: {
        entry: {
          put: (input: { readonly key: string; readonly value: string }) =>
            Effect.sync(() => {
              instructionWrites.push(input);
            }),
        },
      },
      prompt: (input: { readonly text: string }) =>
        Effect.sync(() => {
          promptTexts.push(input.text);
        }).pipe(Effect.andThen(executionSucceeded())),
      compact: () => executionSucceeded(),
      active: () => Effect.succeed({}),
      interrupt: () => Effect.void,
      form: { list: () => Effect.succeed([]) },
    },
    permission: { list: () => Effect.succeed([]) },
  };
  const connection = {
    client: client as unknown as OpenCode2Client.OpenCode2Api["client"],
    events: Effect.succeed(Stream.fromQueue(nativeEvents)),
    imageJobs: () => Effect.succeed([]),
    readImage: () => Effect.die("not used"),
    usageLimits: () => Effect.undefined,
    url: "http://test.invalid",
    version: "2.0.18",
    external: true,
  } satisfies OpenCode2Server.OpenCode2Connection;
  const server = OpenCode2Server.OpenCode2Server.of({
    withConnection: (use) => use(connection),
    forget: Effect.void,
    connections: Stream.empty,
  });
  const adapter = yield* OpenCode2Adapter.make(INSTANCE_ID).pipe(
    Effect.provideService(OpenCode2Server.OpenCode2Server, server),
  );
  const modelSelection = { instanceId: INSTANCE_ID, model: "opencode/big-pickle" };
  const runtimePolicy = {
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    cwd: WORKSPACE,
  };
  const runtime = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: ProviderSessionId.make("session-opencode2-project-instructions"),
    modelSelection,
    runtimePolicy,
  });
  const now = yield* DateTime.now;
  const initialThread: OrchestrationV2ProviderThread = {
    id: ProviderThreadId.make("provider-thread:opencode2-project-instructions"),
    driver: OPENCODE_PROVIDER,
    providerInstanceId: INSTANCE_ID,
    providerSessionId: ProviderSessionId.make("session-opencode2-project-instructions"),
    appThreadId: THREAD_ID,
    ownerNodeId: null,
    nativeThreadRef: { driver: OPENCODE_PROVIDER, nativeId: SESSION_ID, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const providerThread = yield* runtime.resumeThread({
    providerThread: initialThread,
    threadId: THREAD_ID,
    modelSelection,
    runtimePolicy,
  });
  const runTurn = (
    ordinal: number,
    text: string,
    projectInstructions: ProjectInstructions | undefined,
  ) =>
    Effect.gen(function* () {
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn({
        appThread: {
          id: THREAD_ID,
          projectId: ProjectId.make("project-opencode2-project-instructions"),
          title: "Project instructions",
          providerInstanceId: INSTANCE_ID,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
          forkedFrom: null,
          createdBy: "user",
          creationSource: "web",
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId: THREAD_ID,
        runId: RunId.make(`run-opencode2-project-instructions-${ordinal}`),
        runOrdinal: ordinal,
        providerTurnOrdinal: ordinal,
        attemptId: RunAttemptId.make(`attempt-opencode2-project-instructions-${ordinal}`),
        rootNodeId: NodeId.make(`node-opencode2-project-instructions-${ordinal}`),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make(`message-opencode2-project-instructions-${ordinal}`),
          text,
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
        ...(projectInstructions === undefined ? {} : { projectInstructions }),
      });
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    });
  return { instructionWrites, promptTexts, runTurn };
});

describe("OpenCode 2.x project instructions", () => {
  it.effect(
    "writes native session instructions on change and preserves them across compaction",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();

        yield* harness.runTurn(1, "first", FIRST);
        assert.equal(harness.instructionWrites.length, 1);
        assert.isTrue(harness.instructionWrites[0]?.value.endsWith(FIRST.text));
        assert.equal(harness.instructionWrites[0]?.key, "t3-code");

        yield* harness.runTurn(2, "unchanged", FIRST);
        assert.equal(harness.instructionWrites.length, 1);

        yield* harness.runTurn(3, "/compact", FIRST);
        yield* harness.runTurn(4, "after compaction", FIRST);
        assert.equal(harness.instructionWrites.length, 1);

        yield* harness.runTurn(5, "changed", SECOND);
        assert.equal(harness.instructionWrites.length, 2);
        assert.isTrue(harness.instructionWrites[1]?.value.endsWith(SECOND.text));

        yield* harness.runTurn(6, "disabled", undefined);
        assert.equal(harness.instructionWrites.length, 3);
        assert.notInclude(harness.instructionWrites[2]?.value ?? "", "<token_efficiency>");
        assert.deepEqual(harness.promptTexts, [
          "first",
          "unchanged",
          "after compaction",
          "changed",
          "disabled",
        ]);
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
