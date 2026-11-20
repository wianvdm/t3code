import type { ServerProviderMonetaryUsage } from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

export function monetaryUsageText(
  monetary: ServerProviderMonetaryUsage | undefined,
  resolve: MessageResolver = m,
): string | null {
  if (!monetary) return null;
  const text = [
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
  return text === "" ? null : text;
}
