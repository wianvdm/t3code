import { TOKEN_EFFICIENCY_WS_METHODS } from "@t3tools/contracts/plusplus/tokenEfficiency";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../../connection/runtime";

export const tokenEfficiencyView = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plusplus:token-efficiency-view",
  tag: TOKEN_EFFICIENCY_WS_METHODS.view,
  staleTimeMs: 0,
});

export const refreshTokenEfficiency = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:plusplus:refresh-token-efficiency",
  tag: TOKEN_EFFICIENCY_WS_METHODS.refresh,
  concurrency: { mode: "singleFlight", key: (target) => target.environmentId },
  onSuccess: (target, registry) => Effect.sync(() => registry.refresh(tokenEfficiencyView(target))),
});
