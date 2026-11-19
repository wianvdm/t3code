import { TOKEN_EFFICIENCY_WS_METHODS } from "@t3tools/contracts/plusplus/tokenEfficiency";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "@effect/vitest";

import * as TokenEfficiencySnapshotService from "./TokenEfficiencySnapshotService.ts";
import { handlers, RPC_AGGREGATES } from "./rpcHandlers.ts";

const checkedAt = DateTime.makeUnsafe("2026-11-19T12:00:00.000Z");
const view = {
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
} as const;
const refreshed = { outcome: "unchanged", view } as const;

const serviceLayer = Layer.mock(TokenEfficiencySnapshotService.TokenEfficiencySnapshotService)({
  active: Effect.die("not used by the RPC handlers"),
  view: Effect.succeed(view),
  refresh: Effect.succeed(refreshed),
});

it.effect("maps view and refresh directly to the owning environment's snapshot service", () =>
  Effect.gen(function* () {
    expect(yield* handlers[TOKEN_EFFICIENCY_WS_METHODS.view]()).toBe(view);
    expect(yield* handlers[TOKEN_EFFICIENCY_WS_METHODS.refresh]()).toBe(refreshed);
    expect(RPC_AGGREGATES).toEqual({
      [TOKEN_EFFICIENCY_WS_METHODS.view]: "plusplus",
      [TOKEN_EFFICIENCY_WS_METHODS.refresh]: "plusplus",
    });
  }).pipe(Effect.provide(serviceLayer)),
);
