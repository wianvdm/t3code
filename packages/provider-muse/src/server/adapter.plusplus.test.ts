import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MUSE_DEFAULT_MODEL,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProjectInstructions } from "@t3tools/provider-core/server/projectInstructions";
import { MuseSettings } from "../settings.ts";
import { makeMuseAdapterV2 } from "./adapter.ts";
import type { MuseSdkHost } from "./sdk.ts";

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);
const instanceId = ProviderInstanceId.make("muse");
const threadId = ThreadId.make("thread-muse-project-instructions");
const modelSelection = { instanceId, model: MUSE_DEFAULT_MODEL };
const museSettings = Schema.decodeSync(MuseSettings)({ enabled: true });
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});

const FIRST = { id: "instructions-1", text: "<project_instructions>ONE</project_instructions>" };
const SECOND = { id: "instructions-2", text: "<project_instructions>TWO</project_instructions>" };

interface NativeCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly commandId?: string;
}

function pendingPromise<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeFakeMuse() {
  const calls: NativeCall[] = [];
  const closed = pendingPromise<void>();
  const exited = pendingPromise<Awaited<MuseSdkHost["exited"]>>();
  let notify: Parameters<MuseSdkHost["connection"]["onNotification"]>[0] = () => {};
  let sequence = 0;
  let sessionId = "";
  let shouldRejectTurnStart = false;
  let compactStatus = "accepted";
  const respond = async (call: NativeCall): Promise<Record<string, unknown>> => {
    calls.push(call);
    switch (call.method) {
      case "session/start":
      case "session/resume":
      case "session/read":
        sessionId = String(call.params.sessionId);
        return {
          session: { sessionId, modelId: MUSE_DEFAULT_MODEL, activeTurnId: null },
          history: { items: [] },
        };
      case "turn/start":
        if (shouldRejectTurnStart) {
          shouldRejectTurnStart = false;
          throw new Error("turn rejected");
        }
        return { turnId: call.commandId };
      case "session/compact":
        return { status: compactStatus };
      default:
        return {};
    }
  };
  const host: MuseSdkHost = {
    connection: {
      mintCommandId: () => `native-${++sequence}`,
      command: (method, params, options) =>
        respond({
          method,
          params,
          ...(options?.commandId ? { commandId: options.commandId } : {}),
        }),
      request: (method, params = {}) => respond({ method, params }),
      onNotification: (handler) => {
        notify = handler;
      },
      onProtocolError: () => {},
      onServerRequest: () => {},
      closed: closed.promise,
    },
    initializeResult: { grantedCapabilities: [] },
    exited: exited.promise,
    close: async () => {
      closed.resolve();
      exited.resolve({ code: 0, signal: null });
    },
  };
  return {
    host,
    calls,
    rejectTurnStart: () => {
      shouldRejectTurnStart = true;
    },
    declineCompaction: () => {
      compactStatus = "noop";
    },
    emit: (method: string, params: Record<string, unknown>) =>
      Effect.sync(() => {
        notify({ jsonrpc: "2.0", method, params: { sessionId, ...params } });
      }),
  };
}

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
    runId: RunId.make(`muse-project-run-${runOrdinal}`),
    runOrdinal,
    providerTurnOrdinal: runOrdinal,
    attemptId: RunAttemptId.make(`muse-project-attempt-${runOrdinal}`),
    rootNodeId: NodeId.make(`muse-project-root-${runOrdinal}`),
    appThread: {
      id: threadId,
      projectId: ProjectId.make("muse-project-instructions"),
      createdBy: "user" as const,
      creationSource: "web" as const,
      title: "Muse project instructions",
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
      messageId: MessageId.make(`muse-project-message-${runOrdinal}`),
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

function runtimeText(call: NativeCall): string {
  const parts = call.params.input as ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
  }>;
  assert.strictEqual(parts[0]?.type, "text");
  return parts[0]?.text ?? "";
}

type FakeMuse = ReturnType<typeof makeFakeMuse>;
type MuseAdapter = Effect.Success<ReturnType<typeof makeMuseAdapterV2>>;

function makeAdapterWithHosts(hosts: ReadonlyArray<FakeMuse>) {
  let hostIndex = 0;
  return makeMuseAdapterV2({
    instanceId,
    settings: museSettings,
    environment: { PATH: "/fake/bin" },
    createHost: async () => hosts[hostIndex++]!.host,
  });
}

const openRuntime = Effect.fnUntraced(function* (input: {
  readonly adapter: MuseAdapter;
  readonly providerSessionId: string;
  readonly existingProviderThread?: OrchestrationV2ProviderThread;
}) {
  const runtime = yield* input.adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(input.providerSessionId),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy,
    ...(input.existingProviderThread === undefined
      ? {}
      : { existingProviderThread: input.existingProviderThread }),
  });
  return { runtime, providerThread };
});

const startMuseTurn = Effect.fnUntraced(function* (input: {
  readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly fake: FakeMuse;
  readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
}) {
  yield* input.runtime.startTurn(input.turn);
  const call = input.fake.calls.findLast((call) => call.method === "turn/start");
  assert.isDefined(call);
  return call;
});

const completeMuseTurn = Effect.fnUntraced(function* (input: {
  readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly fake: FakeMuse;
  readonly call: NativeCall;
}) {
  yield* input.fake.emit("turn/completed", {
    turnId: input.call.commandId,
    terminal: "completed",
  });
  const terminal = Option.getOrThrow(
    yield* input.runtime.events.pipe(
      Stream.filter((event) => event.type === "turn.terminal"),
      Stream.runHead,
    ),
  );
  assert.strictEqual(terminal.status, "completed");
});

describe("MuseAdapterV2 project instructions ++", () => {
  it.effect("delivers only on change or compaction without changing user text", () =>
    Effect.gen(function* () {
      const fake = makeFakeMuse();
      const adapter = yield* makeMuseAdapterV2({
        instanceId,
        settings: museSettings,
        environment: { PATH: "/fake/bin" },
        createHost: async () => fake.host,
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("muse-project-instructions-session"),
        modelSelection,
        runtimePolicy,
      });
      const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(emitted, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const takeTerminal = Effect.fnUntraced(function* () {
        while (true) {
          const event = yield* Queue.take(emitted);
          if (event.type === "turn.terminal") return event;
        }
      });
      let runOrdinal = 0;
      const nextInput = Effect.fnUntraced(function* (input: {
        readonly text: string;
        readonly projectInstructions: ProjectInstructions | undefined;
      }) {
        runOrdinal += 1;
        const turn = yield* makeTurnInput({
          providerThread,
          runOrdinal,
          text: input.text,
          projectInstructions: input.projectInstructions,
        });
        return turn;
      });
      const start = Effect.fnUntraced(function* (input: {
        readonly text: string;
        readonly projectInstructions: ProjectInstructions | undefined;
      }) {
        yield* runtime.startTurn(yield* nextInput(input));
        const call = fake.calls.findLast((call) => call.method === "turn/start");
        assert.isDefined(call);
        return call;
      });
      const finish = Effect.fnUntraced(function* (call: NativeCall) {
        yield* fake.emit("turn/completed", { turnId: call.commandId, terminal: "completed" });
        assert.strictEqual((yield* takeTerminal()).status, "completed");
      });
      const send = Effect.fnUntraced(function* (input: {
        readonly text: string;
        readonly projectInstructions: ProjectInstructions | undefined;
      }) {
        const call = yield* start(input);
        yield* finish(call);
        return call;
      });
      const emitCompaction = (call: NativeCall) =>
        fake.emit("item/completed", {
          item: {
            itemId: `compaction-${call.commandId}`,
            kind: "compaction",
            revision: 1,
            status: "completed",
            turnId: call.commandId,
            outcome: "compacted",
          },
        });

      const first = yield* send({ text: "First request", projectInstructions: FIRST });
      assert.isTrue(runtimeText(first).endsWith(FIRST.text), "first leading runtime part delivers");
      assert.strictEqual(first.params.displayText, "First request");

      const unchanged = yield* send({ text: "Second request", projectInstructions: FIRST });
      assert.notInclude(
        runtimeText(unchanged),
        "<project_instructions>",
        "second turn omits block",
      );
      assert.strictEqual(unchanged.params.displayText, "Second request");

      const changed = yield* send({ text: "Changed request", projectInstructions: SECOND });
      assert.isTrue(runtimeText(changed).endsWith(SECOND.text), "changed id resends the block");

      const disabled = yield* send({ text: "Disabled request", projectInstructions: undefined });
      assert.notInclude(runtimeText(disabled), "<project_instructions>", "disablement omits block");

      const reenabled = yield* send({ text: "Reenabled request", projectInstructions: SECOND });
      assert.isTrue(runtimeText(reenabled).endsWith(SECOND.text), "withdrawal resets delivery");

      const beforeAutoCompaction = yield* start({
        text: "Before auto compaction",
        projectInstructions: SECOND,
      });
      yield* emitCompaction(beforeAutoCompaction);
      yield* finish(beforeAutoCompaction);
      const afterAutoCompaction = yield* send({
        text: "After auto compaction",
        projectInstructions: SECOND,
      });
      assert.isTrue(
        runtimeText(afterAutoCompaction).endsWith(SECOND.text),
        "an observed compaction item reinjects the block",
      );

      yield* runtime.compactThread!(
        yield* nextInput({ text: "Compact request", projectInstructions: SECOND }),
      );
      const compact = fake.calls.findLast((call) => call.method === "session/compact");
      assert.isDefined(compact);
      yield* emitCompaction(compact);
      assert.strictEqual((yield* takeTerminal()).status, "completed");
      const afterManualCompaction = yield* send({
        text: "After manual compaction",
        projectInstructions: SECOND,
      });
      assert.isTrue(
        runtimeText(afterManualCompaction).endsWith(SECOND.text),
        "session/compact reinjects the block",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("does not resend unchanged instructions when a native session resumes", () =>
    Effect.gen(function* () {
      const firstFake = makeFakeMuse();
      const resumedFake = makeFakeMuse();
      const adapter = yield* makeAdapterWithHosts([firstFake, resumedFake]);
      const providerThread = yield* Effect.scoped(
        Effect.gen(function* () {
          const { runtime, providerThread } = yield* openRuntime({
            adapter,
            providerSessionId: "muse-project-instructions-original",
          });
          const call = yield* startMuseTurn({
            runtime,
            fake: firstFake,
            turn: yield* makeTurnInput({
              providerThread,
              runOrdinal: 1,
              text: "Before resume",
              projectInstructions: FIRST,
            }),
          });
          assert.isTrue(runtimeText(call).endsWith(FIRST.text));
          yield* completeMuseTurn({ runtime, fake: firstFake, call });
          return providerThread;
        }),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { runtime, providerThread: resumedThread } = yield* openRuntime({
            adapter,
            providerSessionId: "muse-project-instructions-resumed",
            existingProviderThread: providerThread,
          });
          assert.isTrue(resumedFake.calls.some((call) => call.method === "session/resume"));
          const call = yield* startMuseTurn({
            runtime,
            fake: resumedFake,
            turn: yield* makeTurnInput({
              providerThread: resumedThread,
              runOrdinal: 2,
              text: "After resume",
              projectInstructions: FIRST,
            }),
          });
          assert.notInclude(runtimeText(call), FIRST.text);
          assert.strictEqual(call.params.displayText, "After resume");
          yield* completeMuseTurn({ runtime, fake: resumedFake, call });
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("reinjects after accepted session compaction without a compaction item", () =>
    Effect.gen(function* () {
      const compactedFake = makeFakeMuse();
      const resumedFake = makeFakeMuse();
      const adapter = yield* makeAdapterWithHosts([compactedFake, resumedFake]);
      const providerThread = yield* Effect.scoped(
        Effect.gen(function* () {
          const { runtime, providerThread } = yield* openRuntime({
            adapter,
            providerSessionId: "muse-project-instructions-before-compact",
          });
          const first = yield* startMuseTurn({
            runtime,
            fake: compactedFake,
            turn: yield* makeTurnInput({
              providerThread,
              runOrdinal: 1,
              text: "Before compact",
              projectInstructions: FIRST,
            }),
          });
          yield* completeMuseTurn({ runtime, fake: compactedFake, call: first });
          yield* runtime.compactThread!(
            yield* makeTurnInput({
              providerThread,
              runOrdinal: 2,
              text: "Compact request",
              projectInstructions: FIRST,
            }),
          );
          const compact = compactedFake.calls.findLast((call) => call.method === "session/compact");
          assert.isDefined(compact);
          return providerThread;
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { runtime, providerThread: resumedThread } = yield* openRuntime({
            adapter,
            providerSessionId: "muse-project-instructions-after-compact",
            existingProviderThread: providerThread,
          });
          const call = yield* startMuseTurn({
            runtime,
            fake: resumedFake,
            turn: yield* makeTurnInput({
              providerThread: resumedThread,
              runOrdinal: 3,
              text: "After compact",
              projectInstructions: FIRST,
            }),
          });
          assert.isTrue(runtimeText(call).endsWith(FIRST.text));
          yield* completeMuseTurn({ runtime, fake: resumedFake, call });
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("does not resend after a declined session compaction", () =>
    Effect.gen(function* () {
      const fake = makeFakeMuse();
      const adapter = yield* makeAdapterWithHosts([fake]);
      const { runtime, providerThread } = yield* openRuntime({
        adapter,
        providerSessionId: "muse-project-instructions-declined-compact",
      });
      const first = yield* startMuseTurn({
        runtime,
        fake,
        turn: yield* makeTurnInput({
          providerThread,
          runOrdinal: 1,
          text: "Before declined compact",
          projectInstructions: FIRST,
        }),
      });
      yield* completeMuseTurn({ runtime, fake, call: first });

      fake.declineCompaction();
      yield* runtime.compactThread!(
        yield* makeTurnInput({
          providerThread,
          runOrdinal: 2,
          text: "Declined compact",
          projectInstructions: FIRST,
        }),
      );
      const declined = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        ),
      );
      assert.strictEqual(declined.status, "failed");

      const after = yield* startMuseTurn({
        runtime,
        fake,
        turn: yield* makeTurnInput({
          providerThread,
          runOrdinal: 3,
          text: "After declined compact",
          projectInstructions: FIRST,
        }),
      });
      assert.notInclude(runtimeText(after), FIRST.text);
      yield* completeMuseTurn({ runtime, fake, call: after });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("commits delivery only after Muse accepts turn/start", () =>
    Effect.gen(function* () {
      const fake = makeFakeMuse();
      const adapter = yield* makeAdapterWithHosts([fake]);
      const { runtime, providerThread } = yield* openRuntime({
        adapter,
        providerSessionId: "muse-project-instructions-rejected",
      });
      fake.rejectTurnStart();
      const rejectedStart = yield* runtime
        .startTurn(
          yield* makeTurnInput({
            providerThread,
            runOrdinal: 1,
            text: "Rejected request",
            projectInstructions: FIRST,
          }),
        )
        .pipe(Effect.exit);
      assert.strictEqual(rejectedStart._tag, "Failure");
      const rejected = fake.calls.findLast((call) => call.method === "turn/start");
      assert.isDefined(rejected);
      const failed = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        ),
      );
      assert.strictEqual(failed.status, "failed");
      assert.isTrue(runtimeText(rejected).endsWith(FIRST.text));

      const accepted = yield* startMuseTurn({
        runtime,
        fake,
        turn: yield* makeTurnInput({
          providerThread,
          runOrdinal: 2,
          text: "Accepted request",
          projectInstructions: FIRST,
        }),
      });
      assert.isTrue(runtimeText(accepted).endsWith(FIRST.text));
      assert.strictEqual(accepted.params.displayText, "Accepted request");
      yield* completeMuseTurn({ runtime, fake, call: accepted });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
