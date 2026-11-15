import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  UsageLimitSourceAccount,
  UsageLimitSourceSnapshots,
  UsageLimitsReport,
} from "@t3tools/contracts";
import { isProviderAvailable } from "@t3tools/contracts";
import { readUsageAccounts } from "@t3tools/plusplus/contracts";
import * as upstream from "@t3tools/shared/usageLimits";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";

import { isMonetaryOnlyUsage, limitsNotice } from "./usageLimits.ts";

/**
 * ++ face of `@t3tools/shared/usageLimits`. Upstream's aggregation sees usage accounts as
 * synthetic providers and monetary-only limits as one placeholder window; neither leaves here.
 */

export * from "@t3tools/shared/usageLimits";
export { readMonetaryUsage } from "@t3tools/plusplus/contracts";
export { limitsNotice };

const MONETARY_ONLY_WINDOW: ServerProviderUsageWindow = {
  id: "plusplus.monetary-only",
  kind: "other",
  label: "Monetary usage",
  usedPercent: 0,
};

type ServerConfig = NonNullable<NonNullable<ReturnType<LimitPresentations["get"]>>["serverConfig"]>;

type SyntheticName = (parent: ServerProvider, account: UsageLimitSourceAccount) => string;

// Upstream account ids are credential file names, so the `.json` suffix is not part of the name.
function accountIdLabel(id: string): string {
  return id.replace(/\.json$/i, "");
}

function accountLabel(account: UsageLimitSourceAccount): string {
  return account.email?.trim() || accountIdLabel(account.id);
}

// Synthetic instance ids contain `:`, which the ProviderInstanceId schema forbids. They are
// only ever read by upstream's aggregation and never decoded or returned.
function usageAccountProvider(
  parent: ServerProvider,
  account: UsageLimitSourceAccount,
  displayName: string,
): ServerProvider {
  const { plusplus: _carrier, usageAccounts: _legacy, ...rest } = parent;
  return {
    ...rest,
    instanceId: `${parent.instanceId}:${account.id}` as ProviderInstanceId,
    driver: account.driver,
    displayName,
    auth: {
      ...parent.auth,
      email: account.email,
      label: account.plan,
      workspaceId: account.workspaceId,
    },
    usageLimits: account.usageLimits,
  };
}

function expandUsageAccounts(providers: readonly ServerProvider[], name: SyntheticName) {
  const syntheticIds = new Set<string>();
  const accountsByProvider = providers.map((provider) => readUsageAccounts(provider) ?? []);
  if (accountsByProvider.every((accounts) => accounts.length === 0)) {
    return { providers, syntheticIds };
  }
  const expanded = providers.flatMap((parent, index) => [
    parent,
    ...accountsByProvider[index]!.map((account) => {
      const synthetic = usageAccountProvider(parent, account, name(parent, account));
      syntheticIds.add(synthetic.instanceId);
      return synthetic;
    }),
  ]);
  return { providers: expanded, syntheticIds };
}

function withMonetarySentinel(limits: ServerProviderUsageLimits): ServerProviderUsageLimits {
  return isMonetaryOnlyUsage(limits) ? { ...limits, windows: [MONETARY_ONLY_WINDOW] } : limits;
}

function withoutMonetarySentinel(limits: ServerProviderUsageLimits): ServerProviderUsageLimits {
  return limits.windows.includes(MONETARY_ONLY_WINDOW)
    ? { ...limits, windows: limits.windows.filter((window) => window !== MONETARY_ONLY_WINDOW) }
    : limits;
}

function monetaryProviders(providers: readonly ServerProvider[]): readonly ServerProvider[] {
  return providers.map((provider) => {
    const limits = provider.usageLimits && withMonetarySentinel(provider.usageLimits);
    return limits === provider.usageLimits ? provider : { ...provider, usageLimits: limits };
  });
}

function monetarySources(sources: UsageLimitSourceSnapshots): UsageLimitSourceSnapshots {
  return sources.map((source) =>
    source.accounts.some((account) => isMonetaryOnlyUsage(account.usageLimits))
      ? {
          ...source,
          accounts: source.accounts.map((account) => ({
            ...account,
            usageLimits: withMonetarySentinel(account.usageLimits),
          })),
        }
      : source,
  );
}

function mapServerConfigs(
  presentations: LimitPresentations,
  update: (serverConfig: ServerConfig) => ServerConfig,
): LimitPresentations {
  return new Map(
    [...presentations].map(([environmentId, presentation]) => [
      environmentId,
      presentation.serverConfig
        ? { ...presentation, serverConfig: update(presentation.serverConfig) }
        : presentation,
    ]),
  );
}

function expandPresentations(presentations: LimitPresentations, name: SyntheticName) {
  const syntheticIds = new Set<string>();
  const view = mapServerConfigs(presentations, (serverConfig) => {
    const expanded = expandUsageAccounts(serverConfig.providers, name);
    for (const id of expanded.syntheticIds) syntheticIds.add(id);
    return { ...serverConfig, providers: expanded.providers };
  });
  return { view, syntheticIds };
}

function withMonetaryPlaceholders(presentations: LimitPresentations): LimitPresentations {
  return mapServerConfigs(presentations, (serverConfig) => ({
    ...serverConfig,
    providers: monetaryProviders(serverConfig.providers),
    usageLimitSources:
      serverConfig.usageLimitSources && monetarySources(serverConfig.usageLimitSources),
  }));
}

export function hasProviderUsageLimits(
  driver: ServerProvider["driver"],
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): boolean {
  const expanded = expandUsageAccounts(providers, (_parent, account) => account.id);
  return upstream.hasProviderUsageLimits(driver, expanded.providers, sources);
}

export function withUsageLimitsCommands(
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): ServerProvider[] {
  const expanded = expandUsageAccounts(providers, (_parent, account) => account.id);
  return upstream
    .withUsageLimitsCommands(expanded.providers, sources)
    .filter((provider) => !expanded.syntheticIds.has(provider.instanceId));
}

export function collectExternalUsageLinks(presentations: LimitPresentations) {
  const { view } = expandPresentations(
    presentations,
    (parent, account) => `${parent.displayName ?? parent.instanceId} · ${accountLabel(account)}`,
  );
  return upstream.collectExternalUsageLinks(view);
}

export function collectLimitNotices(presentations: LimitPresentations): readonly string[] {
  const { view } = expandPresentations(
    presentations,
    (parent, account) =>
      `${parent.displayName?.trim() || String(parent.driver)} · ${accountLabel(account)}`,
  );
  return [...new Set(upstream.collectLimitNotices(withMonetaryPlaceholders(view)))];
}

export function collectLimitAccounts(
  presentations: LimitPresentations,
): readonly upstream.LimitAccount[] {
  const { view, syntheticIds } = expandPresentations(presentations, (_parent, account) =>
    account.email ? "" : accountIdLabel(account.id),
  );
  return upstream.collectLimitAccounts(withMonetaryPlaceholders(view)).map((account) => ({
    ...account,
    redeem:
      account.redeem &&
      "instanceId" in account.redeem.input &&
      syntheticIds.has(account.redeem.input.instanceId)
        ? null
        : account.redeem,
    limits: withoutMonetarySentinel(account.limits),
  }));
}

function usageAccountRows(
  providers: readonly ServerProvider[],
  driver: ServerProvider["driver"],
): Array<UsageLimitsReport["accounts"][number]> {
  return providers
    .filter(
      (provider) =>
        provider.driver === driver &&
        provider.enabled &&
        provider.installed &&
        isProviderAvailable(provider),
    )
    .flatMap((provider) => {
      const providerLabel = provider.displayName?.trim() || String(provider.instanceId);
      return (readUsageAccounts(provider) ?? [])
        .filter((account) => limitsNotice(account.usageLimits) === null)
        .map((account) => ({
          id: `${provider.instanceId}:${account.id}`,
          driver: account.driver,
          label: `${providerLabel} · ${account.id}`,
          sourceLabel: providerLabel,
          ...(account.plan ? { plan: account.plan } : {}),
          ...(account.email ? { email: account.email } : {}),
          ...(provider.accentColor ? { accentColor: provider.accentColor } : {}),
          limits: account.usageLimits,
        }));
    });
}

export function collectProviderUsageLimits(
  instanceId: ProviderInstanceId,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): UsageLimitsReport | null {
  const selected = providers.find((provider) => provider.instanceId === instanceId);
  if (!selected || !hasProviderUsageLimits(selected.driver, providers, sources)) return null;
  // Upstream finds no coverage when the selected driver reports only usage accounts.
  const report = upstream.collectProviderUsageLimits(
    instanceId,
    monetaryProviders(providers),
    monetarySources(sources),
    now,
  ) ?? { createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)), accounts: [], notices: [] };
  const accounts = report.accounts.map((account) => ({
    ...account,
    limits: withoutMonetarySentinel(account.limits),
  }));
  // Usage-account rows follow the native logins, ahead of CLI Proxy rows.
  const nativeCount = accounts.findLastIndex((account) => account.instanceId !== undefined) + 1;
  return {
    ...report,
    accounts: [
      ...accounts.slice(0, nativeCount),
      ...usageAccountRows(providers, selected.driver),
      ...accounts.slice(nativeCount),
    ],
  };
}
