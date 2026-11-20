import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  DEFAULT_SERVER_SETTINGS,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import { PI_T3_PROJECT_INSTRUCTIONS_COMMAND } from "@t3tools/plusplus/projectInstructions";
import type { ProjectInstructions } from "@t3tools/plusplus/projectInstructions";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makePiAdapterV2 } from "./adapter.ts";
import { type PiRpcRecord } from "./rpc.ts";
import { piT3ContextBridgeReportPath } from "./mcpInjection.ts";
import { PI_T3_MCP_EXTENSION_FILENAME } from "./mcpExtensionSource.ts";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const decodeJsonLine = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const PI_INSTANCE_ID = ProviderInstanceId.make("pi");
const THREAD_ID = ThreadId.make("thread-pi-test");
const SESSION_ID = ProviderSessionId.make("provider-session-pi-test");
const FAKE_SESSION_FILE = "/fake/.pi/agent/sessions/--workspace--/0001_abc.jsonl";
/** Deliberately outside the valid pid range so a group-kill can never land. */
const FAKE_PID = 999_999_999;

const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});

const modelSelection = (model: string): ModelSelection => ({
  instanceId: PI_INSTANCE_ID,
  model,
});

type CommandDisposition = "handled" | "queued" | "omit";

interface FakePi {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly emit: (record: PiRpcRecord) => Effect.Effect<void>;
  readonly takeUserPrompt: (text: string) => Effect.Effect<PiRpcRecord>;
  readonly allRequests: () => ReadonlyArray<PiRpcRecord>;
  readonly setProjectInstructionsDisposition: (disposition: CommandDisposition) => void;
}

const makeFakePi: Effect.Effect<FakePi> = Effect.gen(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const requests = yield* Queue.unbounded<PiRpcRecord>();
  const allRequests: PiRpcRecord[] = [];
  let stdinBuffer = "";
  let projectInstructionsDisposition: CommandDisposition = "handled";
  const projectInstructionsCommand = `/${PI_T3_PROJECT_INSTRUCTIONS_COMMAND}`;

  const emit = (record: PiRpcRecord) =>
    Queue.offer(stdout, new TextEncoder().encode(`${encodeJsonLine(record)}\n`)).pipe(
      Effect.asVoid,
    );

  const respondTo = (record: PiRpcRecord): PiRpcRecord | null => {
    if (typeof record["id"] !== "string") return null;
    const base = {
      type: "response",
      id: record["id"],
      command: String(record["type"]),
      success: true,
    };
    switch (record["type"]) {
      case "get_state":
        return {
          ...base,
          data: {
            thinkingLevel: "high",
            isStreaming: false,
            isCompacting: false,
            steeringMode: "one-at-a-time",
            followUpMode: "one-at-a-time",
            sessionFile: FAKE_SESSION_FILE,
            sessionId: "00000000-0000-4000-8000-000000000002",
            autoCompactionEnabled: true,
            messageCount: 0,
            pendingMessageCount: 0,
          },
        };
      case "get_available_models":
        return { ...base, data: { models: [] } };
      case "get_entries":
        return { ...base, data: { entries: [], leafId: null } };
      case "get_messages":
        return { ...base, data: { messages: [] } };
      case "get_session_stats":
        return { ...base, data: {} };
      case "new_session":
      case "switch_session":
        return { ...base, data: { cancelled: false } };
      case "prompt":
        if (String(record["message"]).startsWith(projectInstructionsCommand)) {
          return {
            ...base,
            data:
              projectInstructionsDisposition === "omit"
                ? {}
                : { disposition: projectInstructionsDisposition },
          };
        }
        return base;
      default:
        return base;
    }
  };

  const handleStdinChunk = (chunk: Uint8Array) =>
    Effect.gen(function* () {
      stdinBuffer += new TextDecoder().decode(chunk);
      while (true) {
        const newline = stdinBuffer.indexOf("\n");
        if (newline === -1) return;
        const line = stdinBuffer.slice(0, newline);
        stdinBuffer = stdinBuffer.slice(newline + 1);
        if (line.length === 0) continue;
        const record = decodeJsonLine(line) as PiRpcRecord;
        allRequests.push(record);
        yield* Queue.offer(requests, record);
        const response = respondTo(record);
        if (response !== null) yield* emit(response);
      }
    });

  return {
    spawner: ChildProcessSpawner.make(() =>
      Effect.sync(() =>
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(FAKE_PID),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach(handleStdinChunk),
          stdout: Stream.fromQueue(stdout),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    ),
    emit,
    takeUserPrompt: (text) =>
      Effect.gen(function* () {
        while (true) {
          const record = yield* Queue.take(requests);
          if (record["type"] === "prompt" && record["message"] === text) return record;
        }
      }),
    allRequests: () => allRequests,
    setProjectInstructionsDisposition: (disposition) => {
      projectInstructionsDisposition = disposition;
    },
  };
});

const makeAdapter = Effect.fnUntraced(function* (fake: FakePi) {
  return yield* makePiAdapterV2({
    instanceId: PI_INSTANCE_ID,
    settings: { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
    environment: {},
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
});

const openRuntime = Effect.fnUntraced(function* (
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
) {
  const runtime = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: SESSION_ID,
    modelSelection: modelSelection("default"),
    runtimePolicy,
  });
  const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(emitted, event)),
    Effect.forkScoped,
  );
  const takeEvent = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(emitted);
        if (predicate(event)) return event;
      }
    });
  return { runtime, takeEvent };
});

const makeAppThread = Effect.fnUntraced(function* () {
  const now = yield* DateTime.now;
  return {
    createdBy: "user",
    creationSource: "web",
    id: THREAD_ID,
    projectId: "project:fixture:pi" as OrchestrationV2AppThread["projectId"],
    title: "Pi test thread",
    providerInstanceId: PI_INSTANCE_ID,
    modelSelection: modelSelection("default"),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } satisfies OrchestrationV2AppThread;
});

const startTurn = Effect.fnUntraced(function* (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  runOrdinal: number,
  projectInstructions?: ProjectInstructions,
  messageKind: "user" | "continuation" = "user",
) {
  const appThread = yield* makeAppThread();
  const runId = RunId.make(`run:${THREAD_ID}:${runOrdinal}`);
  yield* runtime.startTurn({
    appThread,
    threadId: THREAD_ID,
    runId,
    runOrdinal,
    providerTurnOrdinal: runOrdinal,
    attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
    rootNodeId: NodeId.make(`node:${runId}:root`),
    providerThread,
    message: {
      messageId: `message:${THREAD_ID}:${runOrdinal}` as never,
      text: `Turn ${runOrdinal}`,
      attachments: [],
      createdBy: messageKind === "continuation" ? "agent" : "user",
      creationSource: messageKind === "continuation" ? "provider" : "web",
    },
    modelSelection: modelSelection("default"),
    runtimePolicy,
    ...(projectInstructions === undefined ? {} : { projectInstructions }),
  });
});

const runTurn = Effect.fnUntraced(function* (
  fake: FakePi,
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  takeEvent: (
    predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean,
  ) => Effect.Effect<ProviderAdapter.ProviderAdapterV2Event>,
  providerThread: OrchestrationV2ProviderThread,
  runOrdinal: number,
  projectInstructions?: ProjectInstructions,
) {
  yield* startTurn(runtime, providerThread, runOrdinal, projectInstructions);
  yield* fake.takeUserPrompt(`Turn ${runOrdinal}`);
  yield* fake.emit({ type: "agent_settled" });
  const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
  assert.equal(terminal.type, "turn.terminal");
  if (terminal.type === "turn.terminal") assert.equal(terminal.status, "completed");
});

const projectInstructionArguments = (fake: FakePi) => {
  const prefix = `/${PI_T3_PROJECT_INSTRUCTIONS_COMMAND}`;
  return fake.allRequests().flatMap((request) => {
    if (request["type"] !== "prompt") return [];
    const message = String(request["message"]);
    return message === prefix || message.startsWith(`${prefix} `)
      ? [message.slice(prefix.length).trim()]
      : [];
  });
};

const ensureThread = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
  runtime.ensureThread({
    threadId: THREAD_ID,
    modelSelection: modelSelection("default"),
    runtimePolicy,
  });

describe("PiAdapterV2 ++", () => {
  it.effect("removes the session-scoped bridge files when the session closes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const hostSettings = yield* TestProviderHost.TestProviderHostSettings;
      yield* hostSettings.set({
        ...DEFAULT_SERVER_SETTINGS,
        contextBridge: {
          enabled: true,
          defaultSource: "claudeAgent",
          routes: { pi: { instructions: "claudeAgent" } },
        },
      });
      const host = yield* ProviderHost.ProviderHost;
      const cacheDir = host.paths.providerStatusCacheDir.replace(/\\/g, "/");
      const providerSessionId = ProviderSessionId.make("provider-session-pi-bridge-cleanup");
      const fake = yield* makeFakePi;
      const adapter = yield* makeAdapter(fake);

      const sessionScope = yield* Scope.make();
      yield* adapter
        .openSession({
          threadId: THREAD_ID,
          providerSessionId,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        })
        .pipe(Effect.provideService(Scope.Scope, sessionScope));

      const sessionExtensionPath = `${cacheDir}/pi-t3-mcp-extension.${providerSessionId}.ts`;
      const sharedExtensionPath = `${cacheDir}/${PI_T3_MCP_EXTENSION_FILENAME}`;
      const reportPath = piT3ContextBridgeReportPath(cacheDir, providerSessionId);
      assert.isTrue(yield* fs.exists(sessionExtensionPath));
      // The generated extension inside pi writes the report; stand in for it.
      yield* fs.makeDirectory(`${cacheDir}/context-bridge`);
      yield* fs.writeFileString(reportPath, "{}");
      yield* fs.writeFileString(sharedExtensionPath, "// shared extension");

      yield* Scope.close(sessionScope, Exit.void);

      assert.isFalse(yield* fs.exists(sessionExtensionPath));
      assert.isFalse(yield* fs.exists(reportPath));
      assert.isTrue(yield* fs.exists(sharedExtensionPath));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "delivers only changes, withdraws once, and keeps delivery across a resume of the attached session",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const adapter = yield* makeAdapter(fake);
        const { runtime, takeEvent } = yield* openRuntime(adapter);
        let providerThread = yield* ensureThread(runtime);
        const first = { id: "first", text: "First π instructions\nSecond line" };
        const updated = { id: "updated", text: "Updated instructions" };

        yield* runTurn(fake, runtime, takeEvent, providerThread, 1, first);
        yield* runTurn(fake, runtime, takeEvent, providerThread, 2, first);
        assert.deepEqual(projectInstructionArguments(fake), [
          Buffer.from(first.text, "utf8").toString("base64url"),
        ]);

        // Resuming the attached session file keeps Pi's session and its extension state.
        providerThread = yield* runtime.resumeThread({ providerThread });
        yield* runTurn(fake, runtime, takeEvent, providerThread, 3, first);
        assert.equal(projectInstructionArguments(fake).length, 1);

        yield* runTurn(fake, runtime, takeEvent, providerThread, 4, updated);
        yield* runTurn(fake, runtime, takeEvent, providerThread, 5);
        yield* runTurn(fake, runtime, takeEvent, providerThread, 6);
        assert.deepEqual(projectInstructionArguments(fake), [
          Buffer.from(first.text, "utf8").toString("base64url"),
          Buffer.from(updated.text, "utf8").toString("base64url"),
          "",
        ]);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("forgets delivered instructions when the Pi process restarts", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const adapter = yield* makeAdapter(fake);
      const instructions = { id: "restart", text: "Restart instructions" };
      const firstScope = yield* Scope.make();
      const first = yield* openRuntime(adapter).pipe(
        Effect.provideService(Scope.Scope, firstScope),
      );
      const firstThread = yield* ensureThread(first.runtime);
      yield* runTurn(fake, first.runtime, first.takeEvent, firstThread, 1, instructions);
      yield* Scope.close(firstScope, Exit.void);

      const secondScope = yield* Scope.make();
      const second = yield* openRuntime(adapter).pipe(
        Effect.provideService(Scope.Scope, secondScope),
      );
      const secondThread = yield* ensureThread(second.runtime);
      yield* runTurn(fake, second.runtime, second.takeEvent, secondThread, 2, instructions);
      yield* Scope.close(secondScope, Exit.void);

      assert.deepEqual(projectInstructionArguments(fake), [
        Buffer.from(instructions.text, "utf8").toString("base64url"),
        Buffer.from(instructions.text, "utf8").toString("base64url"),
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("forgets delivered instructions when Pi forks for rollback", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const adapter = yield* makeAdapter(fake);
      const { runtime, takeEvent } = yield* openRuntime(adapter);
      const providerThread = yield* ensureThread(runtime);
      const instructions = { id: "rollback", text: "Rollback instructions" };
      yield* runTurn(fake, runtime, takeEvent, providerThread, 1, instructions);

      const discardedTurn = {
        id: ProviderTurnId.make("rollback-turn"),
        providerThreadId: providerThread.id,
        nodeId: NodeId.make("rollback-node"),
        runAttemptId: null,
        nativeTurnRef: {
          driver: providerThread.driver,
          nativeId: "rollback-entry",
          strength: "strong",
        },
        ordinal: 1,
        status: "completed",
        startedAt: null,
        completedAt: null,
      } satisfies OrchestrationV2ProviderTurn;
      yield* runtime.rollbackThread({
        providerThread,
        target: {
          type: "thread_start",
          checkpointId: CheckpointId.make("rollback-checkpoint"),
          appRunOrdinal: 0,
        },
        providerThreadTurns: [discardedTurn],
      });
      yield* runTurn(fake, runtime, takeEvent, providerThread, 2, instructions);

      assert.deepEqual(projectInstructionArguments(fake), [
        Buffer.from(instructions.text, "utf8").toString("base64url"),
        Buffer.from(instructions.text, "utf8").toString("base64url"),
      ]);
      assert.equal(fake.allRequests().filter((request) => request["type"] === "fork").length, 1);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("fails a non-handled command without committing it or sending the user prompt", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.setProjectInstructionsDisposition("queued");
      const adapter = yield* makeAdapter(fake);
      const { runtime, takeEvent } = yield* openRuntime(adapter);
      const providerThread = yield* ensureThread(runtime);
      const instructions = { id: "disposition", text: "Disposition instructions" };

      const exit = yield* startTurn(runtime, providerThread, 1, instructions).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      if (!Exit.isFailure(exit)) return;
      const failure = Cause.pretty(exit.cause);
      assert.include(failure, "ProviderAdapterTurnStartError");
      assert.include(failure, "ProviderAdapterProtocolError");
      assert.include(failure, "did not apply the project instructions");
      assert.isFalse(fake.allRequests().some((request) => request["message"] === "Turn 1"));

      fake.setProjectInstructionsDisposition("handled");
      yield* runTurn(fake, runtime, takeEvent, providerThread, 2, instructions);
      assert.equal(projectInstructionArguments(fake).length, 2);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("aborts a non-handled project-instructions command before failing", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.setProjectInstructionsDisposition("queued");
      const adapter = yield* makeAdapter(fake);
      const { runtime } = yield* openRuntime(adapter);
      const providerThread = yield* ensureThread(runtime);

      const exit = yield* startTurn(runtime, providerThread, 1, {
        id: "abort",
        text: "Abort instructions",
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      const requests = fake.allRequests();
      const commandIndex = requests.findIndex((request) =>
        String(request["message"]).startsWith(`/${PI_T3_PROJECT_INSTRUCTIONS_COMMAND}`),
      );
      const abortIndex = requests.findIndex((request) => request["type"] === "abort");
      assert.isAbove(commandIndex, -1);
      assert.isAbove(abortIndex, commandIndex);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("commits a legacy acknowledgement so withdrawal reaches older Pi", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.setProjectInstructionsDisposition("omit");
      const adapter = yield* makeAdapter(fake);
      const { runtime, takeEvent } = yield* openRuntime(adapter);
      const providerThread = yield* ensureThread(runtime);
      const instructions = { id: "legacy", text: "Legacy acknowledgement" };

      yield* runTurn(fake, runtime, takeEvent, providerThread, 1, instructions);
      yield* runTurn(fake, runtime, takeEvent, providerThread, 2);

      assert.deepEqual(projectInstructionArguments(fake), [
        Buffer.from(instructions.text, "utf8").toString("base64url"),
        "",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("does not plan project instructions for provider continuation turns", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const adapter = yield* makeAdapter(fake);
      const { runtime, takeEvent } = yield* openRuntime(adapter);
      const providerThread = yield* ensureThread(runtime);
      const instructions = { id: "initial", text: "Initial instructions" };
      yield* runTurn(fake, runtime, takeEvent, providerThread, 1, instructions);

      yield* startTurn(
        runtime,
        providerThread,
        2,
        { id: "continuation", text: "Continuation instructions" },
        "continuation",
      );
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");

      assert.equal(terminal.type, "turn.terminal");
      if (terminal.type === "turn.terminal") assert.equal(terminal.status, "completed");
      assert.deepEqual(projectInstructionArguments(fake), [
        Buffer.from(instructions.text, "utf8").toString("base64url"),
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
