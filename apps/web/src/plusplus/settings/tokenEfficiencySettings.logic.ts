import {
  readProjectTokenEfficiency,
  withProjectTokenEfficiency,
} from "@t3tools/plusplus-extensions/tokenEfficiency";

import {
  projectOverrideWrites,
  type ScopedSettingsTarget,
} from "../../components/settings/scopedSettings";
import type { ResolvedSettingsScope } from "../../components/settings/settingsScope";

type TokenEfficiencyTarget = Pick<ScopedSettingsTarget, "projectId" | "settings">;
type ProjectScope = Extract<ResolvedSettingsScope, { kind: "project" | "checkout" }>;

export function tokenEfficiencyMixed(targets: readonly TokenEfficiencyTarget[]): boolean {
  const first = targets[0];
  return (
    first !== undefined &&
    targets.some(
      (target) =>
        readProjectTokenEfficiency(target.settings, target.projectId) !==
        readProjectTokenEfficiency(first.settings, first.projectId),
    )
  );
}

export function tokenEfficiencyEnabled(targets: readonly TokenEfficiencyTarget[]): boolean {
  return (
    targets.length > 0 &&
    targets.every((target) => readProjectTokenEfficiency(target.settings, target.projectId))
  );
}

export function planTokenEfficiencyPatch(
  scope: ProjectScope,
  environments: Parameters<typeof projectOverrideWrites>[1],
  enabled: boolean,
) {
  const serverWrites = projectOverrideWrites(scope, environments, (current) =>
    withProjectTokenEfficiency(current, enabled),
  );
  return {
    clientPatch: {},
    hasClientWrite: false,
    serverWrites,
    unavailableReason:
      serverWrites.length > 0
        ? null
        : "Connect the selected checkouts, or update their environments, to save a project override.",
  };
}
