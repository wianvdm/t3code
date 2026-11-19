import { TOKEN_EFFICIENCY_WS_METHODS } from "@t3tools/contracts/plusplus/tokenEfficiency";

import * as TokenEfficiencySnapshotService from "./TokenEfficiencySnapshotService.ts";

export const handlers = {
  [TOKEN_EFFICIENCY_WS_METHODS.view]: () =>
    TokenEfficiencySnapshotService.TokenEfficiencySnapshotService.use((service) => service.view),
  [TOKEN_EFFICIENCY_WS_METHODS.refresh]: () =>
    TokenEfficiencySnapshotService.TokenEfficiencySnapshotService.use((service) => service.refresh),
};

export const RPC_AGGREGATES = {
  [TOKEN_EFFICIENCY_WS_METHODS.view]: "plusplus",
  [TOKEN_EFFICIENCY_WS_METHODS.refresh]: "plusplus",
} as const;
