import { AuthOrchestrationReadScope, AuthSettingsWriteScope, WsRpcGroup } from "@t3tools/contracts";
import { TOKEN_EFFICIENCY_WS_METHODS } from "@t3tools/contracts/plusplus/tokenEfficiency";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "./RpcAuthorization.ts";
import { requiredScopeForRpcMethod } from "./RpcAuthorization.ts";

it("guards token-efficiency reads and manual refreshes with their destination scopes", () => {
  expect(requiredScopeForRpcMethod(TOKEN_EFFICIENCY_WS_METHODS.view)).toBe(
    AuthOrchestrationReadScope,
  );
  expect(requiredScopeForRpcMethod(TOKEN_EFFICIENCY_WS_METHODS.refresh)).toBe(
    AuthSettingsWriteScope,
  );
});

it.effect("refuses a refresh from a read-only token before its handler runs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
          typeof TOKEN_EFFICIENCY_WS_METHODS.refresh
        > => tag !== TOKEN_EFFICIENCY_WS_METHODS.refresh,
      ),
    );
    let handled = 0;
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
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(TOKEN_EFFICIENCY_WS_METHODS.refresh, () =>
            Effect.sync(() => {
              handled++;
              return { outcome: "unchanged", view } as const;
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );

    expect(yield* client[TOKEN_EFFICIENCY_WS_METHODS.refresh]({}).pipe(Effect.flip)).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(handled).toBe(0);
  }).pipe(Effect.scoped),
);
