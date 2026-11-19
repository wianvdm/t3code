import type { ServerProviderMonetaryUsage } from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";

export function monetaryUsageText(
  monetary: ServerProviderMonetaryUsage | undefined,
): string | null {
  if (!monetary) return null;
  const text = [
    monetary.usedUsd !== undefined ? `${formatUsd(monetary.usedUsd)} used` : null,
    monetary.remainingUsd !== undefined ? `${formatUsd(monetary.remainingUsd)} left` : null,
    monetary.limitUsd !== undefined ? `${formatUsd(monetary.limitUsd)} limit` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return text === "" ? null : text;
}
