import {
  ClaudeSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";

import { claudeEffectiveQueryKey } from "../../plusplus/projectInstructions/claude.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { ClaudeOrchestratorReplayHarness } from "./ClaudeAdapterV2.testkit.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";

const first = { id: "snapshot-1", text: "<token_efficiency>first</token_efficiency>" };
const second = { id: "snapshot-2", text: "<token_efficiency>second</token_efficiency>" };
const base = "claude-query-policy";
const nativeThreadId = "native-claude-thread";
const defaultSettings = Schema.decodeSync(ClaudeSettings)({});

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

const systemPromptAppend = (projectInstructions: ProjectInstructions | undefined) => {
  const options = ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
      model: "claude-haiku-4-5-20251001",
    },
    nativeThreadId,
    resume: false,
    cwd: "/workspace",
    settings: defaultSettings,
    projectInstructions: projectInstructions?.text,
  });
  return (options.systemPrompt as { readonly append?: string }).append ?? "";
};

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

  it.effect("applies live-query changes around provider-native background work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript({
          provider: "claudeAgent",
          protocol: "claude-agent-sdk.query",
          version: "1",
          scenario: "project_instructions_live_query",
          metadata: { nativeSessionId: nativeThreadId },
          entries: [
            {
              type: "query.open",
              options: {
                model: "claude-haiku-5-5",
                tools: { type: "preset", preset: "claude_code" },
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
                settings: { showThinkingSummaries: true },
                sessionId: nativeThreadId,
              },
            },
            { type: "prompt.offer", text: "Start background work." },
            { type: "task_started" },
            { type: "result", text: "Background work started." },
            { type: "prompt.offer", text: "Enable while background work runs." },
            { type: "result", text: "Still on the original query." },
            { type: "task_notification" },
            { type: "runtime_exit" },
            {
              type: "query.open",
              options: {
                model: "claude-haiku-5-5",
                tools: { type: "preset", preset: "claude_code" },
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
                settings: { showThinkingSummaries: true },
                resume: nativeThreadId,
              },
            },
            { type: "prompt.offer", text: "Apply enabled instructions." },
            { type: "result", text: "Enabled instructions applied." },
            { type: "runtime_exit" },
          ].flatMap((step, index): ReadonlyArray<ProviderReplayTranscript["entries"][number]> => {
            if (step.type === "query.open") {
              return [
                { type: "expect_outbound", frame: { type: step.type, options: step.options } },
              ];
            }
            if (step.type === "prompt.offer") {
              return [
                {
                  type: "expect_outbound",
                  frame: {
                    type: step.type,
                    message: {
                      type: "user",
                      message: { role: "user", content: step.text },
                      parent_tool_use_id: null,
                    },
                  },
                },
              ];
            }
            if (step.type === "task_started") {
              return [
                {
                  type: "emit_inbound",
                  frame: {
                    type: "system",
                    subtype: "task_started",
                    task_id: "background-task",
                    tool_use_id: "background-tool",
                    description: "Background build",
                    is_backgrounded: true,
                    task_type: "local_bash",
                    uuid: "background-started",
                    session_id: nativeThreadId,
                  },
                },
              ];
            }
            if (step.type === "task_notification") {
              return [
                {
                  type: "emit_inbound",
                  label: "hold-background-completion",
                  frame: {
                    type: "system",
                    subtype: "task_notification",
                    task_id: "background-task",
                    tool_use_id: "background-tool",
                    status: "completed",
                    output_file: "/tmp/background-task.output",
                    summary: "Background build completed",
                    uuid: "background-completed",
                    session_id: nativeThreadId,
                  },
                },
              ];
            }
            if (step.type === "runtime_exit") {
              return [{ type: "runtime_exit", status: "success" }];
            }
            return [
              {
                type: "emit_inbound",
                frame: {
                  type: "result",
                  subtype: "success",
                  duration_ms: 10,
                  duration_api_ms: 10,
                  is_error: false,
                  num_turns: 1,
                  result: step.text,
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
                  uuid: `result-${index}`,
                  session_id: nativeThreadId,
                  terminal_reason: "completed",
                },
              },
            ];
          }),
        } satisfies ProviderReplayTranscript);
        const replayGate = makeProviderReplayGate(["hold-background-completion"]);
        const registryContext = yield* Layer.build(
          ClaudeOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript, {
            replayGate,
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
        yield* Queue.take(terminals);
        assert.isTrue(yield* runtime.hasPendingBackgroundWork!);

        yield* runtime.startTurn(turn(2, "Enable while background work runs.", first));
        yield* Queue.take(terminals);
        assert.isTrue(yield* runtime.hasPendingBackgroundWork!);

        assert.isTrue(replayGate.release("hold-background-completion"));
        yield* Deferred.await(backgroundFinished);
        assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
        yield* runtime.startTurn(turn(3, "Apply enabled instructions.", first));
        yield* Queue.take(terminals);
        assert.isTrue(systemPromptAppend(first).endsWith(first.text));
        assert.notInclude(systemPromptAppend(undefined), "<token_efficiency>");
      }),
    ),
  );

  it("appends the active block last and removes it when disabled", () => {
    const disabled = systemPromptAppend(undefined);
    const enabled = systemPromptAppend(first);
    const refreshed = systemPromptAppend(second);

    assert.isTrue(enabled.endsWith(first.text));
    assert.isTrue(refreshed.endsWith(second.text));
    assert.notInclude(disabled, "<token_efficiency>");
    assert.notInclude(enabled, second.text);
  });
});
