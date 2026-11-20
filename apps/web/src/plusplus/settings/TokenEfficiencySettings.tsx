import { TOKEN_EFFICIENCY_LINKS } from "@t3tools/plusplus-extensions/tokenEfficiency";
import { T, useGT, Var } from "gt-react";

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

const TOKEN_EFFICIENCY_REPOSITORY_NAME = "undefdev/token-efficiency";

export function TokenEfficiencySettings() {
  const context = useOptionalSettingsScope();
  if (context === null) return null;
  return <TokenEfficiencySettingsContent />;
}

function TokenEfficiencySettingsContent() {
  const gt = useGT();
  const { scope, environments, connectedEnvironments, targets } = useSettingsScope();
  const run = useRunScopedPlan();
  const writeAllowed = useScopedSettingsWriteAllowed();
  const mixed = tokenEfficiencyMixed(targets);
  const enabled = tokenEfficiencyEnabled(targets);

  const scopeSupportsToggle = scope.kind === "project" || scope.kind === "checkout";

  return (
    <SettingsSection id="token-efficiency" title={gt("Agent instructions")}>
      <SettingsRow
        title={gt("Token efficiency")}
        description={
          <T>
            Give agents a short checklist for reducing unnecessary context and tool output. Adapted
            from{" "}
            <a
              href={TOKEN_EFFICIENCY_LINKS.repository}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2 hover:text-foreground"
            >
              <Var>{TOKEN_EFFICIENCY_REPOSITORY_NAME}</Var>
            </a>
            . Disabled by default.
          </T>
        }
        control={
          <Switch
            aria-label={gt("Token efficiency")}
            checked={enabled}
            mixed={mixed}
            disabled={!writeAllowed || !scopeSupportsToggle}
            onCheckedChange={(enabled) => {
              if (!scopeSupportsToggle) return;
              run(environments, (current) => planTokenEfficiencyPatch(scope, current, enabled));
            }}
          />
        }
      />
      {scopeSupportsToggle ? (
        <TokenEfficiencyProvenance environments={connectedEnvironments} />
      ) : null}
    </SettingsSection>
  );
}
