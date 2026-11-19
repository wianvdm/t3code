import { TOKEN_EFFICIENCY_LINKS } from "@t3tools/plusplus-extensions/tokenEfficiency";

import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Switch } from "../../components/ui/switch";
import {
  useOptionalSettingsScope,
  useSettingsScope,
} from "../../components/settings/SettingsScopeContext";
import {
  useRunScopedPlan,
  useScopedSettingsWriteAllowed,
} from "../../components/settings/useScopedSettings";
import { TokenEfficiencyProvenance } from "./TokenEfficiencyProvenance";
import {
  planTokenEfficiencyPatch,
  tokenEfficiencyEnabled,
  tokenEfficiencyMixed,
} from "./tokenEfficiencySettings.logic";

export function TokenEfficiencySettings() {
  const context = useOptionalSettingsScope();
  if (context === null) return null;
  return <TokenEfficiencySettingsContent />;
}

function TokenEfficiencySettingsContent() {
  const { scope, environments, connectedEnvironments, targets } = useSettingsScope();
  const run = useRunScopedPlan();
  const writeAllowed = useScopedSettingsWriteAllowed();
  const mixed = tokenEfficiencyMixed(targets);
  const enabled = tokenEfficiencyEnabled(targets);

  const scopeSupportsToggle = scope.kind === "project" || scope.kind === "checkout";

  return (
    <SettingsSection id="token-efficiency" title="Agent instructions">
      <SettingsRow
        title="Token efficiency"
        description={
          <>
            Give agents a short checklist for reducing unnecessary context and tool output. Adapted
            from{" "}
            <a
              href={TOKEN_EFFICIENCY_LINKS.repository}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2 hover:text-foreground"
            >
              undefdev/token-efficiency
            </a>
            . Disabled by default.
          </>
        }
        control={
          <Switch
            aria-label="Token efficiency"
            checked={enabled}
            mixed={mixed}
            disabled={!writeAllowed || !scopeSupportsToggle}
            onCheckedChange={(enabled) => {
              if (!scopeSupportsToggle) return;
              const plan = planTokenEfficiencyPatch(scope, environments, enabled);
              run(plan);
            }}
          />
        }
      />
      {scopeSupportsToggle ? (
        <TokenEfficiencyProvenance environments={connectedEnvironments ?? []} />
      ) : null}
    </SettingsSection>
  );
}
