import { describe, expect, it } from "vite-plus/test";

import { AuthOrchestrationReadScope, AuthSettingsWriteScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { TOKEN_EFFICIENCY_WS_METHODS } from "./plusplus/tokenEfficiency.ts";

describe("token-efficiency client RPC permissions", () => {
  it("allows readers to inspect status and exact content", () => {
    expect(clientRpcRequiredScopes(TOKEN_EFFICIENCY_WS_METHODS.view, {})).toEqual([
      AuthOrchestrationReadScope,
    ]);
  });

  it("requires settings-write authority for a manual refresh", () => {
    expect(clientRpcRequiredScopes(TOKEN_EFFICIENCY_WS_METHODS.refresh, {})).toEqual([
      AuthSettingsWriteScope,
    ]);
  });
});
