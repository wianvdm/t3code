import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  TokenEfficiencyFailureReason,
  TokenEfficiencyRefreshResult,
  TokenEfficiencyView,
} from "./tokenEfficiency.ts";

const encodedView = {
  status: {
    active: {
      source: "upstream",
      blobSha: "416ae435f8488d114752fe35da16c45488cadd44",
      adaptationVersion: 1,
      fetchedAt: "2026-11-19T12:00:00.000Z",
    },
    lastSuccessfulCheckAt: "2026-11-19T12:00:00.000Z",
    lastAttemptAt: "2026-11-19T12:00:00.000Z",
    lastFailure: null,
    refreshing: false,
    automaticRefresh: true,
  },
  instructions: "<token_efficiency>\nRules.\n</token_efficiency>",
} as const;

const jsonView = Schema.fromJsonString(TokenEfficiencyView);
const jsonRefreshResult = Schema.fromJsonString(TokenEfficiencyRefreshResult);
const encodeRefreshResult = Schema.encodeSync(jsonRefreshResult);
const decodeRefreshResult = Schema.decodeSync(jsonRefreshResult);
const decodeFailureReason = Schema.decodeUnknownSync(TokenEfficiencyFailureReason);

describe("token-efficiency wire schemas", () => {
  it("round-trips UTC timestamps and the exact instruction text", () => {
    const decoded = Schema.decodeSync(jsonView)(JSON.stringify(encodedView));
    expect(DateTime.formatIso(decoded.status.active.fetchedAt!)).toBe(
      encodedView.status.active.fetchedAt,
    );
    expect(Schema.encodeSync(jsonView)(decoded)).toBe(JSON.stringify(encodedView));
  });

  it("decodes bundled provenance and every refresh outcome", () => {
    const bundled = Schema.decodeSync(jsonView)(
      JSON.stringify({
        ...encodedView,
        status: {
          ...encodedView.status,
          active: {
            source: "bundled",
            blobSha: "416ae435f8488d114752fe35da16c45488cadd44",
            adaptationVersion: 1,
            upstreamCommit: "8dc98e1c70ebe395c31b2a16c9376ca7e4071ba7",
          },
        },
      }),
    );
    for (const outcome of ["updated", "unchanged", "failed"] as const) {
      const result = encodeRefreshResult({ outcome, view: bundled });
      expect(decodeRefreshResult(result).outcome).toBe(outcome);
    }
  });

  it("accepts every persisted failure reason", () => {
    for (const reason of [
      "network",
      "timeout",
      "redirect",
      "http-status",
      "rate-limited",
      "too-large",
      "content-type",
      "encoding",
      "empty",
      "nul-byte",
      "unexpected-not-modified",
      "adaptation",
      "cache-write",
      "cache-invalid",
    ]) {
      expect(decodeFailureReason(reason)).toBe(reason);
    }
  });
});
