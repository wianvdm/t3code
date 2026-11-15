import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { readMonetaryUsage } from "@t3tools/plusplus/contracts";
import { limitsNotice as upstreamLimitsNotice } from "@t3tools/shared/usageLimits";

/** Upstream reports "No limits reported." for limits that carry only monetary usage. */
export function isMonetaryOnlyUsage(limits: ServerProviderUsageLimits): boolean {
  if (limits.windows.length > 0 || limits.unavailable !== undefined) return false;
  const monetary = readMonetaryUsage(limits);
  return monetary !== undefined && Object.values(monetary).some((value) => value !== undefined);
}

export function limitsNotice(limits: ServerProviderUsageLimits): string | null {
  return isMonetaryOnlyUsage(limits) ? null : upstreamLimitsNotice(limits);
}
