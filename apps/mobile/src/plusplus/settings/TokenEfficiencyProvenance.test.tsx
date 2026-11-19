import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import type {
  TokenEfficiencyRefreshResult,
  TokenEfficiencyView,
} from "@t3tools/contracts/plusplus/tokenEfficiency";
import {
  ATTRIBUTION_TEXT,
  TOKEN_EFFICIENCY_LINKS,
} from "@t3tools/plusplus-extensions/tokenEfficiency";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { SettingsTarget } from "../../features/settings/settings-environment-filter";

const environmentId = EnvironmentId.make("test");
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

const harness = vi.hoisted(() => ({
  viewAtom: {},
  permissionAtom: {},
  view: null as unknown,
  canRefresh: true,
  canWrite: true,
  enabled: false,
  refresh: vi.fn(),
  writeSettings: vi.fn(),
  alert: vi.fn(),
  openURL: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  Linking: { openURL: harness.openURL },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === harness.viewAtom ? harness.view : harness.canRefresh),
}));
vi.mock("../state/tokenEfficiency", () => ({
  tokenEfficiencyView: () => harness.viewAtom,
  refreshTokenEfficiency: { permissionAtom: () => harness.permissionAtom },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => harness.refresh }));
vi.mock("../../state/session", () => ({
  useEnvironmentsWithScope: () => (harness.canWrite ? new Set([environmentId]) : new Set()),
}));
vi.mock("../../features/settings/useSettingsWriter", () => ({
  useSettingsWriter: () => harness.writeSettings,
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: harness.alert }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({
    children,
    onPress,
    accessibilityRole,
  }: {
    readonly children?: ReactNode;
    readonly onPress?: () => void;
    readonly accessibilityRole?: string;
  }) => (
    <span role={accessibilityRole} onClick={onPress}>
      {children}
    </span>
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    loading,
    onPress,
  }: {
    readonly label: string;
    readonly disabled?: boolean;
    readonly loading?: boolean;
    readonly onPress: () => void;
  }) => (
    <button disabled={disabled || loading} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../features/settings/components/SettingsSection", () => ({
  SettingsSection: ({ children }: { readonly children?: ReactNode }) => (
    <section>{children}</section>
  ),
}));
vi.mock("../../features/settings/components/SettingsSwitchRow", () => ({
  SettingsSwitchRow: ({
    label,
    value,
    disabled,
    onValueChange,
    meta,
  }: {
    readonly label: string;
    readonly value: boolean | null;
    readonly disabled?: boolean;
    readonly onValueChange: (value: boolean) => void;
    readonly meta?: ReactNode;
  }) => (
    <div>
      <button
        role="switch"
        aria-label={label}
        aria-checked={value ?? "mixed"}
        disabled={disabled}
        onClick={() => onValueChange(!value)}
      />
      {meta}
    </div>
  ),
}));

import { TokenEfficiencySection } from "./TokenEfficiencySection";

function selectedEnvironment() {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsOverrides: harness.enabled
      ? ({ [projectId]: { plusplus: { tokenEfficiency: true } } } as never)
      : {},
  };
  return {
    environmentId,
    label: "Test",
    serverConfig: { settings },
  } as unknown as SettingsTarget;
}

function setup(
  options: {
    readonly view?: AsyncResult.AsyncResult<TokenEfficiencyView, unknown>;
    readonly refreshResult?: TokenEfficiencyRefreshResult | undefined;
    readonly refreshFailure?: string | undefined;
    readonly canRefresh?: boolean;
    readonly enabled?: boolean;
  } = {},
) {
  harness.view = options.view ?? AsyncResult.success(bundledView);
  harness.canRefresh = options.canRefresh ?? true;
  harness.canWrite = true;
  harness.enabled = options.enabled ?? false;
  harness.refresh.mockReset();
  harness.refresh.mockResolvedValue(
    options.refreshFailure === undefined
      ? AsyncResult.success(options.refreshResult ?? { outcome: "unchanged", view: bundledView })
      : AsyncResult.failure(Cause.fail(new Error(options.refreshFailure))),
  );
  harness.writeSettings.mockReset();
  harness.writeSettings.mockResolvedValue(undefined);
  harness.alert.mockReset();
  harness.openURL.mockReset();
  harness.openURL.mockResolvedValue(undefined);
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

function renderSection() {
  act(() =>
    root.render(
      <TokenEfficiencySection
        members={[{ environmentId, id: projectId } as never]}
        environments={[selectedEnvironment()]}
      />,
    ),
  );
}

function button(label: string) {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

it("shows a loading state while the owning environment responds", () => {
  setup({ view: AsyncResult.initial() });
  renderSection();
  expect(container.textContent).toContain("Loading token-efficiency provenance on Test…");
});

it.each([
  { source: "bundled", view: bundledView, label: "Bundled fallback" },
  { source: "upstream", view: upstreamView, label: "Cached upstream" },
] as const)("shows $source provenance, revision and last successful check", ({ view, label }) => {
  using _now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T13:00:00.000Z"));
  setup({ view: AsyncResult.success(view) });
  renderSection();
  expect(container.textContent).toContain(label);
  expect(container.textContent).toContain("Revision 416ae43");
  expect(container.textContent).toContain("Last successful check: 1h ago");
});

it.each([
  {
    name: "unsupported stock server",
    cause: Cause.die("Unknown request tag: plusplus.tokenEfficiency.view"),
    label: "Not supported on Test",
  },
  {
    name: "unavailable environment",
    cause: Cause.fail(new Error("This connection requires orchestration:read.")),
    label: "Unavailable on Test",
  },
] as const)("identifies an $name", ({ cause, label }) => {
  setup({ view: AsyncResult.failure(cause) });
  renderSection();
  expect(container.textContent).toContain(label);
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
  setup({
    view: AsyncResult.success(
      "outcome" in row && row.outcome === "failed" ? upstreamView : row.view,
    ),
    ...("outcome" in row ? { refreshResult: { outcome: row.outcome!, view: row.view } } : {}),
    ...("requestFailure" in row ? { refreshFailure: row.requestFailure } : {}),
  });
  renderSection();
  if (!("outcome" in row) || row.outcome === "failed") {
    expect(container.textContent).not.toContain(row.message);
  }
  await act(async () => button("Refresh now").click());
  expect(container.textContent).toContain(row.message);
  expect(harness.refresh).toHaveBeenCalledExactlyOnceWith({ environmentId, input: {} });
});

it("disables refresh without destination settings-write authority", () => {
  setup({ canRefresh: false });
  renderSection();
  expect(button("Refresh now").disabled).toBe(true);
  act(() => button("Refresh now").click());
  expect(harness.refresh).not.toHaveBeenCalled();
});

it("keeps refresh available during a server refresh", () => {
  setup({
    view: AsyncResult.success({
      ...bundledView,
      status: { ...bundledView.status, refreshing: true },
    }),
  });
  renderSection();
  expect(button("Refresh now").disabled).toBe(false);
});

it("opens exact instructions as plain text and exposes every attribution link", async () => {
  const instructions =
    "<token_efficiency>\n**Keep Markdown literal** <img src=x onerror=alert(1)>\n</token_efficiency>";
  setup({ view: AsyncResult.success({ ...upstreamView, instructions }) });
  renderSection();
  act(() => button("View instructions").click());
  expect(harness.alert).toHaveBeenCalledExactlyOnceWith(
    "Token-efficiency instructions",
    `${instructions}\n\n${ATTRIBUTION_TEXT}`,
  );
  expect(container.querySelector("img, textarea, input")).toBeNull();
  for (const [label, url] of [
    ["Upstream CORE", TOKEN_EFFICIENCY_LINKS.core],
    ["Repository", TOKEN_EFFICIENCY_LINKS.repository],
    ["Full playbook", TOKEN_EFFICIENCY_LINKS.fullPlaybook],
    ["MIT license", TOKEN_EFFICIENCY_LINKS.license],
  ] as const) {
    const link = [...container.querySelectorAll('[role="link"]')].find(
      (candidate) => candidate.textContent === label,
    );
    expect(link).toBeDefined();
    await act(async () => (link as HTMLElement).click());
    expect(harness.openURL).toHaveBeenLastCalledWith(url);
  }
});

it("refreshes a disabled project without enabling delivery", async () => {
  setup({ enabled: false, refreshResult: { outcome: "updated", view: upstreamView } });
  renderSection();
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await act(async () => button("Refresh now").click());
  expect(container.textContent).toContain(
    "Refresh updated. Cached upstream revision 416ae43 is active.",
  );
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(harness.writeSettings).not.toHaveBeenCalled();
});
