import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";

import { FAILURE_BACKOFF_CAP, FRESHNESS_TTL, STALENESS_TICK } from "./source.ts";

interface PolicyStatus {
  readonly lastSuccessfulCheckAt: DateTime.Utc | null;
  readonly lastAttemptAt: DateTime.Utc | null;
  readonly consecutiveFailures: number;
  readonly retryAfter?: Duration.Duration | undefined;
}

export function isStale(
  status: Pick<PolicyStatus, "lastSuccessfulCheckAt">,
  now: DateTime.Utc,
): boolean {
  return (
    status.lastSuccessfulCheckAt === null ||
    DateTime.toEpochMillis(now) - DateTime.toEpochMillis(status.lastSuccessfulCheckAt) >=
      Duration.toMillis(FRESHNESS_TTL)
  );
}

export function backoffDelay(
  consecutiveFailures: number,
  retryAfter?: Duration.Duration,
): Duration.Duration {
  const exponential =
    consecutiveFailures <= 0
      ? 0
      : Duration.toMillis(STALENESS_TICK) * 2 ** (consecutiveFailures - 1);
  const requested = retryAfter === undefined ? 0 : Duration.toMillis(retryAfter);
  return Duration.millis(
    Math.min(Duration.toMillis(FAILURE_BACKOFF_CAP), Math.max(exponential, requested)),
  );
}

export function automaticRefreshAllowed({
  status,
  anyEnabled,
  now,
}: {
  readonly status: PolicyStatus;
  readonly anyEnabled: boolean;
  readonly now: DateTime.Utc;
}): boolean {
  if (!anyEnabled || !isStale(status, now)) return false;
  if (status.lastAttemptAt === null) return true;
  const elapsed = DateTime.toEpochMillis(now) - DateTime.toEpochMillis(status.lastAttemptAt);
  return elapsed >= Duration.toMillis(backoffDelay(status.consecutiveFailures, status.retryAfter));
}
