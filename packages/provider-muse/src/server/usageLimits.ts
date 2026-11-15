import * as DateTime from "effect/DateTime";
import { clampPercent } from "@t3tools/provider-core/server/usageLimits";
import type { ProviderUsageLimitsReport } from "@t3tools/provider-core/server/snapshot";

import { LATEST_DATE_MS, type MuseSubscriptionUsage } from "./protocol.ts";
import { museUsageLimitResetAt as resetAt } from "@t3tools/plusplus/museUsageLimits";

/**
 * Muse usage facade: refusal detection and reset calculation live in
 * `@t3tools/plusplus/museUsageLimits`; this module binds them to the SDK's
 * usage schema and the protocol's latest representable instant.
 */

const isoMillis = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** Muse's account-wide report as Limits windows, with its tier as the plan. */
export function museUsageToLimits(usage: MuseSubscriptionUsage): ProviderUsageLimitsReport {
  const tier = usage.tier.trim();
  return {
    checkedAt: isoMillis(usage.observedAtMs),
    windows: [
      {
        id: "session",
        kind: "session",
        label: "Session",
        usedPercent: clampPercent(usage.window.usedPercent),
        resetsAt: isoMillis(usage.window.resetsAtMs),
        windowDurationMins: usage.window.windowDurationMins,
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: clampPercent(usage.weekly.usedPercent),
        resetsAt: isoMillis(usage.weekly.resetsAtMs),
        windowDurationMins: 7 * 24 * 60,
      },
    ],
    ...(tier ? { authLabel: tier } : {}),
  };
}

export { isMuseUsageLimitFailure } from "@t3tools/plusplus/museUsageLimits";

export function museUsageLimitResetAt(
  usage: MuseSubscriptionUsage | undefined,
  nowMs: number,
  refusal?: {
    readonly quota?: { readonly resetsAtMs: number } | undefined;
    readonly message?: string | undefined;
  },
): string | null {
  return resetAt(usage, nowMs, refusal, LATEST_DATE_MS);
}
