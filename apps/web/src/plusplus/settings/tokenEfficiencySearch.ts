import type { SettingsSearchItem } from "../../components/settings/settingsSearch";

export const TOKEN_EFFICIENCY_SETTINGS_SEARCH_ITEMS = [
  {
    id: "token-efficiency",
    title: "Token efficiency",
    to: "/settings/projects",
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
