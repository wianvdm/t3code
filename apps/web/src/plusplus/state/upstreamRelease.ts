import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { wasBootstrapThreadDeleted } from "@t3tools/client-runtime/errors";
import {
  deriveThreadTitleSeed,
  type StartThreadTurnInput,
} from "@t3tools/client-runtime/operations";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";
import { msg } from "gt-react";
import { useEffect } from "react";

import {
  markPromotedDraftThreadByRef,
  restoreFailedDraftThread,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { resolveComposerProviderModelSelection } from "../chat/composerProviderModelSelection";
import { getComposerPromptInjectionState } from "../../components/chat/composerProviderState";
import {
  buildUpstreamMergePrompt,
  FORK_REPOSITORY,
  isUpstreamCacheEntryFresh,
  isUpstreamReleaseNotificationBuild,
  pickForkProject,
  readCachedUpstreamRelease,
  refreshUpstreamReleaseIfStale,
  refreshUpstreamReleaseNow,
  shouldDeferUpstreamMerge,
  UPSTREAM_POLL_INTERVAL_MS,
  type UpstreamReleaseResult,
} from "../upstreamRelease.logic";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import type { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { getClientSettings, mergeEnvironmentSettings } from "../../hooks/useSettings";
import { m } from "../../i18n/messages";
import { newMessageId, newThreadId } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readDesktopUpdateState } from "../../state/desktopUpdate";
import { readProject, readProjects, useProjects } from "../../state/entities";
import { environmentServerConfigsAtom, providersIgnoringCheckedAtAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { ORCHESTRATION_OPERATE_DENIED_MESSAGE } from "../../state/use-orchestration-command";
import {
  noUpstreamMergeAccessAtom,
  readUpstreamMergeAccess,
  upstreamMergeAccess,
} from "./upstreamMergeAccess";

const NO_PROJECT_FOUND_MESSAGE = msg(
  "No project found for github.com/{repository}. Add the fork checkout as a project first.",
  { repository: FORK_REPOSITORY },
);
const START_MERGE_FAILED_MESSAGE = msg("Could not start upstream merge");
const UPDATE_FORK_FIRST_TITLE = msg("Update the fork first");
const UPDATE_FORK_FIRST_DESCRIPTION = msg(
  "A desktop update is ready. Update the fork before merging upstream.",
);
const MERGE_DRAFT_INCOMPLETE_MESSAGE = msg(
  "The merge draft is missing its project, model, or workspace settings.",
);

export type NewThreadRunner = ReturnType<typeof useNewThreadHandler>;
interface StartUpstreamMergeOptions {
  readonly newThread?: NewThreadRunner;
}

let activeNewThreadRunner: NewThreadRunner | null = null;
let upstreamMergeStartInFlight = false;

export function registerNewThreadRunner(runner: NewThreadRunner): () => void {
  activeNewThreadRunner = runner;
  return () => {
    if (activeNewThreadRunner === runner) {
      activeNewThreadRunner = null;
    }
  };
}

function getInitialUpstreamReleaseState(): UpstreamReleaseResult | null {
  if (!isUpstreamReleaseNotificationBuild) {
    return null;
  }
  const cached = readCachedUpstreamRelease();
  if (!cached || !isUpstreamCacheEntryFresh(cached, Date.now())) {
    return null;
  }
  return cached.result;
}

export const upstreamReleaseStateAtom = Atom.make<UpstreamReleaseResult | null>(
  getInitialUpstreamReleaseState(),
).pipe(Atom.keepAlive, Atom.withLabel("upstream-release:state"));

async function refreshAndPublishIfStale(): Promise<void> {
  const result = await refreshUpstreamReleaseIfStale();
  appAtomRegistry.set(upstreamReleaseStateAtom, result);
}

/** Only the fork checkout's environment can authorize its upstream-merge UI. */
export function useUpstreamMergeEligible(): boolean {
  const projects = useProjects();
  const projectRef = isUpstreamReleaseNotificationBuild ? pickForkProject(projects) : null;
  const access = useAtomValue(
    projectRef === null
      ? noUpstreamMergeAccessAtom
      : upstreamMergeAccess({ environmentId: projectRef.environmentId, input: {} }),
  );
  return projectRef !== null && AsyncResult.getOrElse(access, () => false);
}

export function useUpstreamReleasePolling(): void {
  const eligible = useUpstreamMergeEligible();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- checks GitHub once when a matching fork checkout appears
  useEffect(() => {
    if (!eligible) {
      return;
    }
    void refreshAndPublishIfStale();
  }, [eligible]);

  useLiveRefresh(eligible ? () => void refreshAndPublishIfStale() : null, {
    enabled: eligible,
    key: "upstream-release",
    intervalMs: UPSTREAM_POLL_INTERVAL_MS,
  });
}

export function useUpstreamRelease(): UpstreamReleaseResult | null {
  return useAtomValue(upstreamReleaseStateAtom);
}

export async function startUpstreamMerge(
  tag: string,
  options?: StartUpstreamMergeOptions,
): Promise<void> {
  if (upstreamMergeStartInFlight) return;
  upstreamMergeStartInFlight = true;
  try {
    await startUpstreamMergeUnchecked(tag, options);
  } finally {
    upstreamMergeStartInFlight = false;
  }
}

async function startUpstreamMergeUnchecked(
  tag: string,
  options?: StartUpstreamMergeOptions,
): Promise<void> {
  if (shouldDeferUpstreamMerge(readDesktopUpdateState())) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: m(UPDATE_FORK_FIRST_TITLE),
        description: m(UPDATE_FORK_FIRST_DESCRIPTION),
      }),
    );
    return;
  }

  const runner = options?.newThread ?? activeNewThreadRunner;
  const projectRef = pickForkProject(readProjects());

  if (!projectRef) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: m(NO_PROJECT_FOUND_MESSAGE),
      }),
    );
    return;
  }

  const pushAccess = await readUpstreamMergeAccess(projectRef.environmentId);
  if (pushAccess !== true) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title:
          pushAccess === undefined
            ? m(msg("Couldn't check push access to {repository}"), { repository: FORK_REPOSITORY })
            : m(msg("No push access to {repository}"), { repository: FORK_REPOSITORY }),
      }),
    );
    return;
  }

  if (!readEnvironmentScope(projectRef.environmentId, AuthOrchestrationOperateScope)) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: m(START_MERGE_FAILED_MESSAGE),
        description: m(ORCHESTRATION_OPERATE_DENIED_MESSAGE),
      }),
    );
    return;
  }

  if (!runner) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: m(msg("Could not open a new thread. Open the sidebar and try again.")),
      }),
    );
    return;
  }

  const session = await runner(projectRef, {
    envMode: "worktree",
    branch: "main",
  });

  if (!session) {
    return;
  }

  const prompt = buildUpstreamMergePrompt(tag);
  const draftStore = useComposerDraftStore.getState();
  draftStore.setPrompt(session.draftId, prompt);
  const draft = draftStore.getDraftSession(session.draftId);
  const composer = draftStore.getComposerDraft(session.draftId);
  const project = draft ? readProject(scopeProjectRef(draft.environmentId, draft.projectId)) : null;
  const needsWorktree =
    draft !== null && draft.envMode === "worktree" && draft.worktreePath === null;
  const baseBranch = draft?.branch ?? null;

  if (
    draft === null ||
    composer === null ||
    project === null ||
    (needsWorktree && baseBranch === null)
  ) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: m(START_MERGE_FAILED_MESSAGE),
        description: m(MERGE_DRAFT_INCOMPLETE_MESSAGE),
      }),
    );
    return;
  }

  // Mirror the composer's model resolution, but with only the draft's active provider as a
  // candidate: the runner already seeded the thread/project defaults into the draft.
  const environmentId = draft.environmentId;
  const serverSettings =
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.settings ??
    DEFAULT_SERVER_SETTINGS;
  const settings = mergeEnvironmentSettings(serverSettings, getClientSettings());
  const providerStatuses = appAtomRegistry.get(providersIgnoringCheckedAtAtom(environmentId));
  const resolvedModel = resolveComposerProviderModelSelection({
    providerStatuses,
    settings,
    activeProjectId: draft.projectId,
    draftModelState: composer,
    threadModelSelection: null,
    projectModelSelection: null,
    promptInjectionState: getComposerPromptInjectionState(composer.prompt),
    threadStarted: false,
    candidateInstanceIds: [composer.activeProvider ?? null],
    lockedProvider: null,
    lockedInstanceId: null,
  });

  if (resolvedModel.selectedProviderEntry === undefined) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: m(START_MERGE_FAILED_MESSAGE),
        description: m(MERGE_DRAFT_INCOMPLETE_MESSAGE),
      }),
    );
    return;
  }

  const modelSelection = resolvedModel.selectedModelSelection;
  const prepareWorktree =
    needsWorktree && baseBranch !== null
      ? {
          projectCwd: project.workspaceRoot,
          baseBranch,
          startFromOrigin: draft.startFromOrigin,
        }
      : undefined;
  const threadRef = scopeThreadRef(environmentId, draft.threadId);
  const title = deriveThreadTitleSeed({ text: composer.prompt, attachments: [] });
  const runtimeMode = composer.runtimeMode ?? draft.runtimeMode;
  const interactionMode = composer.interactionMode ?? draft.interactionMode;
  const input: StartThreadTurnInput = {
    threadId: draft.threadId,
    message: {
      messageId: newMessageId(),
      role: "user",
      text: composer.prompt,
      attachments: [],
    },
    modelSelection,
    titleSeed: title,
    runtimeMode,
    interactionMode,
    bootstrap: {
      createThread: {
        projectId: draft.projectId,
        title,
        modelSelection,
        runtimeMode,
        interactionMode,
        branch: draft.branch,
        worktreePath: draft.worktreePath,
        createdAt: draft.createdAt,
      },
      ...(prepareWorktree ? { prepareWorktree } : {}),
      runSetupScript: true,
    },
    createdAt: new Date().toISOString(),
  };

  // An update can land while the runner opens the draft.
  if (shouldDeferUpstreamMerge(readDesktopUpdateState())) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: m(UPDATE_FORK_FIRST_TITLE),
        description: m(UPDATE_FORK_FIRST_DESCRIPTION),
      }),
    );
    return;
  }

  markPromotedDraftThreadByRef(threadRef);
  const result = await runAtomCommand(appAtomRegistry, threadEnvironment.startTurn, {
    environmentId,
    input,
  });
  if (result._tag !== "Failure") {
    // The draft route finalizes promotion once the server shell can take over.
    // Finalizing earlier can remove the draft before that route transition.
    return;
  }

  const error = squashAtomCommandFailure(result);
  restoreFailedDraftThread(
    session.draftId,
    draft,
    wasBootstrapThreadDeleted(error) ? newThreadId() : draft.threadId,
  );
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: m(START_MERGE_FAILED_MESSAGE),
      description:
        error instanceof Error ? error.message : m(msg("Failed to start the merge agent.")),
    }),
  );
}

export async function runManualUpstreamCheck(): Promise<void> {
  const projectRef = isUpstreamReleaseNotificationBuild ? pickForkProject(readProjects()) : null;
  if (projectRef === null || !(await readUpstreamMergeAccess(projectRef.environmentId))) {
    return;
  }

  const result = await refreshUpstreamReleaseNow();
  appAtomRegistry.set(upstreamReleaseStateAtom, result);

  if (result.kind === "unknown") {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: m(msg("Could not check upstream releases")),
        description: result.reason,
      }),
    );
    return;
  }

  if (result.kind === "unmerged") {
    const shouldDeferMerge = shouldDeferUpstreamMerge(readDesktopUpdateState());
    const toastId = toastManager.add(
      stackedThreadToast({
        type: "info",
        title: m(msg("Upstream {tag} is ready to merge"), { tag: result.tag }),
        ...(shouldDeferMerge
          ? {
              description: m(
                msg("Update the fork first, then create a local upstream merge draft."),
              ),
            }
          : {
              actionProps: {
                children: m(msg("Create local upstream merge draft")),
                onClick: () => {
                  toastManager.close(toastId);
                  void startUpstreamMerge(result.tag);
                },
              },
            }),
      }),
    );
  }
}
