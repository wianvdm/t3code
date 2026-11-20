import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";

export const TokenEfficiencySource = Schema.Literals(["bundled", "upstream"]);
export type TokenEfficiencySource = typeof TokenEfficiencySource.Type;

export const TokenEfficiencyFailureReason = Schema.Literals([
  "network",
  "timeout",
  "redirect",
  "http-status",
  "rate-limited",
  "too-large",
  "content-type",
  "encoding",
  "empty",
  "nul-byte",
  "unexpected-not-modified",
  "adaptation",
  "cache-write",
  "cache-invalid",
]);
export type TokenEfficiencyFailureReason = typeof TokenEfficiencyFailureReason.Type;

export const TokenEfficiencyActiveSnapshot = Schema.Struct({
  source: TokenEfficiencySource,
  /** Git blob SHA of the raw upstream CORE.md bytes, computed locally. */
  blobSha: Schema.String,
  adaptationVersion: Schema.Number,
  /** Bundled only: the upstream commit the fallback was pinned from. */
  upstreamCommit: Schema.optionalKey(Schema.String),
  /** Upstream only: when this body arrived in a valid 200. */
  fetchedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
});
export type TokenEfficiencyActiveSnapshot = typeof TokenEfficiencyActiveSnapshot.Type;

export const TokenEfficiencyStatus = Schema.Struct({
  active: TokenEfficiencyActiveSnapshot,
  /** Valid 200 or 304; drives the six-hour TTL. */
  lastSuccessfulCheckAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /** Any network attempt; drives automatic failure backoff. */
  lastAttemptAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  lastFailure: Schema.NullOr(
    Schema.Struct({
      at: Schema.DateTimeUtcFromString,
      reason: TokenEfficiencyFailureReason,
    }),
  ),
  refreshing: Schema.Boolean,
  /** False while every project here is disabled: no automatic requests are made. */
  automaticRefresh: Schema.Boolean,
});
export type TokenEfficiencyStatus = typeof TokenEfficiencyStatus.Type;

export const TokenEfficiencyView = Schema.Struct({
  status: TokenEfficiencyStatus,
  /** Exactly the text agents receive (ProjectInstructions.text). */
  instructions: Schema.String,
});
export type TokenEfficiencyView = typeof TokenEfficiencyView.Type;

export const TokenEfficiencyRefreshResult = Schema.Struct({
  outcome: Schema.Literals(["updated", "unchanged", "failed"]),
  view: TokenEfficiencyView,
});
export type TokenEfficiencyRefreshResult = typeof TokenEfficiencyRefreshResult.Type;

export const TOKEN_EFFICIENCY_WS_METHODS = {
  view: "plusplus.tokenEfficiency.view",
  refresh: "plusplus.tokenEfficiency.refresh",
} as const;

const TokenEfficiencyViewRpc = Rpc.make(TOKEN_EFFICIENCY_WS_METHODS.view, {
  payload: Schema.Struct({}),
  success: TokenEfficiencyView,
  error: EnvironmentAuthorizationError,
});
const TokenEfficiencyRefreshRpc = Rpc.make(TOKEN_EFFICIENCY_WS_METHODS.refresh, {
  payload: Schema.Struct({}),
  success: TokenEfficiencyRefreshResult,
  error: EnvironmentAuthorizationError,
});
export const TokenEfficiencyRpcs = [TokenEfficiencyViewRpc, TokenEfficiencyRefreshRpc] as const;

export const TOKEN_EFFICIENCY_SERVER_RPC_SCOPES = {
  [TOKEN_EFFICIENCY_WS_METHODS.view]: AuthOrchestrationReadScope,
} as const;

export const TOKEN_EFFICIENCY_GUARDED_RPC_SCOPES = {
  [TOKEN_EFFICIENCY_WS_METHODS.refresh]: AuthSettingsWriteScope,
} as const;
