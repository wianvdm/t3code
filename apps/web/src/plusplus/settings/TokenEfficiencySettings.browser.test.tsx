import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import { TOKEN_EFFICIENCY_LINKS } from "@t3tools/plusplus-extensions/tokenEfficiency";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import type {
  useOptionalSettingsScope,
  useSettingsScope,
} from "../../components/settings/SettingsScopeContext";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  scope: null as unknown,
  environments: [] as readonly unknown[],
  connectedEnvironments: [] as readonly unknown[],
  targets: [] as readonly { readonly projectId: ProjectId; readonly settings: ServerSettings }[],
  writeAllowed: true,
  run: vi.fn(),
}));

vi.mock(import("../../components/settings/SettingsScopeContext"), () => ({
  useOptionalSettingsScope: () => state as unknown as ReturnType<typeof useOptionalSettingsScope>,
  useSettingsScope: () => state as unknown as ReturnType<typeof useSettingsScope>,
}));
vi.mock(import("../../components/settings/useScopedSettings"), () => ({
  useRunScopedPlan: () => state.run,
  useScopedSettingsWriteAllowed: () => state.writeAllowed,
}));
vi.mock(import("../../components/settings/settingsLayout"), () => ({
  SettingsSection: ({ children }: { readonly children: ReactNode }) => (
    <section>{children}</section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    readonly title: ReactNode;
    readonly description?: ReactNode;
    readonly control?: ReactNode;
  }) => (
    <div>
      <h2>{title}</h2>
      <p>{description}</p>
      {control}
    </div>
  ),
}));

import { TokenEfficiencySettings } from "./TokenEfficiencySettings";

const environmentId = EnvironmentId.make("test");
const projectId = ProjectId.make("project");

function setup(enabled = false) {
  const settings: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsOverrides: enabled
      ? ({
          [projectId]: { plusplus: { tokenEfficiency: true } },
        } as unknown as ServerSettings["projectSettingsOverrides"])
      : {},
  };
  state.scope = {
    kind: "project",
    members: [{ id: projectId, environmentId }],
  };
  state.environments = [
    {
      environmentId,
      label: "Test",
      connection: { phase: "connected" },
      serverConfig: { settings },
    },
  ];
  state.targets = [{ projectId, settings }];
  state.connectedEnvironments = state.environments;
  state.writeAllowed = true;
  state.run.mockReset();
}

it("renders the required description and repository link", async () => {
  setup();
  await using screen = await render(<TokenEfficiencySettings />);
  expect(screen.container.textContent).toContain(
    "Give agents a short checklist for reducing unnecessary context and tool output. Adapted from undefdev/token-efficiency. Disabled by default.",
  );
  await expect
    .element(screen.getByRole("link", { name: "undefdev/token-efficiency" }))
    .toHaveAttribute("href", TOKEN_EFFICIENCY_LINKS.repository);
});

it("reflects the scoped setting", async () => {
  setup(true);
  await using screen = await render(<TokenEfficiencySettings />);
  await expect.element(screen.getByRole("switch", { name: "Token efficiency" })).toBeChecked();
});

it("shows a mixed group as indeterminate", async () => {
  setup(true);
  state.targets = [
    ...state.targets,
    { projectId: ProjectId.make("other"), settings: DEFAULT_SERVER_SETTINGS },
  ];
  await using screen = await render(<TokenEfficiencySettings />);
  await expect
    .element(screen.getByRole("switch", { name: "Token efficiency" }))
    .toHaveAttribute("aria-checked", "mixed");
});

it("dispatches one grouped write plan when toggled", async () => {
  setup();
  await using screen = await render(<TokenEfficiencySettings />);
  await act(async () => screen.container.querySelector<HTMLElement>('[role="switch"]')?.click());
  expect(state.run).toHaveBeenCalledTimes(1);
  expect(state.run.mock.calls[0]?.[0].serverWrites).toEqual([
    expect.objectContaining({
      environmentId,
      patch: {
        projectSettingsOverrides: {
          [projectId]: { plusplus: { tokenEfficiency: true } },
        },
      },
    }),
  ]);
});

it("disables the switch without settings-write permission", async () => {
  setup();
  state.writeAllowed = false;
  await using screen = await render(<TokenEfficiencySettings />);
  await expect.element(screen.getByRole("switch", { name: "Token efficiency" })).toBeDisabled();
  await act(async () => screen.container.querySelector<HTMLElement>('[role="switch"]')?.click());
  expect(state.run).not.toHaveBeenCalled();
});
