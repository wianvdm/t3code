import {
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type ProviderUsageLimitsUpdate,
} from "@t3tools/contracts";

import { readUsageAccounts, withUsageAccounts } from "./contracts.ts";

/**
 * Provider-neutral usage-limit algebra: snapshot construction, sparse update
 * merging, and probe reconciliation. IO stays in the provider and server facades.
 */

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits {
  return { checkedAt: input.checkedAt, windows: sortWindows(input.windows) };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update } = input;
  if (update.windows.length === 0 || previous?.unavailable?.reason === "unsupported") {
    return previous;
  }
  const merged = new Map(previous?.windows.map((window) => [window.id, window] as const));
  // Codex repeats unchanged limits on token ticks; avoid allocating snapshots for no-ops.
  let changed = false;
  for (const window of update.windows) {
    const existing = merged.get(window.id);
    const next: ServerProviderUsageWindow = {
      ...window,
      usedPercent: clampPercent(window.usedPercent),
      ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
    };
    if (existing === undefined || !usageWindowEquals(existing, next)) {
      merged.set(window.id, next);
      changed = true;
    }
  }
  if (!changed && previous !== undefined) {
    return previous;
  }
  const unavailable =
    previous === undefined ? { reason: "probeFailed" as const } : previous.unavailable;
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows: merged.values() }),
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
    ...(unavailable !== undefined ? { unavailable } : {}),
  };
}

function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins
  );
}

export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  if (probed?.unavailable?.reason === "probeFailed" && published && !published.unavailable) {
    return published;
  }
  if (
    published &&
    probed &&
    !published.unavailable &&
    !probed.unavailable &&
    Date.parse(published.checkedAt) > Date.parse(probed.checkedAt)
  ) {
    return { ...probed, checkedAt: published.checkedAt, windows: published.windows };
  }
  return probed;
}

function snapshotWithUsageLimits(
  snapshot: ServerProvider,
  usageLimits: ServerProvider["usageLimits"],
): ServerProvider {
  if (snapshot.usageLimits === usageLimits) {
    return snapshot;
  }
  const { usageLimits: _previous, ...rest } = snapshot;
  return usageLimits ? { ...rest, usageLimits } : rest;
}

/**
 * Failed reads retain last-good limits only for the same account and original
 * workspace; drivers fold auth-file read failures into empty account lists.
 */
export function reconcileProviderUsageSnapshot(input: {
  readonly published: ServerProvider;
  readonly probed: ServerProvider;
}): ServerProvider {
  const { published, probed: probedSnapshot } = input;
  const previous = published.auth;
  const differs = (a: string | undefined, b: string | undefined) =>
    a !== undefined && b !== undefined && a !== b;
  const switchedAccount =
    differs(probedSnapshot.auth.email?.toLowerCase(), previous.email?.toLowerCase()) ||
    (probedSnapshot.auth.workspaceId !== undefined &&
      probedSnapshot.auth.workspaceId !== previous.workspaceId);
  const usageLimits = switchedAccount
    ? probedSnapshot.usageLimits
    : resolveUsageLimitsAfterProbe({
        published: published.usageLimits,
        probed: probedSnapshot.usageLimits,
      });
  const workspaceId =
    usageLimits === probedSnapshot.usageLimits ? undefined : published.auth.workspaceId;
  const probedAccounts = readUsageAccounts(probedSnapshot);
  const publishedAccounts = readUsageAccounts(published);
  // Sign-out, uninstall, and account switches still drop the accounts.
  const retainedAccounts =
    !switchedAccount &&
    probedSnapshot.installed &&
    probedSnapshot.auth.status === "authenticated" &&
    (probedAccounts?.length ?? 0) === 0 &&
    (publishedAccounts?.length ?? 0) > 0
      ? publishedAccounts
      : undefined;
  const withWorkspace =
    workspaceId && !probedSnapshot.auth.workspaceId
      ? { ...probedSnapshot, auth: { ...probedSnapshot.auth, workspaceId } }
      : probedSnapshot;
  return snapshotWithUsageLimits(
    retainedAccounts ? withUsageAccounts(withWorkspace, retainedAccounts) : withWorkspace,
    usageLimits,
  );
}
