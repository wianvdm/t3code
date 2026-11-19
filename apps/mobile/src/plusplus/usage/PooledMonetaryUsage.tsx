import type { ServerProvider } from "@t3tools/contracts";
import {
  displayLimitWindows,
  readMonetaryUsage,
  type LimitAccount,
  type LimitPool,
} from "@t3tools/plusplus-extensions/usageReporting";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { monetaryUsageText } from "./monetaryUsageText";

export function AccountMonetaryUsage({
  limits,
}: {
  readonly limits: NonNullable<ServerProvider["usageLimits"]>;
}) {
  const text = monetaryUsageText(readMonetaryUsage(limits));
  return text ? (
    <Text className="text-xs tabular-nums text-foreground-tertiary">{text}</Text>
  ) : null;
}

export function hasDisplayableLimits(pool: LimitPool) {
  return (
    displayLimitWindows(pool).length > 0 ||
    pool.accounts.some((account) => monetaryUsageText(readMonetaryUsage(account.limits)) !== null)
  );
}

export function PoolMonetaryAccounts({
  pool,
  accountName,
}: {
  readonly pool: LimitPool;
  readonly accountName: (account: LimitAccount) => string;
}) {
  const rows = pool.accounts.flatMap((account) => {
    const text = monetaryUsageText(readMonetaryUsage(account.limits));
    return text !== null ? [{ account, text }] : [];
  });
  if (rows.length === 0) return null;
  return (
    <View className="gap-2 rounded-[24px] border-continuous bg-grouped-card p-4">
      {rows.map(({ account, text }) => (
        <View key={account.key} className="flex-row items-baseline justify-between gap-3">
          <Text numberOfLines={1} className="min-w-0 shrink text-sm font-t3-medium text-foreground">
            {accountName(account)}
          </Text>
          <Text className="shrink-0 text-sm tabular-nums text-foreground-muted">{text}</Text>
        </View>
      ))}
    </View>
  );
}
