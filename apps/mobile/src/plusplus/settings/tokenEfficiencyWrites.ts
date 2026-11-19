import type { EnvironmentId, ServerSettingsPatch } from "@t3tools/contracts";
import {
  readProjectTokenEfficiency,
  withProjectTokenEfficiency,
} from "@t3tools/plusplus-extensions/tokenEfficiency";

import type { ScopedMobileSettingsTarget } from "../../features/settings/settings-scoped-server";

/** Null when the selected targets disagree, so the switch renders mixed. */
export function readMobileTokenEfficiencyState(
  targets: readonly ScopedMobileSettingsTarget[],
): boolean | null {
  const [firstTarget, ...rest] = targets;
  if (firstTarget === undefined) return false;
  const read = (target: ScopedMobileSettingsTarget) =>
    readProjectTokenEfficiency(target.environment.serverConfig.settings, target.projectId);
  const first = read(firstTarget);
  if (rest.some((target) => read(target) !== first)) return null;
  return first;
}

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
