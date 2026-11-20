import {
  CheckpointScopeId,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type ProjectId as ProjectIdValue,
  type ServerSettings as ServerSettingsValue,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as ProjectInstructions from "../plusplus/tokenEfficiency/ProjectInstructions.ts";
import * as TokenEfficiencySnapshotService from "../plusplus/tokenEfficiency/TokenEfficiencySnapshotService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const enabledProjectId = ProjectId.make("project-token-efficiency-enabled");
const disabledProjectId = ProjectId.make("project-token-efficiency-disabled");
const scratchProjectId = ProjectId.make("project-token-efficiency-scratch");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const firstInstructions = { id: "snapshot-1", text: "<token_efficiency>first</token_efficiency>" };
const secondInstructions = {
  id: "snapshot-2",
  text: "<token_efficiency>second</token_efficiency>",
};
const enabledSettings: ServerSettingsValue = {
  ...DEFAULT_SERVER_SETTINGS,
  projectSettingsOverrides: {
    [enabledProjectId]: { plusplus: { tokenEfficiency: true } },
  } as unknown as ServerSettingsValue["projectSettingsOverrides"],
};

const appThread = (
  threadId: ThreadId,
  projectId: ProjectIdValue,
  relationshipToParent: "subagent" | null = null,
) =>
  ({
    id: threadId,
    projectId,
    lineage: {
      parentThreadId: relationshipToParent === null ? null : ThreadId.make("thread-parent"),
      relationshipToParent,
      rootThreadId: threadId,
    },
  }) as OrchestrationV2AppThread;

const startInput = (input: {
  readonly key: string;
  readonly projectId?: ProjectIdValue;
  readonly relationshipToParent?: "subagent" | null;
  readonly createdBy?: "user" | "agent" | "system";
  readonly creationSource?: "web" | "mcp" | "provider" | "server" | "mobile";
  readonly scheduledTaskId?: string;
  readonly cwd?: string;
  readonly text?: string;
}): StartInput => {
  const threadId = ThreadId.make(`thread-${input.key}`);
  const attemptId = RunAttemptId.make(`attempt-${input.key}`);
  return {
    commandId: CommandId.make(`command-${input.key}`),
    appThread: appThread(
      threadId,
      input.projectId ?? enabledProjectId,
      input.relationshipToParent ?? null,
    ),
    providerSessionId: ProviderSessionId.make(`session-${input.key}`),
    run: {
      id: RunId.make(`run-${input.key}`),
      threadId,
      ordinal: 1,
      providerInstanceId,
    } as OrchestrationV2Run,
    rootNode: { id: NodeId.make(`node-${input.key}`) } as OrchestrationV2ExecutionNode,
    checkpointScope: {
      id: CheckpointScopeId.make(`checkpoint-${input.key}`),
    } as OrchestrationV2CheckpointScope,
    providerThread: {
      id: ProviderThreadId.make(`provider-thread-${input.key}`),
      driver,
    } as OrchestrationV2ProviderThread,
    attempt: { id: attemptId, providerTurnId: null } as OrchestrationV2RunAttempt,
    attemptId,
    providerTurnOrdinal: 1,
    message: {
      messageId: MessageId.make(`message-${input.key}`),
      text: input.text ?? "Continue.",
      attachments: [],
      createdBy: input.createdBy ?? "user",
      creationSource: input.creationSource ?? "web",
      ...(input.scheduledTaskId === undefined
        ? {}
        : { scheduledTaskId: ScheduledTaskId.make(input.scheduledTaskId) }),
    },
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimePolicy: {
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: input.cwd ?? process.cwd(),
    },
  };
};

type StartInput = Omit<
  Parameters<RunExecutionService.RunExecutionServiceV2["Service"]["startRootRun"]>[0],
  "session"
>;
interface CapturedTurn {
  readonly method: "start" | "compact";
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
}

const capturingSession = (captured: Array<CapturedTurn>) =>
  ({
    events: Stream.never,
    startTurn: (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) =>
      Effect.sync(() => {
        captured.push({ method: "start", input: turnInput });
      }),
    compactThread: (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) =>
      Effect.sync(() => {
        captured.push({ method: "compact", input: turnInput });
      }),
  }) as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;

const makeLayer = (
  settings: Ref.Ref<ServerSettingsValue>,
  instructions: Ref.Ref<typeof firstInstructions>,
  snapshotReads: Ref.Ref<number>,
) => {
  const snapshots = Layer.succeed(TokenEfficiencySnapshotService.TokenEfficiencySnapshotService, {
    active: Ref.updateAndGet(snapshotReads, (count) => count + 1).pipe(
      Effect.flatMap(() => Ref.get(instructions)),
      Effect.map((current) => ({
        instructions: current,
        provenance: { source: "bundled" as const, blobSha: "blob", adaptationVersion: 1 },
      })),
    ),
    view: Effect.die("view must not be read by turn resolution"),
    refresh: Effect.die("refresh must not run during turn resolution"),
  });
  const settingsService = Layer.mock(ServerSettings.ServerSettingsService)({
    getSettings: Ref.get(settings),
  });
  return RunExecutionService.layer.pipe(
    ProjectInstructions.provideResolver,
    Layer.provide(
      Layer.mergeAll(
        McpAppModelContext.layerEmpty,
        PreviewAgentActivity.layer,
        Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
        Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
          allocate: () => Effect.succeed(1),
        }),
        Layer.mock(EventSink.EventSinkV2)({}),
        Layer.mock(ThreadCommandExecutor.ThreadCommandExecutor)({}),
        IdAllocator.layer,
        Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
          ingestNormalized: () => Effect.succeed([]),
        }),
      ),
    ),
    Layer.provide(snapshots),
    Layer.provide(settingsService),
  );
};

const runMatrix = Effect.gen(function* () {
  const settings = yield* Ref.make<ServerSettingsValue>(enabledSettings);
  const instructions = yield* Ref.make(firstInstructions);
  const snapshotReads = yield* Ref.make(0);
  const captured: Array<CapturedTurn> = [];
  const runExecution = yield* RunExecutionService.RunExecutionServiceV2.pipe(
    Effect.provide(makeLayer(settings, instructions, snapshotReads)),
  );
  const run = (input: StartInput) =>
    runExecution.startRootRun({ ...input, session: capturingSession(captured) });

  const rows = [
    { key: "composer", enabled: true },
    { key: "scheduled", scheduledTaskId: "scheduled-task-1", enabled: true },
    { key: "mcp", creationSource: "mcp", enabled: true },
    { key: "worktree", cwd: "/tmp/project-worktree", enabled: true },
    { key: "provider-switch", enabled: true },
    {
      key: "same-project-child",
      relationshipToParent: "subagent",
      createdBy: "agent",
      creationSource: "provider",
      enabled: true,
    },
    {
      key: "cross-project-child",
      projectId: disabledProjectId,
      relationshipToParent: "subagent",
      createdBy: "agent",
      creationSource: "provider",
      enabled: false,
    },
    {
      key: "scratch-child",
      projectId: scratchProjectId,
      relationshipToParent: "subagent",
      createdBy: "agent",
      creationSource: "provider",
      enabled: false,
    },
    { key: "compact", text: "/compact", enabled: true },
  ] as const;
  for (const row of rows) {
    const before = yield* Ref.get(snapshotReads);
    yield* run(startInput(row));
    assert.equal(captured.at(-1)?.input.projectInstructions !== undefined, row.enabled, row.key);
    assert.equal((yield* Ref.get(snapshotReads)) - before, row.enabled ? 1 : 0, row.key);
    assert.equal(captured.at(-1)?.method, row.key === "compact" ? "compact" : "start", row.key);
  }

  yield* Ref.set(settings, DEFAULT_SERVER_SETTINGS);
  yield* run(startInput({ key: "toggle-off-1" }));
  const runningInput = captured.at(-1)?.input;
  yield* Ref.set(settings, enabledSettings);
  yield* Ref.set(instructions, secondInstructions);
  assert.strictEqual(captured.at(-1)?.input, runningInput);
  assert.isUndefined(runningInput?.projectInstructions);

  yield* run(startInput({ key: "toggle-on" }));
  assert.deepEqual(captured.at(-1)?.input.projectInstructions, secondInstructions);
  yield* Ref.set(settings, DEFAULT_SERVER_SETTINGS);
  yield* run(startInput({ key: "toggle-off-2" }));
  assert.isUndefined(captured.at(-1)?.input.projectInstructions);
});

type ResolverRequirements =
  typeof ProjectInstructions.layer extends Layer.Layer<
    ProjectInstructions.ProjectInstructionsResolver,
    never,
    infer Requirements
  >
    ? Requirements
    : never;
type ExpectedResolverRequirements =
  | ServerSettings.ServerSettingsService
  | TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;

describe("RunExecutionService project instructions", () => {
  it.effect(
    "resolves every entry point from its own project and each turn's snapshot",
    () => runMatrix,
  );

  it("requires no filesystem or HTTP services in the turn resolver", () => {
    type IoRequirements = Extract<
      ResolverRequirements,
      HttpClient.HttpClient | FileSystem.FileSystem
    >;
    const noIo = true as [IoRequirements] extends [never] ? true : false;
    const onlyExpected = true as [
      Exclude<ResolverRequirements, ExpectedResolverRequirements>,
    ] extends [never]
      ? true
      : false;
    assert.isTrue(noIo && onlyExpected);
  });
});
