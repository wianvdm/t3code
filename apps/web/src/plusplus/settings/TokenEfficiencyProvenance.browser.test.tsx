import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import type {
  TokenEfficiencyRefreshResult,
  TokenEfficiencyView,
} from "@t3tools/contracts/plusplus/tokenEfficiency";
import {
  ATTRIBUTION_TEXT,
  TOKEN_EFFICIENCY_LINKS,
} from "@t3tools/plusplus-extensions/tokenEfficiency";
import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type {
  useOptionalSettingsScope,
  useSettingsScope,
} from "../../components/settings/SettingsScopeContext";
import { render } from "../../../test/render";

const environmentId = EnvironmentId.make("test");
const secondaryEnvironmentId = EnvironmentId.make("stock");
const projectId = ProjectId.make("project");
const checkedAt = DateTime.makeUnsafe("2026-11-19T12:00:00.000Z");

const bundledView: TokenEfficiencyView = {
  status: {
    active: {
      source: "bundled",
      blobSha: "416ae435f8488d114752fe35da16c45488cadd44",
      adaptationVersion: 1,
      upstreamCommit: "8dc98e1c70ebe395c31b2a16c9376ca7e4071ba7",
    },
    lastSuccessfulCheckAt: checkedAt,
    lastAttemptAt: checkedAt,
    lastFailure: null,
    refreshing: false,
    automaticRefresh: false,
  },
  instructions: "<token_efficiency>\nRules.\n</token_efficiency>",
};
const upstreamView: TokenEfficiencyView = {
  ...bundledView,
  status: {
    ...bundledView.status,
    active: {
      source: "upstream",
      blobSha: "416ae435f8488d114752fe35da16c45488cadd44",
      adaptationVersion: 1,
      fetchedAt: checkedAt,
    },
    automaticRefresh: true,
  },
};
const failedView: TokenEfficiencyView = {
  ...upstreamView,
  status: {
    ...upstreamView.status,
    lastFailure: { at: checkedAt, reason: "rate-limited" },
  },
};

const viewResult = Atom.make<AsyncResult.AsyncResult<TokenEfficiencyView, unknown>>(
  AsyncResult.initial(),
);
const secondaryViewResult = Atom.make<AsyncResult.AsyncResult<TokenEfficiencyView, unknown>>(
  AsyncResult.initial(),
);
const refreshAllowed = Atom.make(true);

const state = vi.hoisted(() => ({
  scope: null as unknown,
  environments: [] as readonly unknown[],
  connectedEnvironments: [] as readonly unknown[],
  targets: [] as readonly { readonly projectId: ProjectId; readonly settings: ServerSettings }[],
  writeAllowed: true,
  run: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock(import("../../components/settings/SettingsScopeContext"), () => ({
  useOptionalSettingsScope: () => state as unknown as ReturnType<typeof useOptionalSettingsScope>,
  useSettingsScope: () => state as unknown as ReturnType<typeof useSettingsScope>,
}));
vi.mock(import("../../components/settings/useScopedSettings"), () => ({
  useRunScopedPlan: () => state.run,
  useScopedSettingsWriteAllowed: () => state.writeAllowed,
}));
vi.mock(import("../state/tokenEfficiency"), () => ({
  tokenEfficiencyView: ((target: { readonly environmentId: EnvironmentId }) =>
    target.environmentId === secondaryEnvironmentId ? secondaryViewResult : viewResult) as never,
  refreshTokenEfficiency: { permissionAtom: () => refreshAllowed } as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: () => state.refresh,
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

function settings(enabled: boolean): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsOverrides: enabled
      ? ({
          [projectId]: { plusplus: { tokenEfficiency: true } },
        } as unknown as ServerSettings["projectSettingsOverrides"])
      : {},
  };
}

function setup(
  options: {
    readonly view?: AsyncResult.AsyncResult<TokenEfficiencyView, unknown>;
    readonly secondaryView?: AsyncResult.AsyncResult<TokenEfficiencyView, unknown>;
    readonly secondary?: boolean;
    readonly canRefresh?: boolean;
    readonly enabled?: boolean;
    readonly refreshResult?: TokenEfficiencyRefreshResult | undefined;
    readonly refreshFailure?: string | undefined;
  } = {},
) {
  const serverSettings = settings(options.enabled ?? false);
  const environments = [
    {
      environmentId,
      label: "Test",
      connection: { phase: "connected" },
      serverConfig: { settings: serverSettings },
    },
    ...(options.secondary
      ? [
          {
            environmentId: secondaryEnvironmentId,
            label: "Stock",
            connection: { phase: "connected" },
            serverConfig: { settings: serverSettings },
          },
        ]
      : []),
  ];
  state.scope = {
    kind: "project",
    members: environments.map((environment) => ({
      id: projectId,
      environmentId: environment.environmentId,
    })),
  };
  state.environments = environments;
  state.connectedEnvironments = environments;
  state.targets = environments.map(() => ({ projectId, settings: serverSettings }));
  state.writeAllowed = true;
  state.run.mockReset();
  state.refresh.mockReset();
  state.refresh.mockResolvedValue(
    options.refreshFailure === undefined
      ? AsyncResult.success(options.refreshResult ?? { outcome: "unchanged", view: bundledView })
      : AsyncResult.failure(Cause.fail(new Error(options.refreshFailure))),
  );
  const registry = AtomRegistry.make();
  registry.set(viewResult, options.view ?? AsyncResult.success(bundledView));
  registry.set(
    secondaryViewResult,
    options.secondaryView ?? options.view ?? AsyncResult.success(bundledView),
  );
  registry.set(refreshAllowed, options.canRefresh ?? true);
  return registry;
}

function panel(registry: AtomRegistry.AtomRegistry) {
  return (
    <RegistryContext.Provider value={registry}>
      <TokenEfficiencySettings />
    </RegistryContext.Provider>
  );
}

function disposableRegistry(registry: AtomRegistry.AtomRegistry): Disposable {
  return { [Symbol.dispose]: () => registry.dispose() };
}

it("shows a loading state while the owning environment responds", async () => {
  const registry = setup({ view: AsyncResult.initial() });
  using _registry = disposableRegistry(registry);
  await using screen = await render(panel(registry));
  await expect
    .element(screen.getByText("Loading token-efficiency provenance on Test…"))
    .toBeInTheDocument();
});

it.each([
  { source: "bundled", view: bundledView, label: "Bundled fallback" },
  { source: "upstream", view: upstreamView, label: "Cached upstream" },
] as const)(
  "shows $source provenance, revision and last successful check",
  async ({ view, label }) => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T13:00:00.000Z"));
    const registry = setup({ view: AsyncResult.success(view) });
    using _registry = disposableRegistry(registry);
    await using screen = await render(panel(registry));
    await expect.element(screen.getByText(new RegExp(label))).toBeInTheDocument();
    await expect.element(screen.getByText(/Revision 416ae43/)).toBeInTheDocument();
    await expect.element(screen.getByText("Last successful check: 1h ago")).toBeInTheDocument();
  },
);

it.each([
  {
    name: "unsupported stock server",
    cause: Cause.die("Unknown request tag: plusplus.tokenEfficiency.view"),
    label: "Not supported on Stock",
  },
  {
    name: "unavailable environment",
    cause: Cause.fail(new Error("This connection requires orchestration:read.")),
    label: "Unavailable on Stock",
  },
] as const)("labels an $name", async ({ cause, label }) => {
  const registry = setup({
    secondary: true,
    secondaryView: AsyncResult.failure(cause),
  });
  using _registry = disposableRegistry(registry);
  await using screen = await render(panel(registry));
  await expect.element(screen.getByRole("heading", { name: "Test" })).toBeInTheDocument();
  await expect.element(screen.getByText(label)).toBeInTheDocument();
});

it.each([
  {
    name: "updated",
    outcome: "updated",
    view: upstreamView,
    message: "Refresh updated. Cached upstream revision 416ae43 is active.",
  },
  {
    name: "unchanged",
    outcome: "unchanged",
    view: upstreamView,
    message: "Refresh unchanged. Cached upstream revision 416ae43 stays active.",
  },
  {
    name: "failed",
    outcome: "failed",
    view: failedView,
    message: "Refresh failed (rate limited). Cached upstream revision 416ae43 stays active.",
  },
  {
    name: "transport failure",
    requestFailure: "Test is not connected.",
    view: upstreamView,
    message:
      "Refresh failed. Test is not connected. Cached upstream revision 416ae43 stays active.",
  },
] as const)("reports a $name refresh", async (row) => {
  const registry = setup({
    view: AsyncResult.success(
      "outcome" in row && row.outcome === "failed" ? upstreamView : row.view,
    ),
    ...("outcome" in row ? { refreshResult: { outcome: row.outcome!, view: row.view } } : {}),
    ...("requestFailure" in row ? { refreshFailure: row.requestFailure } : {}),
  });
  using _registry = disposableRegistry(registry);
  await using screen = await render(panel(registry));
  if (!("outcome" in row) || row.outcome === "failed") {
    await expect.element(screen.getByText(row.message)).not.toBeInTheDocument();
  }
  await userEvent.click(screen.getByRole("button", { name: "Refresh now" }));
  await expect.element(screen.getByText(row.message)).toBeInTheDocument();
  expect(state.refresh).toHaveBeenCalledExactlyOnceWith({ environmentId, input: {} });
});

it("disables refresh without destination settings-write authority", async () => {
  const registry = setup({ canRefresh: false });
  using _registry = disposableRegistry(registry);
  await using screen = await render(panel(registry));
  await expect.element(screen.getByRole("button", { name: "Refresh now" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Refresh now" }), { force: true });
  expect(state.refresh).not.toHaveBeenCalled();
});

it("keeps refresh available during a server refresh", async () => {
  const refreshingView = {
    ...bundledView,
    status: { ...bundledView.status, refreshing: true },
  };
  const registry = setup({ view: AsyncResult.success(refreshingView) });
  using _registry = disposableRegistry(registry);
  await using screen = await render(panel(registry));
  await expect.element(screen.getByRole("button", { name: "Refresh now" })).toBeEnabled();
});

it("shows exact instructions as plain text with every attribution link", async () => {
  const instructions =
    "<token_efficiency>\n**Keep Markdown literal** <img src=x onerror=alert(1)>\n</token_efficiency>";
  const view = { ...upstreamView, instructions };
  const registry = setup({ view: AsyncResult.success(view) });
  using _registry = disposableRegistry(registry);
  await using screen = await render(panel(registry));
  await userEvent.click(screen.getByRole("button", { name: "View instructions" }));
  await expect.element(page.getByRole("dialog")).toBeVisible();
  const popup = document.querySelector('[data-slot="dialog-popup"]');
  expect(popup?.querySelector("pre")?.textContent).toBe(instructions);
  expect(popup?.textContent).toContain(ATTRIBUTION_TEXT);
  expect(popup?.querySelector("img, textarea, input")).toBeNull();
  for (const [name, href] of [
    ["Upstream CORE", TOKEN_EFFICIENCY_LINKS.core],
    ["Repository", TOKEN_EFFICIENCY_LINKS.repository],
    ["Full playbook", TOKEN_EFFICIENCY_LINKS.fullPlaybook],
    ["MIT license", TOKEN_EFFICIENCY_LINKS.license],
  ] as const) {
    await expect.element(page.getByRole("link", { name })).toHaveAttribute("href", href);
  }
});

it("refreshes a disabled project without enabling delivery", async () => {
  const registry = setup({
    enabled: false,
    refreshResult: { outcome: "updated", view: upstreamView },
  });
  using _registry = disposableRegistry(registry);
  await using screen = await render(panel(registry));
  const toggle = screen.getByRole("switch", { name: "Token efficiency" });
  await expect.element(toggle).not.toBeChecked();
  await userEvent.click(screen.getByRole("button", { name: "Refresh now" }));
  await expect
    .element(screen.getByText("Refresh updated. Cached upstream revision 416ae43 is active."))
    .toBeInTheDocument();
  await expect.element(toggle).not.toBeChecked();
  expect(state.run).not.toHaveBeenCalled();
});
