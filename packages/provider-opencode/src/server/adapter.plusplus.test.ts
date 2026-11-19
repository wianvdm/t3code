import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProjectInstructions } from "@t3tools/plusplus/projectInstructions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { OpenCodeSettings } from "../settings.ts";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { makeOpenCodeAdapterV2 } from "./adapter.ts";

const PROJECT_INSTRUCTIONS: ProjectInstructions = {
  id: "project-instructions-1",
  text: "<token_efficiency>Prefer concise changes.</token_efficiency>",
};
const CHANGED_PROJECT_INSTRUCTIONS: ProjectInstructions = {
  id: "project-instructions-2",
  text: "<token_efficiency>Prefer focused changes.</token_efficiency>",
};

const OPEN_CODE_TEST_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  serverUrl: "http://test.invalid",
});

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer({ cwd: "/workspace" }).pipe(Layer.provide(NodeServices.layer)),
);

function nativeEventStream() {
  let closed = false;
  const values: unknown[] = [];
  const waiters = new Set<(result: IteratorResult<unknown>) => void>();
  return {
    close() {
      closed = true;
      for (const resolve of waiters) resolve({ done: true, value: undefined });
      waiters.clear();
    },
    push(value: unknown) {
      const waiter = waiters.values().next().value;
      if (waiter === undefined) {
        values.push(value);
        return;
      }
      waiters.delete(waiter);
      waiter({ done: false, value });
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            if (closed) return Promise.resolve({ done: true as const, value: undefined });
            const value = values.shift();
            if (value !== undefined) {
              return Promise.resolve({ done: false as const, value });
            }
            return new Promise<IteratorResult<unknown>>((resolve) => waiters.add(resolve));
          },
        };
      },
    },
  };
}

const makeHarness = Effect.fn("OpenCodeProjectInstructions.makeHarness")(function* (
  suffix: string,
  client: object,
) {
  const instanceId = ProviderInstanceId.make(`opencode-${suffix}`);
  const threadId = ThreadId.make(`thread-opencode-${suffix}`);
  const modelSelection = { instanceId, model: "anthropic/claude-sonnet", options: [] };
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: "/workspace",
  });
  const adapter = yield* makeOpenCodeAdapterV2({
    instanceId,
    settings: OPEN_CODE_TEST_SETTINGS,
    environment: {},
  }).pipe(
    Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, {
      connectToOpenCodeServer: () => Effect.succeed({ url: "http://test.invalid", external: true }),
      createOpenCodeSdkClient: () => client,
    } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"]),
  );
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`session-opencode-${suffix}`),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  let turnOrdinal = 0;
  const startTurn = (text: string, projectInstructions?: ProjectInstructions) => {
    turnOrdinal += 1;
    const suffixWithOrdinal = turnOrdinal === 1 ? suffix : `${suffix}-${turnOrdinal}`;
    return runtime.startTurn({
      appThread: {
        id: threadId,
        projectId: ProjectId.make(`project-opencode-${suffix}`),
        title: suffix,
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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
      threadId,
      runId: RunId.make(`run-opencode-${suffixWithOrdinal}`),
      runOrdinal: turnOrdinal,
      providerTurnOrdinal: turnOrdinal,
      attemptId: RunAttemptId.make(`attempt-opencode-${suffixWithOrdinal}`),
      rootNodeId: NodeId.make(`node-opencode-${suffixWithOrdinal}`),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`message-opencode-${suffixWithOrdinal}`),
        text,
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
      ...(projectInstructions === undefined ? {} : { projectInstructions }),
    });
  };
  return { providerThread, runtime, startTurn, threadId };
});

describe("OpenCode 1.x project instructions", () => {
  it.effect("repeats, changes and withdraws the block across prompts and steers", () =>
    Effect.gen(function* () {
      const prompts: Array<{
        readonly system?: string;
        readonly parts?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
      }> = [];
      const nativeEvents = nativeEventStream();
      const harness = yield* makeHarness("enabled", {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
          get: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
          messages: async () => ({ data: [] }),
          promptAsync: async (input: (typeof prompts)[number]) => {
            prompts.push(input);
            return { data: true };
          },
          abort: async () => ({ data: true }),
          children: async () => ({ data: [] }),
        },
      });

      const finishTurn = Effect.fnUntraced(function* (ordinal: number) {
        const terminal = yield* harness.runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Effect.sync(() => {
          nativeEvents.push({
            type: "message.updated",
            properties: {
              info: {
                id: `assistant-${ordinal}`,
                sessionID: "root",
                role: "assistant",
                time: { created: ordinal, completed: ordinal },
              },
            },
          });
          nativeEvents.push({ type: "session.idle", properties: { sessionID: "root" } });
        });
        assert.equal((yield* Fiber.join(terminal))._tag, "Some");
      });

      yield* harness.startTurn("hello", PROJECT_INSTRUCTIONS);
      const snapshot = yield* harness.runtime.readThreadSnapshot({
        providerThread: harness.providerThread,
      });
      yield* harness.runtime.steerTurn({
        threadId: harness.threadId,
        runId: RunId.make("run-opencode-enabled"),
        providerThread: harness.providerThread,
        providerTurnId: snapshot.providerTurns.at(-1)!.id,
        message: {
          messageId: MessageId.make("message-opencode-enabled-steer"),
          text: "steer",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });

      assert.isTrue(prompts[0]?.system?.endsWith(PROJECT_INSTRUCTIONS.text));
      assert.equal(prompts[1]?.system, prompts[0]?.system);
      assert.equal(prompts[0]?.parts?.[0]?.text, "hello");
      assert.equal(prompts[1]?.parts?.[0]?.text, "steer");

      yield* finishTurn(1);
      yield* harness.startTurn("changed", CHANGED_PROJECT_INSTRUCTIONS);
      assert.lengthOf(prompts, 3);
      assert.isTrue(prompts[2]?.system?.endsWith(CHANGED_PROJECT_INSTRUCTIONS.text));
      assert.notInclude(prompts[2]?.system ?? "", PROJECT_INSTRUCTIONS.text);

      yield* finishTurn(2);
      yield* harness.startTurn("disabled");
      const disabledPrompts = prompts.slice(3);
      assert.lengthOf(disabledPrompts, 1);
      assert.notInclude(disabledPrompts[0]?.system ?? "", "<token_efficiency>");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("keeps native command prompts free of a system field", () =>
    Effect.gen(function* () {
      const commands: Array<Record<string, unknown>> = [];
      const nativeEvents = nativeEventStream();
      const harness = yield* makeHarness("native-command", {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        command: { list: async () => ({ data: [{ name: "review" }] }) },
        session: {
          create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
          command: async (input: Record<string, unknown>) => {
            commands.push(input);
            return { data: true };
          },
          promptAsync: async () => ({ data: true }),
        },
      });

      yield* harness.startTurn("/review staged changes", PROJECT_INSTRUCTIONS);

      assert.equal(commands.length, 1);
      assert.equal(commands[0]?.command, "review");
      assert.equal(commands[0]?.arguments, "staged changes");
      assert.isFalse("system" in commands[0]!);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
