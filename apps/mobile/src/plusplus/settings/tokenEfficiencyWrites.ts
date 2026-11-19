import type { EnvironmentId, ServerSettingsPatch } from "@t3tools/contracts";
import { withProjectTokenEfficiency } from "@t3tools/plusplus-extensions/tokenEfficiency";

import type { ScopedMobileSettingsTarget } from "../../features/settings/settings-scoped-server";

export function planMobileTokenEfficiencyWrites(
  targets: readonly ScopedMobileSettingsTarget[],
  enabled: boolean,
) {
  const writes = new Map<EnvironmentId, Record<string, unknown>>();
  for (const target of targets) {
    if (target.projectId === null) continue;
    const current =
      target.environment.serverConfig.settings.projectSettingsOverrides[target.projectId] ?? {};
    const overrides = writes.get(target.environment.environmentId) ?? {};
    overrides[target.projectId] = withProjectTokenEfficiency(current, enabled);
    writes.set(target.environment.environmentId, overrides);
  }
  return [...writes].map(([environmentId, projectSettingsOverrides]) => ({
    environmentId,
    patch: { projectSettingsOverrides } as ServerSettingsPatch,
  }));
}
