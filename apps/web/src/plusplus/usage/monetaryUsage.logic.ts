import { formatUsd } from "@t3tools/shared/usageFormat";
import { readMonetaryUsage, type LimitAccount } from "@t3tools/plusplus-extensions/usageReporting";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

export type MonetaryUsage = NonNullable<LimitAccount["limits"]["monetaryUsage"]>;

export function monetaryUsageOf(limits: LimitAccount["limits"]): MonetaryUsage | null {
  const monetary = readMonetaryUsage(limits);
  if (!monetary) return null;
  const { usedUsd, remainingUsd, limitUsd } = monetary;
  return usedUsd === undefined && remainingUsd === undefined && limitUsd === undefined
    ? null
    : monetary;
}

export function monetaryUsageText(monetary: MonetaryUsage, resolve: MessageResolver = m): string {
  return [
    monetary.usedUsd !== undefined
      ? resolve(msg("{amount} used"), { amount: formatUsd(monetary.usedUsd) })
      : null,
    monetary.remainingUsd !== undefined
      ? resolve(msg("{amount} left"), { amount: formatUsd(monetary.remainingUsd) })
      : null,
    monetary.limitUsd !== undefined
      ? resolve(msg("{amount} limit"), { amount: formatUsd(monetary.limitUsd) })
      : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}
