import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";

import { automaticRefreshAllowed, backoffDelay, isStale } from "./policy.ts";

const now = DateTime.makeUnsafe("2026-11-19T12:00:00.000Z");
const atHoursAgo = (hours: number) =>
  DateTime.makeUnsafe(DateTime.toEpochMillis(now) - Duration.toMillis(Duration.hours(hours)));

const status = {
  lastSuccessfulCheckAt: now,
  lastAttemptAt: null,
  consecutiveFailures: 0,
} as const;

describe("token-efficiency refresh policy", () => {
  it("uses the six-hour freshness boundary", () => {
    expect(isStale({ lastSuccessfulCheckAt: null }, now)).toBe(true);
    expect(isStale({ lastSuccessfulCheckAt: atHoursAgo(5.5) }, now)).toBe(false);
    expect(isStale({ lastSuccessfulCheckAt: atHoursAgo(6) }, now)).toBe(true);
  });

  it("backs off 15m, 30m, 1h, 2h, then caps and honours Retry-After", () => {
    expect([1, 2, 3, 4, 5].map((failures) => Duration.toMillis(backoffDelay(failures)))).toEqual([
      Duration.toMillis(Duration.minutes(15)),
      Duration.toMillis(Duration.minutes(30)),
      Duration.toMillis(Duration.hours(1)),
      Duration.toMillis(Duration.hours(2)),
      Duration.toMillis(Duration.hours(2)),
    ]);
    expect(backoffDelay(1, Duration.hours(3))).toEqual(Duration.hours(2));
    expect(backoffDelay(1, Duration.minutes(20))).toEqual(Duration.minutes(20));
  });

  it("requires enablement, staleness, and elapsed backoff", () => {
    expect(automaticRefreshAllowed({ status, anyEnabled: false, now })).toBe(false);
    expect(automaticRefreshAllowed({ status, anyEnabled: true, now })).toBe(false);
    const staleFailed = {
      lastSuccessfulCheckAt: null,
      lastAttemptAt: now,
      consecutiveFailures: 1,
    };
    expect(automaticRefreshAllowed({ status: staleFailed, anyEnabled: true, now })).toBe(false);
    expect(
      automaticRefreshAllowed({
        status: staleFailed,
        anyEnabled: true,
        now: DateTime.makeUnsafe(
          DateTime.toEpochMillis(now) + Duration.toMillis(Duration.minutes(15)),
        ),
      }),
    ).toBe(true);
  });
});
