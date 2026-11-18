import type { ProviderDriverKind } from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";
import type { LimitAccount } from "@t3tools/plusplus-extensions/usageReporting";

import { MonetaryUsageAccounts } from "./MonetaryUsage";
import { ModelVendorIcon, usesModelVendorIcon } from "./modelVendorIcon";
import { monetaryUsageOf } from "./monetaryUsage.logic";

function MonetaryRow({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground tabular-nums">{formatUsd(value)}</span>
    </div>
  );
}

export function SegmentMonetaryUsage({ limits }: { readonly limits: LimitAccount["limits"] }) {
  const monetary = monetaryUsageOf(limits);
  if (!monetary) return null;
  return (
    <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
      {monetary.usedUsd !== undefined ? (
        <MonetaryRow label="Used" value={monetary.usedUsd} />
      ) : null}
      {monetary.remainingUsd !== undefined ? (
        <MonetaryRow label="Remaining" value={monetary.remainingUsd} />
      ) : null}
      {monetary.limitUsd !== undefined ? (
        <MonetaryRow label="Limit" value={monetary.limitUsd} />
      ) : null}
    </div>
  );
}

export function PoolWindowLabel({
  driver,
  iconName,
  label,
}: {
  readonly driver: ProviderDriverKind;
  readonly iconName: string;
  readonly label: string;
}) {
  return (
    <span className="flex items-center gap-2 text-sm font-medium text-foreground">
      {usesModelVendorIcon(driver) ? (
        <ModelVendorIcon name={iconName} className="size-4 shrink-0" />
      ) : null}
      {label}
    </span>
  );
}

export function PooledMonetaryUsage(props: Parameters<typeof MonetaryUsageAccounts>[0]) {
  return <MonetaryUsageAccounts {...props} />;
}
