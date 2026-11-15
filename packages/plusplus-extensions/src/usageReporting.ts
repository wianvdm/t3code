import type {
  EnvironmentId,
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

type SyntheticIdentity = (
  parent: ServerProvider,
  account: UsageLimitSourceAccount,
) => Pick<ServerProvider, "displayName" | "driver">;

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
  identity: Pick<ServerProvider, "displayName" | "driver">,
): ServerProvider {
  const { plusplus: _carrier, usageAccounts: _legacy, ...rest } = parent;
  return {
    ...rest,
    instanceId: `${parent.instanceId}:${account.id}` as ProviderInstanceId,
    ...identity,
    auth: {
      ...parent.auth,
      email: account.email,
      label: account.plan,
      workspaceId: account.workspaceId,
    },
    usageLimits: account.usageLimits,
  };
}

function expandUsageAccounts(providers: readonly ServerProvider[], identity: SyntheticIdentity) {
  const syntheticParents = new Map<string, ProviderInstanceId>();
  const accountsByProvider = providers.map((provider) => readUsageAccounts(provider) ?? []);
  if (accountsByProvider.every((accounts) => accounts.length === 0)) {
    return { providers, syntheticParents };
  }
  const expanded = providers.flatMap((parent, index) => [
    parent,
    ...accountsByProvider[index]!.map((account) => {
      const synthetic = usageAccountProvider(parent, account, identity(parent, account));
      syntheticParents.set(synthetic.instanceId, parent.instanceId);
      return synthetic;
    }),
  ]);
  return { providers: expanded, syntheticParents };
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

function expandPresentations(presentations: LimitPresentations, identity: SyntheticIdentity) {
  const syntheticParents = new Map<string, ProviderInstanceId>();
  const view = mapServerConfigs(presentations, (serverConfig) => {
    const expanded = expandUsageAccounts(serverConfig.providers, identity);
    for (const [id, parentId] of expanded.syntheticParents) syntheticParents.set(id, parentId);
    return { ...serverConfig, providers: expanded.providers };
  });
  return { view, syntheticParents };
}

function withMonetaryPlaceholders(presentations: LimitPresentations): LimitPresentations {
  return mapServerConfigs(presentations, (serverConfig) => ({
    ...serverConfig,
    providers: monetaryProviders(serverConfig.providers),
    usageLimitSources:
      serverConfig.usageLimitSources && monetarySources(serverConfig.usageLimitSources),
  }));
}

// A usage account covers its parent's driver, whatever driver the account itself reports.
const coverageIdentity: SyntheticIdentity = (parent, account) => ({
  displayName: account.id,
  driver: parent.driver,
});

export function hasProviderUsageLimits(
  driver: ServerProvider["driver"],
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): boolean {
  const expanded = expandUsageAccounts(providers, coverageIdentity);
  return upstream.hasProviderUsageLimits(driver, expanded.providers, sources);
}

export function withUsageLimitsCommands(
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): ServerProvider[] {
  const expanded = expandUsageAccounts(providers, coverageIdentity);
  return upstream
    .withUsageLimitsCommands(expanded.providers, sources)
    .filter((provider) => !expanded.syntheticParents.has(provider.instanceId));
}

export function collectExternalUsageLinks(presentations: LimitPresentations) {
  const { view } = expandPresentations(presentations, (parent, account) => ({
    displayName: `${parent.displayName ?? parent.instanceId} · ${accountLabel(account)}`,
    driver: account.driver,
  }));
  return upstream.collectExternalUsageLinks(view);
}

export function collectLimitNotices(presentations: LimitPresentations): readonly string[] {
  const { view } = expandPresentations(presentations, (parent, account) => ({
    displayName: `${parent.displayName?.trim() || String(parent.driver)} · ${accountLabel(account)}`,
    driver: account.driver,
  }));
  return [...new Set(upstream.collectLimitNotices(withMonetaryPlaceholders(view)))];
}

export function collectLimitAccounts(
  presentations: LimitPresentations,
): readonly upstream.LimitAccount[] {
  const expanded = expandPresentations(presentations, (_parent, account) => ({
    displayName: account.email ? "" : accountIdLabel(account.id),
    driver: account.driver,
  }));
  const accounts = upstream.collectLimitAccounts(withMonetaryPlaceholders(expanded.view));
  const nativeRedeem = nativeRedeemOf(presentations, expanded, accounts);
  return accounts.map((account) => ({
    ...account,
    redeem: nativeRedeem(account),
    limits: withoutMonetarySentinel(account.limits),
  }));
}

const usageAccountEnvironment = (instanceId: string) =>
  `plusplus.usage-account:${instanceId}` as EnvironmentId;

// Synthetic ids never leave here. A usage account that won a merged row redeems through the
// native login in that row, whatever provider holds it; reset credits it supplied have no native
// redeem. `natives` is the aggregation without usage accounts, `membership` gives each its own
// environment so its row names it.
function nativeRedeemOf(
  presentations: LimitPresentations,
  expanded: ReturnType<typeof expandPresentations>,
  accounts: readonly upstream.LimitAccount[],
) {
  const syntheticId = (account: upstream.LimitAccount): string | null => {
    const input = account.redeem?.input;
    if (!input || !("instanceId" in input)) return null;
    return expanded.syntheticParents.has(input.instanceId) ? input.instanceId : null;
  };
  const needsNative = accounts.some(
    (account) => syntheticId(account) !== null && !account.limits.resetCredits,
  );
  const natives = needsNative
    ? upstream.collectLimitAccounts(withMonetaryPlaceholders(presentations))
    : [];
  const membership = needsNative
    ? upstream.collectLimitAccounts(
        withMonetaryPlaceholders(withUsageAccountEnvironments(presentations, expanded)),
      )
    : [];
  return (account: upstream.LimitAccount): upstream.LimitAccount["redeem"] => {
    const id = syntheticId(account);
    if (id === null) return account.redeem;
    if (account.limits.resetCredits) return null;
    const environmentId = usageAccountEnvironment(id);
    const row = membership.find((candidate) =>
      candidate.environments.some((environment) => environment.environmentId === environmentId),
    );
    return natives.find((candidate) => candidate.key === row?.key)?.redeem ?? null;
  };
}

function withUsageAccountEnvironments(
  presentations: LimitPresentations,
  expanded: ReturnType<typeof expandPresentations>,
): LimitPresentations {
  const withAccounts = new Map(presentations);
  for (const presentation of expanded.view.values()) {
    for (const provider of presentation.serverConfig?.providers ?? []) {
      if (!expanded.syntheticParents.has(provider.instanceId)) continue;
      withAccounts.set(usageAccountEnvironment(provider.instanceId), {
        entry: presentation.entry,
        serverConfig: { providers: [provider] },
      });
    }
  }
  return withAccounts;
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
  const sourcesWithSentinel = monetarySources(sources);
  const report = upstreamReport(instanceId, monetaryProviders(providers), sourcesWithSentinel, now);
  // The sentinel window makes upstream drop a hub row that shares a login with a monetary-only
  // native one. Hub rows come from a run that leaves those native limits as they are.
  const hubReport = providers.some(
    (provider) => provider.usageLimits && isMonetaryOnlyUsage(provider.usageLimits),
  )
    ? upstreamReport(instanceId, providers, sourcesWithSentinel, now)
    : report;
  const nativeRows = report.accounts.filter((account) => account.instanceId !== undefined);
  const hubRows = hubReport.accounts.filter((account) => account.instanceId === undefined);
  // Usage-account rows follow the native logins, ahead of CLI Proxy rows.
  return {
    ...report,
    accounts: [...nativeRows, ...usageAccountRows(providers, selected.driver), ...hubRows].map(
      (account) => ({ ...account, limits: withoutMonetarySentinel(account.limits) }),
    ),
  };
}

// Upstream finds no coverage when the selected driver reports only usage accounts.
function upstreamReport(
  instanceId: ProviderInstanceId,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): UsageLimitsReport {
  return (
    upstream.collectProviderUsageLimits(instanceId, providers, sources, now) ?? {
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      accounts: [],
      notices: [],
    }
  );
}
