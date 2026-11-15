import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
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

// Trimmed copy of the adapter.test.ts fake: answers only what opening a session asks.
const makeFakePi: Effect.Effect<ChildProcessSpawner.ChildProcessSpawner["Service"]> = Effect.gen(
  function* () {
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    let stdinBuffer = "";

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
          const response = respondTo(decodeJsonLine(line) as PiRpcRecord);
          if (response !== null) {
            yield* Queue.offer(stdout, new TextEncoder().encode(`${encodeJsonLine(response)}\n`));
          }
        }
      });

    return ChildProcessSpawner.make(() =>
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
    );
  },
);

const makeAdapter = Effect.fnUntraced(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  return yield* makePiAdapterV2({
    instanceId: PI_INSTANCE_ID,
    settings: { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
    environment: {},
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
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
});
