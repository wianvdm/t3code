import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  type ProviderReplayTranscript,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProjectInstructions } from "@t3tools/plusplus/projectInstructions";
import { withProjectInstructionsKey } from "@t3tools/plusplus/projectInstructions";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { claudeEffectiveQueryKey } from "../../plusplus/projectInstructions/claude.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { ClaudeOrchestratorReplayHarness } from "./ClaudeAdapterV2.testkit.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";

const first = { id: "snapshot-1", text: "<token_efficiency>first</token_efficiency>" };
const second = { id: "snapshot-2", text: "<token_efficiency>second</token_efficiency>" };
const base = "claude-query-policy";
const nativeThreadId = "native-claude-thread";

interface LiveQuery {
  readonly nativeThreadId: string;
  readonly stopping: boolean;
  readonly queryPolicyKey: string;
}

const effectiveKey = (
  existing: LiveQuery | null,
  projectInstructions: ProjectInstructions | undefined,
  backgroundBusy = false,
  baseKey = base,
) =>
  Ref.make(existing).pipe(
    Effect.flatMap((queryContext) =>
      claudeEffectiveQueryKey({
        base: baseKey,
        projectInstructions,
        queryContext,
        nativeThreadId,
        backgroundBusy: () => Effect.succeed(backgroundBusy),
      }),
    ),
  );

const systemPromptAppend = (options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions) =>
  (options.systemPrompt as { readonly append?: string }).append ?? "";

const resultMessage = (ordinal: number): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    duration_ms: 10,
    duration_api_ms: 10,
    is_error: false,
    num_turns: 1,
    result: `Turn ${ordinal} completed.`,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: `result-${ordinal}`,
    session_id: nativeThreadId,
    terminal_reason: "completed",
  }) as SDKMessage;

const backgroundStarted = {
  type: "system",
  subtype: "task_started",
  task_id: "background-task",
  tool_use_id: "background-tool",
  description: "Background build",
  is_backgrounded: true,
  task_type: "local_bash",
  uuid: "background-started",
  session_id: nativeThreadId,
} as SDKMessage;

const backgroundCompleted = {
  type: "system",
  subtype: "task_notification",
  task_id: "background-task",
  tool_use_id: "background-tool",
  status: "completed",
  output_file: "/tmp/background-task.output",
  summary: "Background build completed",
  uuid: "background-completed",
  session_id: nativeThreadId,
} as SDKMessage;

describe("Claude project instruction delivery", () => {
  it.effect(
    "replaces the live-query key on enable, disable and refresh, but not on an unchanged id",
    () =>
      Effect.gen(function* () {
        const disabled = withProjectInstructionsKey(base, undefined);
        const enabled = withProjectInstructionsKey(base, first);
        const refreshed = withProjectInstructionsKey(base, second);

        assert.equal(yield* effectiveKey(null, undefined), disabled);
        assert.equal(
          yield* effectiveKey({ nativeThreadId, stopping: false, queryPolicyKey: disabled }, first),
          enabled,
        );
        assert.equal(
          yield* effectiveKey(
            { nativeThreadId, stopping: false, queryPolicyKey: enabled },
            undefined,
          ),
          disabled,
        );
        assert.equal(
          yield* effectiveKey({ nativeThreadId, stopping: false, queryPolicyKey: enabled }, second),
          refreshed,
        );
        assert.equal(
          yield* effectiveKey({ nativeThreadId, stopping: false, queryPolicyKey: enabled }, first),
          enabled,
        );
      }),
  );

  it.effect(
    "defers enable, disable and refresh only while provider-native background work runs",
    () =>
      Effect.gen(function* () {
        const disabled = withProjectInstructionsKey(base, undefined);
        const enabled = withProjectInstructionsKey(base, first);
        const refreshed = withProjectInstructionsKey(base, second);

        assert.equal(
          yield* effectiveKey(
            { nativeThreadId, stopping: false, queryPolicyKey: disabled },
            first,
            true,
          ),
          disabled,
        );
        assert.equal(
          yield* effectiveKey(
            { nativeThreadId, stopping: false, queryPolicyKey: enabled },
            undefined,
            true,
          ),
          enabled,
        );
        assert.equal(
          yield* effectiveKey(
            { nativeThreadId, stopping: false, queryPolicyKey: enabled },
            second,
            true,
          ),
          enabled,
        );
        assert.equal(
          yield* effectiveKey({ nativeThreadId, stopping: false, queryPolicyKey: enabled }, second),
          refreshed,
        );
      }),
  );

  it.effect("delivers instruction changes through live Claude queries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript({
          provider: "claudeAgent",
          protocol: "claude-agent-sdk.query",
          version: "1",
          scenario: "project_instructions_live_query",
          metadata: { nativeSessionId: nativeThreadId },
          entries: [],
        } satisfies ProviderReplayTranscript);
        const openedOptions: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions> = [];
        const messageQueues = yield* Effect.all([
          Queue.unbounded<SDKMessage>(),
          Queue.unbounded<SDKMessage>(),
          Queue.unbounded<SDKMessage>(),
          Queue.unbounded<SDKMessage>(),
        ]);
        const registryContext = yield* Layer.build(
          ClaudeOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript, {
            queryRunner: {
              open: (input) => {
                const messages = messageQueues[openedOptions.length];
                if (messages === undefined) {
                  throw new Error("Unexpected additional Claude query.");
                }
                openedOptions.push(input.options);
                return {
                  messages: Stream.fromQueue(messages),
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  stopTask: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  mcpServerStatus: Effect.succeed([]),
                  readMcpResource: () => Effect.die("unexpected MCP resource read"),
                  callMcpTool: () => Effect.die("unexpected MCP tool call"),
                  listPermissionRules: Effect.die("unexpected permission rules read"),
                  interrupt: Effect.void,
                  close: Queue.shutdown(messages),
                };
              },
              forkSession: () => {
                throw new Error("Unexpected Claude session fork.");
              },
              subagentLaunchToolUseId: () => null,
              assertComplete: () => undefined,
            },
          }).pipe(Layer.provide(McpProviderSessions.layer)),
        );
        const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2.pipe(
          Effect.provide(registryContext),
        );
        const adapter = yield* registry.get(ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID);
        const threadId = ThreadId.make("thread-claude-project-instructions");
        const modelSelection = {
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          model: "claude-haiku-5-5",
        };
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace",
        });
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-project-instructions"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const terminals = yield* Queue.unbounded<void>();
        const backgroundFinished = yield* Deferred.make<void>();
        let terminalCount = 0;
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.type === "turn.terminal") {
                terminalCount++;
                yield* Queue.offer(terminals, undefined);
              }
              if (
                terminalCount >= 2 &&
                event.type === "provider_thread.updated" &&
                (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0
              ) {
                yield* Deferred.succeed(backgroundFinished, undefined);
              }
            }),
          ),
          Effect.forkScoped,
        );
        const turn = (
          ordinal: number,
          text: string,
          projectInstructions: ProjectInstructions | undefined,
        ): ProviderAdapter.ProviderAdapterV2TurnInput => {
          const attemptId = RunAttemptId.make(`attempt-project-instructions-${ordinal}`);
          return {
            appThread: {
              id: threadId,
              projectId: ProjectId.make("project-claude-project-instructions"),
              title: "Claude project instructions",
              lineage: {
                parentThreadId: null,
                relationshipToParent: null,
                rootThreadId: threadId,
              },
            } as ProviderAdapter.ProviderAdapterV2TurnInput["appThread"],
            threadId,
            runId: RunId.make(`run-project-instructions-${ordinal}`),
            runOrdinal: ordinal,
            providerTurnOrdinal: ordinal,
            attemptId,
            rootNodeId: NodeId.make(`node-project-instructions-${ordinal}`),
            providerThread,
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: MessageId.make(`message-project-instructions-${ordinal}`),
              text,
              attachments: [],
            },
            modelSelection,
            runtimePolicy,
            ...(projectInstructions === undefined ? {} : { projectInstructions }),
          };
        };

        yield* runtime.startTurn(turn(1, "Start background work.", undefined));
        yield* Queue.offer(messageQueues[0]!, backgroundStarted);
        yield* Queue.offer(messageQueues[0]!, resultMessage(1));
        yield* Queue.take(terminals);
        assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
        assert.lengthOf(openedOptions, 1);
        assert.notInclude(systemPromptAppend(openedOptions[0]!), "<token_efficiency>");

        yield* runtime.startTurn(turn(2, "Enable while background work runs.", first));
        yield* Queue.offer(messageQueues[0]!, resultMessage(2));
        yield* Queue.take(terminals);
        assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
        assert.lengthOf(openedOptions, 1);

        yield* Queue.offer(messageQueues[0]!, backgroundCompleted);
        yield* Deferred.await(backgroundFinished);
        assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
        yield* runtime.startTurn(turn(3, "Apply enabled instructions.", first));
        assert.lengthOf(openedOptions, 2);
        yield* Queue.offer(messageQueues[1]!, resultMessage(3));
        yield* Queue.take(terminals);
        assert.isTrue(systemPromptAppend(openedOptions[1]!).endsWith(first.text));

        yield* runtime.startTurn(turn(4, "Reuse unchanged instructions.", first));
        yield* Queue.offer(messageQueues[1]!, resultMessage(4));
        yield* Queue.take(terminals);
        assert.lengthOf(openedOptions, 2);

        yield* runtime.startTurn(turn(5, "Refresh instructions.", second));
        assert.lengthOf(openedOptions, 3);
        yield* Queue.offer(messageQueues[2]!, resultMessage(5));
        yield* Queue.take(terminals);
        assert.isTrue(systemPromptAppend(openedOptions[2]!).endsWith(second.text));
        assert.notInclude(systemPromptAppend(openedOptions[2]!), first.text);

        yield* runtime.compactThread(turn(6, "Compact with current instructions.", second));
        yield* Queue.offer(messageQueues[2]!, resultMessage(6));
        yield* Queue.take(terminals);
        assert.lengthOf(openedOptions, 3);
        assert.isTrue(systemPromptAppend(openedOptions[2]!).endsWith(second.text));

        yield* runtime.startTurn(turn(7, "Disable instructions.", undefined));
        assert.lengthOf(openedOptions, 4);
        yield* Queue.offer(messageQueues[3]!, resultMessage(7));
        yield* Queue.take(terminals);
        assert.notInclude(systemPromptAppend(openedOptions[3]!), "<token_efficiency>");
      }),
    ),
  );
});
