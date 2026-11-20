import { AuthSettingsWriteScope } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { TOKEN_EFFICIENCY_LINKS } from "@t3tools/plusplus-extensions/tokenEfficiency";
import { T, useGT, Var } from "gt-react-native";
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

const TOKEN_EFFICIENCY_REPOSITORY_NAME = "undefdev/token-efficiency";

export function TokenEfficiencySection(props: {
  readonly members: readonly EnvironmentProject[];
  readonly environments: readonly SettingsTarget[];
}) {
  const gt = useGT();
  const targets = resolveMobileSettingsTargets(props.environments, props.members);
  const writableEnvironments = useEnvironmentsWithScope(props.environments, AuthSettingsWriteScope);
  const canWrite =
    targets.length > 0 &&
    targets.every((target) => writableEnvironments.has(target.environment.environmentId));
  const enabled = readMobileTokenEfficiencyState(targets);
  const writeSettings = useSettingsWriter();

  return (
    <SettingsSection title={gt("Agent instructions")}>
      <SettingsSwitchRow
        label={gt("Token efficiency")}
        value={enabled}
        disabled={!canWrite}
        onValueChange={(enabled) => {
          void writeSettings(targets, planMobileTokenEfficiencyWrites(targets, enabled));
        }}
        meta={
          <View className="pt-1">
            <Text textRole="footnote" className="text-foreground-muted">
              <T>
                Give agents a short checklist for reducing unnecessary context and tool output.
                Adapted from{" "}
                <Text
                  accessibilityRole="link"
                  className="text-foreground underline"
                  onPress={() =>
                    void Linking.openURL(TOKEN_EFFICIENCY_LINKS.repository).catch(() => undefined)
                  }
                >
                  <Var>{TOKEN_EFFICIENCY_REPOSITORY_NAME}</Var>
                </Text>
                . Disabled by default.
              </T>
            </Text>
          </View>
        }
      />
      <TokenEfficiencyProvenance environments={targets.map((target) => target.environment)} />
    </SettingsSection>
  );
}
