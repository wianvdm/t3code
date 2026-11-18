import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { readUsageAccounts } from "./contracts.ts";
import {
  applyUsageLimitsUpdate,
  resolveUsageLimitsAfterProbe,
  retainPublishedUsageAccounts,
} from "./usageLimits.ts";

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const checkedAt = "2026-09-03T12:00:00.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 20,
  windowDurationMins: 10_080,
} as const;
const published = { checkedAt, windows: [session, weekly] };

describe("applyUsageLimitsUpdate", () => {
  it("returns the published object itself when no window moved", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [
          { ...weekly },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
        ],
      },
    });
    expect(next).toBe(published);
  });

  it("upserts by id and keeps the reset a percent-only update omits", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      },
    });
    expect(next).not.toBe(published);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
    });
  });

  it("leaves an unsupported account and an empty update alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  it("marks a first sparse update as unavailable", () => {
    expect(
      applyUsageLimitsUpdate({ previous: undefined, checkedAt, update: { windows: [weekly] } }),
    ).toEqual({ checkedAt, windows: [weekly], unavailable: { reason: "probeFailed" } });
  });

  it("preserves reset credits when a streamed window update changes usage", () => {
    const resetCredits = { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" };
    const next = applyUsageLimitsUpdate({
      previous: { ...published, resetCredits },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });

    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
      resetCredits,
    });
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  it("uses read order for windows while taking metadata from the successful probe", () => {
    const live = {
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [
        { ...session, usedPercent: 95 },
        { ...weekly, usedPercent: 70 },
      ],
      resetCredits: { availableCount: 2 },
      externalUsage: { label: "Old dashboard", url: "https://example.com/old" },
    };
    const probed = {
      ...published,
      windows: [{ ...session, usedPercent: 0 }],
      resetCredits: { availableCount: 1 },
      externalUsage: { label: "Usage dashboard", url: "https://example.com/usage" },
    };

    expect(resolveUsageLimitsAfterProbe({ published: live, probed })).toEqual({
      ...probed,
      checkedAt: live.checkedAt,
      windows: live.windows,
    });

    const sameTime = { ...probed, checkedAt: live.checkedAt };
    const newer = { ...probed, checkedAt: "2026-09-03T12:00:06.000Z" };
    expect(resolveUsageLimitsAfterProbe({ published: live, probed: sameTime })).toEqual(sameTime);
    expect(resolveUsageLimitsAfterProbe({ published: live, probed: newer })).toEqual(newer);
  });

  it("keeps the last good windows through a failed probe but not an unsupported one", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(resolveUsageLimitsAfterProbe({ published, probed: failed })).toBe(published);
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported })).toBe(unsupported);
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
  });
});

describe("retainPublishedUsageAccounts", () => {
  const accounts = [
    {
      id: "a@example.com.json",
      driver: ProviderDriverKind.make("codex"),
      email: "a@example.com",
      usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [session] },
    },
  ];

  it("keeps published accounts through an empty authenticated probe", () => {
    const published = provider({
      usageAccounts: accounts,
      auth: { status: "authenticated", email: "a@example.com" },
    });
    const emptyProbe = provider({ auth: { status: "authenticated", email: "a@example.com" } });
    expect(
      retainPublishedUsageAccounts({
        published,
        probed: emptyProbe,
        switchedAccount: false,
        snapshot: emptyProbe,
      }).usageAccounts,
    ).toBe(accounts);
  });

  it("drops published accounts on sign-out, uninstall, or account switch", () => {
    const published = provider({
      usageAccounts: accounts,
      auth: { status: "authenticated", email: "a@example.com" },
    });
    const signedOut = provider({ auth: { status: "unauthenticated" } });
    expect(
      retainPublishedUsageAccounts({
        published,
        probed: signedOut,
        switchedAccount: false,
        snapshot: signedOut,
      }).usageAccounts,
    ).toBeUndefined();
    const uninstalled = provider({
      installed: false,
      auth: { status: "authenticated", email: "a@example.com" },
    });
    expect(
      retainPublishedUsageAccounts({
        published,
        probed: uninstalled,
        switchedAccount: false,
        snapshot: uninstalled,
      }).usageAccounts,
    ).toBeUndefined();
    const switched = provider({ auth: { status: "authenticated", email: "b@example.com" } });
    expect(
      retainPublishedUsageAccounts({
        published,
        probed: switched,
        switchedAccount: true,
        snapshot: switched,
      }).usageAccounts,
    ).toBeUndefined();
  });

  it("keeps sidecar-only published accounts through an empty authenticated probe", () => {
    const published = provider({
      plusplus: { usageAccounts: accounts },
      auth: { status: "authenticated", email: "a@example.com" },
    });
    const emptyProbe = provider({ auth: { status: "authenticated", email: "a@example.com" } });
    const next = retainPublishedUsageAccounts({
      published,
      probed: emptyProbe,
      switchedAccount: false,
      snapshot: emptyProbe,
    });
    expect(next.usageAccounts).toEqual(accounts);
    expect(next.plusplus).toEqual({ usageAccounts: accounts });
  });

  it("mirrors retained accounts over an authoritative-empty probed sidecar", () => {
    const published = provider({
      usageAccounts: accounts,
      auth: { status: "authenticated", email: "a@example.com" },
    });
    const emptyProbe = provider({
      auth: { status: "authenticated", email: "a@example.com" },
      plusplus: { usageAccounts: [], future: 1 },
    });
    const next = retainPublishedUsageAccounts({
      published,
      probed: emptyProbe,
      switchedAccount: false,
      snapshot: emptyProbe,
    });
    expect(readUsageAccounts(next)).toEqual(accounts);
    expect(next.usageAccounts).toEqual(accounts);
    expect(next.plusplus).toEqual({ future: 1, usageAccounts: accounts });
  });

  it("never resurrects stale legacy accounts cleared by an authoritative sidecar", () => {
    const published = provider({
      usageAccounts: accounts,
      plusplus: { usageAccounts: [] },
      auth: { status: "authenticated", email: "a@example.com" },
    });
    const emptyProbe = provider({ auth: { status: "authenticated", email: "a@example.com" } });
    const next = retainPublishedUsageAccounts({
      published,
      probed: emptyProbe,
      switchedAccount: false,
      snapshot: emptyProbe,
    });
    expect(next.usageAccounts).toBeUndefined();
    expect(next.plusplus).toBeUndefined();
  });
});
