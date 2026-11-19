import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { TokenEfficiencyRefreshResult } from "@t3tools/contracts/plusplus/tokenEfficiency";
import {
  ATTRIBUTION_TEXT,
  refreshOutcomeMessage,
  shortRevision,
  sourceLabel,
} from "./presentation.ts";

const checkedAt = DateTime.makeUnsafe("2026-11-19T12:00:00.000Z");
const view = {
  status: {
    active: {
      source: "upstream",
      blobSha: "416ae435f8488d114752fe35da16c45488cadd44",
      adaptationVersion: 1,
      fetchedAt: checkedAt,
    },
    lastSuccessfulCheckAt: checkedAt,
    lastAttemptAt: checkedAt,
    lastFailure: null,
    refreshing: false,
    automaticRefresh: false,
  },
  instructions: "<token_efficiency>\nRules.\n</token_efficiency>",
} as const;

function result(
  outcome: TokenEfficiencyRefreshResult["outcome"],
  nextView: TokenEfficiencyRefreshResult["view"] = view,
): TokenEfficiencyRefreshResult {
  return { outcome, view: nextView };
}

describe("token-efficiency presentation", () => {
  it("labels the content source and shortens revisions", () => {
    expect(sourceLabel("upstream")).toBe("Cached upstream");
    expect(sourceLabel("bundled")).toBe("Bundled fallback");
    expect(shortRevision("416ae435f8488d114752fe35da16c45488cadd44")).toBe("416ae43");
    expect(ATTRIBUTION_TEXT).toContain("Tarek Sabet");
    expect(ATTRIBUTION_TEXT).toContain("MIT");
  });

  it("reports updated and unchanged outcomes with the active revision", () => {
    expect(refreshOutcomeMessage(result("updated"))).toBe(
      "Refresh updated. Cached upstream revision 416ae43 is active.",
    );
    expect(refreshOutcomeMessage(result("unchanged"))).toBe(
      "Refresh unchanged. Cached upstream revision 416ae43 stays active.",
    );
  });

  it("names the cached upstream revision preserved by a failure", () => {
    const failed = result("failed", {
      ...view,
      status: {
        ...view.status,
        lastFailure: { at: checkedAt, reason: "rate-limited" },
      },
    });
    expect(refreshOutcomeMessage(failed)).toBe(
      "Refresh failed (rate limited). Cached upstream revision 416ae43 stays active.",
    );
  });

  it("names the bundled revision and pinned commit preserved by a failure", () => {
    const failed = result("failed", {
      ...view,
      status: {
        ...view.status,
        active: {
          source: "bundled",
          blobSha: "416ae435f8488d114752fe35da16c45488cadd44",
          adaptationVersion: 1,
          upstreamCommit: "8dc98e1c70ebe395c31b2a16c9376ca7e4071ba7",
        },
        lastFailure: { at: checkedAt, reason: "network" },
      },
    });
    expect(refreshOutcomeMessage(failed)).toBe(
      "Refresh failed (network error). Bundled revision 416ae43 (pinned 8dc98e1) stays active.",
    );
  });
});
