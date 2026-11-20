import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { readContextBridgeSettings } from "@t3tools/shared/serverSettings";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import {
  buildDefaultSourceOptions,
  buildRouteOptions,
  computeNextRoutes,
  deriveAvailableDrivers,
  resolveDriverLabel,
  resolveOptionLabel,
  supportsContextBridgeHooks,
  supportsContextBridgeSkills,
  type ContextBridgeFeature,
} from "./contextBridgeSettings.logic";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { useSearchableSetting } from "~/components/settings/settingsSearch";

function useAvailableBridgeDrivers(environmentId: EnvironmentId) {
  const serverProviders = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  return deriveAvailableDrivers(deriveProviderInstanceEntries(serverProviders));
}

export function ContextBridgeSettingsSection({
  environmentId,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly?: boolean;
}) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const availableDrivers = useAvailableBridgeDrivers(environmentId);

  const contextBridge = readContextBridgeSettings(settings);
  const defaultSource = contextBridge.defaultSource || "claudeAgent";
  const defaultSourceOptions = buildDefaultSourceOptions(defaultSource, availableDrivers);

  return (
    <SettingsSection {...searchableSetting("context-bridge")}>
      <SettingsRow
        {...searchableSetting("context-bridge-enabled")}
        description={gt("Providers can use another provider's instructions and skills.")}
        control={
          <span inert={readOnly} className={readOnly ? "opacity-50" : undefined}>
            <Switch
              checked={contextBridge.enabled}
              onCheckedChange={(enabled) => updateSettings({ contextBridge: { enabled } })}
              aria-label={gt("Enable context bridge")}
            />
          </span>
        }
      />
      <SettingsRow
        {...searchableSetting("context-bridge-default-source")}
        description={gt("Fallback source when a route is set to Default.")}
        control={
          <Select
            value={defaultSource}
            onValueChange={(nextSource) => {
              if (nextSource) updateSettings({ contextBridge: { defaultSource: nextSource } });
            }}
            disabled={!contextBridge.enabled || readOnly}
          >
            <SelectTrigger size="sm" className="w-48" aria-label={gt("Default context source")}>
              <SelectValue>{resolveDriverLabel(defaultSource, availableDrivers)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {defaultSourceOptions.map(({ driver, label }) => (
                <SelectItem key={driver} value={driver}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}

const BRIDGE_FEATURE_ROWS = [
  {
    feature: "instructions",
    title: msg("Instructions"),
    description: msg("Where {provider} loads instructions from when the context bridge is on."),
  },
  {
    feature: "skills",
    title: msg("Skills"),
    description: msg("Where {provider} loads skills from when the context bridge is on."),
  },
  {
    feature: "hooks",
    title: msg("Hooks"),
    description: msg("Where {provider} loads hooks from when the context bridge is on."),
  },
] as const satisfies ReadonlyArray<{
  feature: ContextBridgeFeature;
  title: string;
  description: string;
}>;

export function ProviderContextBridgeSection({
  environmentId,
  driver,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly driver: string;
  readonly readOnly?: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const availableDrivers = useAvailableBridgeDrivers(environmentId);

  const contextBridge = readContextBridgeSettings(settings);
  const route = contextBridge.routes[driver];
  const routeOptions = buildRouteOptions(driver, contextBridge.defaultSource, availableDrivers, m);

  return (
    <SettingsSection
      title={gt("Context", { $context: "settings section for instruction and skill sources" })}
      inert={readOnly}
      aria-disabled={readOnly || undefined}
      className={readOnly ? "opacity-50 select-none" : undefined}
    >
      {BRIDGE_FEATURE_ROWS.map(({ feature, title: featureTitle, description }) => {
        const title = m(featureTitle);
        const value = route?.[feature] ?? "native";
        const unsupported =
          (feature === "hooks" && !supportsContextBridgeHooks(driver)) ||
          (feature === "skills" && !supportsContextBridgeSkills(driver));
        return (
          <SettingsRow
            key={feature}
            title={title}
            description={m(description, { provider: resolveDriverLabel(driver, availableDrivers) })}
            control={
              <Select
                value={value}
                onValueChange={(nextValue) => {
                  if (!nextValue || unsupported) return;
                  updateSettings({
                    contextBridge: {
                      routes: computeNextRoutes(contextBridge.routes, driver, feature, nextValue),
                    },
                  });
                }}
                disabled={!contextBridge.enabled || unsupported}
              >
                <SelectTrigger size="sm" aria-label={gt("{feature} source", { feature: title })}>
                  <SelectValue>
                    {unsupported ? gt("Not supported") : resolveOptionLabel(routeOptions, value)}
                  </SelectValue>
                </SelectTrigger>
                {!unsupported && (
                  <SelectPopup>
                    {routeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                )}
              </Select>
            }
          />
        );
      })}
    </SettingsSection>
  );
}
