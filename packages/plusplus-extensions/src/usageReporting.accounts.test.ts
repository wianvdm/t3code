import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as upstream from "@t3tools/shared/usageLimits";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  collectLimitAccounts,
  collectLimitNotices,
  collectProviderUsageLimits,
  hasProviderUsageLimits,
} from "./usageReporting.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const checkedAt = "2026-09-03T11:00:00.000Z";
const claude = ProviderDriverKind.make("claudeAgent");
const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claude"),
    driver: claude,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "main@example.com" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function presentations(providers: readonly ServerProvider[]) {
  return new Map([
    [
      EnvironmentId.make("env-a"),
      { entry: { target: { label: "Laptop" } }, serverConfig: { providers } },
    ],
  ]);
}

describe("usage accounts that share an identity with a native login", () => {
  const usageAccount = (readAt: string) => ({
    id: "main@example.com.json",
    driver: claude,
    email: "main@example.com",
    usageLimits: { checkedAt: readAt, windows: [{ ...window, usedPercent: 15 }] },
  });

  it("keeps the native redeem when the native read is the fresher one", () => {
    const [merged, ...rest] = collectLimitAccounts(
      presentations([
        provider({
          usageLimits: { checkedAt, windows: [window] },
          usageAccounts: [usageAccount("2026-09-03T10:00:00.000Z")],
        }),
      ]),
    );
    expect(rest).toEqual([]);
    expect(merged?.redeem).toEqual({
      environmentId: "env-a",
      input: { instanceId: "claude" },
    });
  });

  it("redeems through the native login when the fresher usage account took over the row", () => {
    const [merged] = collectLimitAccounts(
      presentations([
        provider({
          usageLimits: { checkedAt, windows: [window] },
          usageAccounts: [usageAccount("2026-09-03T12:00:00.000Z")],
        }),
      ]),
    );
    expect(merged?.limits.windows[0]?.usedPercent).toBe(15);
    expect(merged?.redeem).toEqual({
      environmentId: "env-a",
      input: { instanceId: "claude" },
    });
  });

  it("never exposes the synthetic instance id when the usage account supplies the credits", () => {
    const [merged] = collectLimitAccounts(
      presentations([
        provider({
          usageLimits: { checkedAt, windows: [window] },
          usageAccounts: [
            {
              ...usageAccount("2026-09-03T12:00:00.000Z"),
              usageLimits: {
                checkedAt: "2026-09-03T12:00:00.000Z",
                windows: [window],
                resetCredits: { availableCount: 1, nextCreditId: "credit-1" },
              },
            },
          ],
        }),
      ]),
    );
    expect(merged?.limits.resetCredits?.availableCount).toBe(1);
    expect(merged?.redeem).toBeNull();
  });
});

describe("usage accounts that merge with a native login of another provider", () => {
  const pi = ProviderDriverKind.make("pi");
  const codex = ProviderDriverKind.make("codex");
  const piParent = provider({
    instanceId: ProviderInstanceId.make("pi"),
    driver: pi,
    auth: { status: "authenticated", email: "pi@example.com" },
    usageLimits: { checkedAt, windows: [window] },
    usageAccounts: [
      {
        id: "main@example.com.json",
        driver: codex,
        email: "main@example.com",
        usageLimits: {
          checkedAt: "2026-09-03T12:00:00.000Z",
          windows: [{ ...window, usedPercent: 15 }],
        },
      },
    ],
  });
  const nativeCodex = provider({
    instanceId: ProviderInstanceId.make("codex"),
    driver: codex,
    usageLimits: { checkedAt: "2026-09-03T10:00:00.000Z", windows: [window] },
  });
  const codexRedeem = (environmentId: string) => ({
    environmentId,
    input: { instanceId: "codex" },
  });
  const mergedRow = (accounts: ReturnType<typeof collectLimitAccounts>) =>
    accounts.find((account) => account.driver === codex);

  it.each([
    ["before", [piParent, nativeCodex]],
    ["after", [nativeCodex, piParent]],
  ])(
    "redeems through the native login listed %s the usage account's provider",
    (_order, providers) => {
      const merged = mergedRow(collectLimitAccounts(presentations(providers)));
      expect(merged?.limits.windows[0]?.usedPercent).toBe(15);
      expect(merged?.redeem).toEqual(codexRedeem("env-a"));
    },
  );

  it("redeems through the native login of another environment", () => {
    const accounts = collectLimitAccounts(
      new Map([
        [
          EnvironmentId.make("env-a"),
          { entry: { target: { label: "Laptop" } }, serverConfig: { providers: [piParent] } },
        ],
        [
          EnvironmentId.make("env-b"),
          { entry: { target: { label: "Desktop" } }, serverConfig: { providers: [nativeCodex] } },
        ],
      ]),
    );
    expect(mergedRow(accounts)?.redeem).toEqual(codexRedeem("env-b"));
  });

  it("offers no redeem when no native login shares the identity", () => {
    expect(mergedRow(collectLimitAccounts(presentations([piParent])))?.redeem).toBeNull();
  });

  it("keeps identical synthetic ids separate across environments", () => {
    const usageParent = (email: string) =>
      provider({
        instanceId: ProviderInstanceId.make("pi"),
        driver: pi,
        auth: { status: "authenticated", email: "pi@example.com" },
        usageAccounts: [
          {
            id: "shared.json",
            driver: codex,
            email,
            usageLimits: { checkedAt, windows: [{ ...window, usedPercent: 15 }] },
          },
        ],
      });
    const native = (email: string) =>
      provider({
        instanceId: ProviderInstanceId.make("codex"),
        driver: codex,
        auth: { status: "authenticated", email },
        usageLimits: { checkedAt, windows: [window] },
      });
    const accounts = collectLimitAccounts(
      new Map([
        [
          EnvironmentId.make("env-a"),
          {
            entry: { target: { label: "Laptop" } },
            serverConfig: { providers: [usageParent("a@example.com"), native("a@example.com")] },
          },
        ],
        [
          EnvironmentId.make("env-b"),
          {
            entry: { target: { label: "Desktop" } },
            serverConfig: { providers: [usageParent("b@example.com"), native("b@example.com")] },
          },
        ],
      ]),
    );
    expect(accounts.find((account) => account.email === "a@example.com")?.redeem).toEqual(
      codexRedeem("env-a"),
    );
    expect(accounts.find((account) => account.email === "b@example.com")?.redeem).toEqual(
      codexRedeem("env-b"),
    );
  });
});

describe("usage accounts without a native identity", () => {
  it("skips native and membership collection passes", () => {
    const anonymous = provider({
      auth: { status: "authenticated" },
      usageAccounts: [
        {
          id: "anonymous.json",
          driver: claude,
          usageLimits: { checkedAt, windows: [window] },
        },
      ],
    });
    const input = presentations([anonymous]);
    const expected = collectLimitAccounts(input);
    using collect = vi.spyOn(upstream, "collectLimitAccounts");
    expect(collectLimitAccounts(input)).toEqual(expected);
    expect(collect).toHaveBeenCalledTimes(1);
  });
});

describe("usage accounts and coverage", () => {
  it("covers the parent's driver, not the driver the account reports", () => {
    const pi = ProviderDriverKind.make("pi");
    const opencode = ProviderDriverKind.make("opencode");
    const parent = provider({
      instanceId: ProviderInstanceId.make("pi"),
      driver: pi,
      usageAccounts: [
        {
          id: "oc.json",
          driver: opencode,
          usageLimits: { checkedAt, windows: [window] },
        },
      ],
    });
    expect(hasProviderUsageLimits(pi, [parent], [])).toBe(true);
    expect(hasProviderUsageLimits(opencode, [parent], [])).toBe(false);
  });
});

describe("monetary-only usage accounts", () => {
  const metered = provider({
    usageLimits: { checkedAt, windows: [window] },
    usageAccounts: [
      {
        id: "metered.json",
        driver: claude,
        usageLimits: { checkedAt, windows: [], monetaryUsage: { usedUsd: 1.25 } },
      },
    ],
  });

  it("returns pooled accounts without the placeholder window", () => {
    const accounts = collectLimitAccounts(presentations([metered]));
    expect(accounts.map((account) => account.key)).toEqual([
      "env-a:claude",
      "env-a:claude:metered.json",
    ]);
    expect(accounts[1]?.limits.windows).toEqual([]);
    expect(accounts[1]?.limits.monetaryUsage).toEqual({ usedUsd: 1.25 });
  });

  it("keeps the hub row of a monetary-only native login", () => {
    const opencode = ProviderDriverKind.make("opencode");
    const native = provider({
      instanceId: ProviderInstanceId.make("oc"),
      driver: opencode,
      auth: { status: "authenticated", email: "a@example.com" },
      usageLimits: { checkedAt, windows: [], monetaryUsage: { usedUsd: 2 } },
    });
    const hub = {
      id: UsageLimitSourceId.make("hub"),
      kind: "cliproxy" as const,
      label: "hub",
      checkedAt,
      accounts: [
        {
          id: "a.json",
          driver: opencode,
          email: "a@example.com",
          usageLimits: { checkedAt, windows: [window] },
        },
      ],
    };
    const report = collectProviderUsageLimits(native.instanceId, [native], [hub], now);
    expect(report?.accounts.map((account) => account.id)).toEqual(["oc", "hub:a.json"]);
    expect(report?.accounts[0]?.limits.windows).toEqual([]);
  });

  // R5: the hub row is judged against the older windowed login, not the fresher monetary-only winner.
  it("drops the hub row of an identity whose older native login has windows", () => {
    const opencode = ProviderDriverKind.make("opencode");
    const login = (instanceId: string, usageLimits: ServerProvider["usageLimits"]) =>
      provider({
        instanceId: ProviderInstanceId.make(instanceId),
        driver: opencode,
        auth: { status: "authenticated", email: "a@example.com" },
        usageLimits,
      });
    const monetary = login("oc", {
      checkedAt: "2026-09-03T11:00:00.000Z",
      windows: [],
      monetaryUsage: { usedUsd: 2 },
    });
    const windowed = login("oc-windowed", {
      checkedAt: "2026-09-03T10:00:00.000Z",
      windows: [window],
    });
    const hub = {
      id: UsageLimitSourceId.make("hub"),
      kind: "cliproxy" as const,
      label: "hub",
      checkedAt,
      accounts: [
        {
          id: "a.json",
          driver: opencode,
          email: "a@example.com",
          usageLimits: { checkedAt, windows: [window] },
        },
      ],
    };
    const report = collectProviderUsageLimits(
      monetary.instanceId,
      [monetary, windowed],
      [hub],
      now,
    );
    expect(report?.accounts.map((account) => account.id)).toEqual(["oc"]);
  });

  it("returns report rows without the placeholder window and raises no notice", () => {
    const report = collectProviderUsageLimits(metered.instanceId, [metered], [], now);
    expect(report?.accounts.map((account) => account.limits.windows.length)).toEqual([1, 0]);
    expect(collectLimitNotices(presentations([metered]))).toEqual([]);
  });
});
