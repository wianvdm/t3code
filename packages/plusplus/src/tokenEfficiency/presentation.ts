import type {
  TokenEfficiencyFailureReason,
  TokenEfficiencyRefreshResult,
  TokenEfficiencySource,
} from "@t3tools/contracts/plusplus/tokenEfficiency";

export const ATTRIBUTION_TEXT =
  "Adapted from undefdev/token-efficiency. Copyright (c) 2026 Tarek Sabet. Licensed under MIT.";

export function sourceLabel(source: TokenEfficiencySource): string {
  return source === "upstream" ? "Cached upstream" : "Bundled fallback";
}

export function shortRevision(revision: string): string {
  return revision.slice(0, 7);
}

const FAILURE_LABELS: Record<TokenEfficiencyFailureReason, string> = {
  network: "network error",
  timeout: "timed out",
  redirect: "redirect rejected",
  "http-status": "HTTP status rejected",
  "rate-limited": "rate limited",
  "too-large": "response too large",
  "content-type": "content type rejected",
  encoding: "invalid encoding",
  empty: "empty response",
  "nul-byte": "NUL byte rejected",
  "unexpected-not-modified": "unexpected not-modified response",
  adaptation: "adaptation rejected",
  "cache-write": "cache write failed",
  "cache-invalid": "cached content invalid",
};

function activeRevision(view: TokenEfficiencyRefreshResult["view"]): string {
  const active = view.status.active;
  const revision = shortRevision(active.blobSha);
  if (active.source === "upstream") return `Cached upstream revision ${revision}`;
  const pinned =
    active.upstreamCommit === undefined ? "" : ` (pinned ${shortRevision(active.upstreamCommit)})`;
  return `Bundled revision ${revision}${pinned}`;
}

export function refreshOutcomeMessage(result: TokenEfficiencyRefreshResult): string {
  const revision = activeRevision(result.view);
  if (result.outcome === "updated") return `Refresh updated. ${revision} is active.`;
  if (result.outcome === "unchanged") return `Refresh unchanged. ${revision} stays active.`;
  const reason = result.view.status.lastFailure;
  const label = reason === null ? "unknown error" : FAILURE_LABELS[reason.reason];
  return `Refresh failed (${label}). ${revision} stays active.`;
}
