import { AuthSettingsWriteScope } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { TOKEN_EFFICIENCY_LINKS } from "@t3tools/plusplus-extensions/tokenEfficiency";
import { Linking, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { SettingsSwitchRow } from "../../features/settings/components/SettingsSwitchRow";
import type { SettingsTarget } from "../../features/settings/settings-environment-filter";
import { resolveMobileSettingsTargets } from "../../features/settings/settings-scoped-server";
import { useSettingsWriter } from "../../features/settings/useSettingsWriter";
import { useEnvironmentsWithScope } from "../../state/session";
import { TokenEfficiencyProvenance } from "./TokenEfficiencyProvenance";
import {
  planMobileTokenEfficiencyWrites,
  readMobileTokenEfficiencyState,
} from "./tokenEfficiencyWrites";

export function TokenEfficiencySection(props: {
  readonly members: readonly EnvironmentProject[];
  readonly environments: readonly SettingsTarget[];
}) {
  const targets = resolveMobileSettingsTargets(props.environments, props.members);
  const writableEnvironments = useEnvironmentsWithScope(props.environments, AuthSettingsWriteScope);
  const canWrite =
    targets.length > 0 &&
    targets.every((target) => writableEnvironments.has(target.environment.environmentId));
  const enabled = readMobileTokenEfficiencyState(targets);
  const writeSettings = useSettingsWriter();

  return (
    <SettingsSection title="Agent instructions">
      <SettingsSwitchRow
        label="Token efficiency"
        value={enabled}
        disabled={!canWrite}
        onValueChange={(enabled) => {
          void writeSettings(targets, planMobileTokenEfficiencyWrites(targets, enabled));
        }}
        meta={
          <View className="pt-1">
            <Text textRole="footnote" className="text-foreground-muted">
              Give agents a short checklist for reducing unnecessary context and tool output.{" "}
              Adapted from{" "}
              <Text
                accessibilityRole="link"
                className="text-foreground underline"
                onPress={() =>
                  void Linking.openURL(TOKEN_EFFICIENCY_LINKS.repository).catch(() => undefined)
                }
              >
                undefdev/token-efficiency
              </Text>
              . Disabled by default.
            </Text>
          </View>
        }
      />
      <TokenEfficiencyProvenance environments={targets.map((target) => target.environment)} />
    </SettingsSection>
  );
}
