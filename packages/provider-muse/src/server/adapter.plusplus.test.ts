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
        return { turnId: call.commandId };
      case "session/compact":
        return { status: "accepted" };
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
    projectInstructions: input.projectInstructions,
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
      const inputs: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
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
        inputs.push(turn);
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

      assert.deepStrictEqual(
        inputs.map((input) => input.message.text),
        [
          "First request",
          "Second request",
          "Changed request",
          "Disabled request",
          "Reenabled request",
          "Before auto compaction",
          "After auto compaction",
          "Compact request",
          "After manual compaction",
        ],
        "persisted user text remains unchanged",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
