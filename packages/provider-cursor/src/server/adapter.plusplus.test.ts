import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProjectInstructions } from "@t3tools/provider-core/server/projectInstructions";
import { makeCursorAdapterV2 } from "./adapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);
const instanceId = ProviderInstanceId.make("cursor");
const threadId = ThreadId.make("thread-cursor-project-instructions");
const modelSelection = { instanceId, model: "composer-2.5" };
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});

const FIRST = { id: "instructions-1", text: "<project_instructions>ONE</project_instructions>" };
const SECOND = { id: "instructions-2", text: "<project_instructions>TWO</project_instructions>" };

const makeTurnInput = Effect.fnUntraced(function* (input: {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly runOrdinal: number;
  readonly text: string;
  readonly projectInstructions: ProjectInstructions | undefined;
}) {
  const now = yield* DateTime.now;
  const { providerThread, runOrdinal } = input;
  return {
    threadId,
    providerThread,
    modelSelection,
    runtimePolicy,
    runId: RunId.make(`cursor-project-run-${runOrdinal}`),
    runOrdinal,
    providerTurnOrdinal: runOrdinal,
    attemptId: RunAttemptId.make(`cursor-project-attempt-${runOrdinal}`),
    rootNodeId: NodeId.make(`cursor-project-root-${runOrdinal}`),
    appThread: {
      id: threadId,
      projectId: ProjectId.make("cursor-project-instructions"),
      createdBy: "user" as const,
      creationSource: "web" as const,
      title: "Cursor project instructions",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    message: {
      messageId: MessageId.make(`cursor-project-message-${runOrdinal}`),
      createdBy: "user" as const,
      creationSource: "web" as const,
      text: input.text,
      attachments: [],
    },
    ...(input.projectInstructions === undefined
      ? {}
      : { projectInstructions: input.projectInstructions }),
  };
});

describe("CursorAdapterV2 project instructions ++", () => {
  it.effect("delivers only on change or compaction without changing user text", () =>
    Effect.gen(function* () {
      const sent: string[] = [];
      const adapter = yield* makeCursorAdapterV2({ instanceId, environment: {} }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: () =>
            Effect.succeed({
              agentId: "native-cursor-project-instructions",
              listMessages: Effect.succeed([]),
              close: Effect.void,
              send: (input) =>
                Effect.sync(() => {
                  sent.push(typeof input.message === "string" ? input.message : input.message.text);
                  const runId = `native-cursor-project-run-${sent.length}`;
                  return {
                    agentId: "native-cursor-project-instructions",
                    runId,
                    wait: Effect.succeed({
                      id: runId,
                      requestId: `native-cursor-project-request-${sent.length}`,
                      status: "finished" as const,
                      model: { id: "composer-2.5" },
                      durationMs: 1,
                    }),
                    cancel: Effect.void,
                  };
                }),
            }),
        }),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-project-instructions-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      let runOrdinal = 0;
      const send = Effect.fnUntraced(function* (input: {
        readonly text: string;
        readonly projectInstructions: ProjectInstructions | undefined;
        readonly mode: "turn" | "compact";
      }) {
        runOrdinal += 1;
        const turn = yield* makeTurnInput({
          providerThread,
          runOrdinal,
          text: input.text,
          projectInstructions: input.projectInstructions,
        });
        if (input.mode === "compact") yield* runtime.compactThread!(turn);
        else yield* runtime.startTurn(turn);
        yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        );
        return sent.at(-1)!;
      });

      const first = yield* send({
        text: "/status",
        projectInstructions: FIRST,
        mode: "turn",
      });
      assert.isTrue(first.startsWith("/status\n\n<runtime_info>"), "leading slash stays leading");
      assert.isTrue(first.endsWith(FIRST.text), "first turn delivers the block after user text");

      const unchanged = yield* send({
        text: "Second request",
        projectInstructions: FIRST,
        mode: "turn",
      });
      assert.notInclude(unchanged, "<project_instructions>", "unchanged second turn omits block");

      const changed = yield* send({
        text: "Changed request",
        projectInstructions: SECOND,
        mode: "turn",
      });
      assert.isTrue(changed.endsWith(SECOND.text), "changed id resends the block");

      const disabled = yield* send({
        text: "Disabled request",
        projectInstructions: undefined,
        mode: "turn",
      });
      assert.notInclude(disabled, "<project_instructions>", "disablement withdraws the block");

      const reenabled = yield* send({
        text: "Reenabled request",
        projectInstructions: SECOND,
        mode: "turn",
      });
      assert.isTrue(reenabled.endsWith(SECOND.text), "the same id delivers again after withdrawal");

      const compact = yield* send({
        text: "Compact request",
        projectInstructions: SECOND,
        mode: "compact",
      });
      assert.strictEqual(compact, "/compress");
      const afterCompact = yield* send({
        text: "After compact",
        projectInstructions: SECOND,
        mode: "turn",
      });
      assert.isTrue(afterCompact.endsWith(SECOND.text), "compression reinjects the block");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("replays delivery after interruption without copying it on later steers", () =>
    Effect.gen(function* () {
      const sent: string[] = [];
      const runEnds: Array<Deferred.Deferred<"finished" | "cancelled">> = [];
      const adapter = yield* makeCursorAdapterV2({ instanceId, environment: {} }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: () =>
            Effect.succeed({
              agentId: "native-cursor-project-instructions",
              listMessages: Effect.succeed([]),
              close: Effect.void,
              send: (input) =>
                Effect.gen(function* () {
                  sent.push(typeof input.message === "string" ? input.message : input.message.text);
                  const runId = `native-cursor-project-run-${sent.length}`;
                  const ended = yield* Deferred.make<"finished" | "cancelled">();
                  runEnds.push(ended);
                  return {
                    agentId: "native-cursor-project-instructions",
                    runId,
                    wait: Deferred.await(ended).pipe(
                      Effect.map((status) => ({
                        id: runId,
                        requestId: `native-cursor-project-request-${runId}`,
                        status,
                        model: { id: "composer-2.5" },
                        durationMs: 1,
                      })),
                    ),
                    cancel: Deferred.succeed(ended, "cancelled"),
                  };
                }),
            }),
        }),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-project-instructions-interrupt"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(emitted, event)),
        Effect.forkScoped,
      );
      const start = Effect.fnUntraced(function* (runOrdinal: number, text: string) {
        yield* runtime.startTurn(
          yield* makeTurnInput({
            providerThread,
            runOrdinal,
            text,
            projectInstructions: FIRST,
          }),
        );
        while (true) {
          const event = yield* Queue.take(emitted);
          if (event.type === "provider_turn.updated" && event.providerTurn.status === "running") {
            return event.providerTurn;
          }
        }
      });
      const takeTerminal = Effect.fnUntraced(function* (providerTurnId: string) {
        while (true) {
          const event = yield* Queue.take(emitted);
          if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
            return event;
          }
        }
      });
      const interrupt = Effect.fnUntraced(function* (providerTurn: OrchestrationV2ProviderTurn) {
        yield* runtime.interruptTurn({ providerThread, providerTurnId: providerTurn.id });
        assert.strictEqual((yield* takeTerminal(providerTurn.id)).status, "interrupted");
      });

      const first = yield* start(1, "First interrupted request");
      yield* interrupt(first);
      const replayed = yield* start(2, "Replacement request");
      assert.include(sent[1], "First interrupted request");
      assert.include(sent[1], "Replacement request");
      assert.strictEqual(sent[1]!.split(FIRST.text).length - 1, 1);
      yield* Deferred.succeed(runEnds[1]!, "finished");
      assert.strictEqual((yield* takeTerminal(replayed.id)).status, "completed");

      const unchanged = yield* start(3, "Unchanged interrupted request");
      assert.notInclude(sent[2], FIRST.text);
      yield* interrupt(unchanged);
      const afterUnchangedSteer = yield* start(4, "After unchanged interruption");
      assert.include(sent[3], "Unchanged interrupted request");
      assert.include(sent[3], "After unchanged interruption");
      assert.notInclude(sent[3], FIRST.text);
      yield* Deferred.succeed(runEnds[3]!, "finished");
      assert.strictEqual((yield* takeTerminal(afterUnchangedSteer.id)).status, "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("commits delivery only after Cursor accepts the send", () =>
    Effect.gen(function* () {
      const sent: string[] = [];
      let rejectSend = true;
      const adapter = yield* makeCursorAdapterV2({ instanceId, environment: {} }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: () =>
            Effect.succeed({
              agentId: "native-cursor-project-instructions",
              listMessages: Effect.succeed([]),
              close: Effect.void,
              send: (input) =>
                Effect.gen(function* () {
                  sent.push(typeof input.message === "string" ? input.message : input.message.text);
                  if (rejectSend) {
                    rejectSend = false;
                    return yield* new CursorAgentSdk.CursorAgentSdkRunnerError({
                      method: "send",
                      cause: new Error("send rejected"),
                    });
                  }
                  const runId = "native-cursor-project-accepted";
                  return {
                    agentId: "native-cursor-project-instructions",
                    runId,
                    wait: Effect.succeed({
                      id: runId,
                      requestId: "native-cursor-project-request-accepted",
                      status: "finished" as const,
                      model: { id: "composer-2.5" },
                      durationMs: 1,
                    }),
                    cancel: Effect.void,
                  };
                }),
            }),
        }),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-project-instructions-rejected"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const rejected = yield* runtime
        .startTurn(
          yield* makeTurnInput({
            providerThread,
            runOrdinal: 1,
            text: "Rejected request",
            projectInstructions: FIRST,
          }),
        )
        .pipe(Effect.exit);
      assert.strictEqual(rejected._tag, "Failure");

      yield* runtime.startTurn(
        yield* makeTurnInput({
          providerThread,
          runOrdinal: 2,
          text: "Accepted request",
          projectInstructions: FIRST,
        }),
      );
      yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.lengthOf(sent, 2);
      assert.include(sent[0], FIRST.text);
      assert.strictEqual(sent[1]!.split(FIRST.text).length - 1, 1);
      assert.include(sent[1], "Accepted request");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
