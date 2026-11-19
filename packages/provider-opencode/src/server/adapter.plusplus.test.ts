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
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

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

const OPEN_CODE_TEST_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  serverUrl: "http://test.invalid",
});

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer({ cwd: "/workspace" }).pipe(Layer.provide(NodeServices.layer)),
);

function emptyEventStream() {
  let closed = false;
  const waiters = new Set<(result: IteratorResult<unknown>) => void>();
  return {
    close() {
      closed = true;
      for (const resolve of waiters) resolve({ done: true, value: undefined });
      waiters.clear();
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            if (closed) return Promise.resolve({ done: true as const, value: undefined });
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
  const startTurn = (text: string, projectInstructions?: ProjectInstructions) =>
    runtime.startTurn({
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
      runId: RunId.make(`run-opencode-${suffix}`),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make(`attempt-opencode-${suffix}`),
      rootNodeId: NodeId.make(`node-opencode-${suffix}`),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`message-opencode-${suffix}`),
        text,
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
      projectInstructions,
    });
  return { providerThread, runtime, startTurn, threadId };
});

describe("OpenCode 1.x project instructions", () => {
  it.effect("repeats the block on prompts and steers, and omits it when disabled", () =>
    Effect.gen(function* () {
      const prompts: Array<{
        readonly system?: string;
        readonly parts?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
      }> = [];
      const nativeEvents = emptyEventStream();
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

      const disabledPrompts: Array<{ readonly system?: string }> = [];
      const disabledEvents = emptyEventStream();
      const disabled = yield* makeHarness("disabled", {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => disabledEvents.close(), { once: true });
            return { stream: disabledEvents.stream };
          },
        },
        session: {
          create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
          promptAsync: async (input: { readonly system?: string }) => {
            disabledPrompts.push(input);
            return { data: true };
          },
        },
      });
      yield* disabled.startTurn("hello");
      assert.notInclude(disabledPrompts[0]?.system ?? "", "<token_efficiency>");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("keeps native command prompts free of a system field", () =>
    Effect.gen(function* () {
      const commands: Array<Record<string, unknown>> = [];
      const nativeEvents = emptyEventStream();
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
