import { TOKEN_EFFICIENCY_WS_METHODS } from "@t3tools/contracts/plusplus/tokenEfficiency";
import type { EnvironmentId } from "@t3tools/contracts";
import { requestGuarded, type EnvironmentRpcInput } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";

export const tokenEfficiencyView = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plusplus:token-efficiency-view",
  staleTimeMs: 0,
  execute: (input: EnvironmentRpcInput<typeof TOKEN_EFFICIENCY_WS_METHODS.view>) =>
    requestGuarded(TOKEN_EFFICIENCY_WS_METHODS.view, input),
});

export function refreshTokenEfficiencyViews(environmentIds: readonly EnvironmentId[]) {
  for (const environmentId of environmentIds) {
    appAtomRegistry.refresh(tokenEfficiencyView({ environmentId, input: {} }));
  }
}

export const refreshTokenEfficiency = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:plusplus:refresh-token-efficiency",
  tag: TOKEN_EFFICIENCY_WS_METHODS.refresh,
  concurrency: { mode: "singleFlight", key: (target) => target.environmentId },
  onSuccess: (target, registry) => Effect.sync(() => registry.refresh(tokenEfficiencyView(target))),
});
