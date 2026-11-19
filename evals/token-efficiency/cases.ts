export type TokenEfficiencyCase =
  | {
      readonly id: "selective-reading";
      readonly kind: "selective-reading";
      readonly source: string;
      readonly prompt: string;
      readonly expectedAnswer: string;
      readonly maxContextBytes: number;
    }
  | {
      readonly id: "error-exit-status";
      readonly kind: "error-exit-status";
      readonly source: string;
      readonly prompt: string;
      readonly expectedError: string;
    }
  | {
      readonly id: "ordinary-edit";
      readonly kind: "ordinary-edit";
      readonly source: string;
      readonly prompt: string;
      readonly maxToolCalls: number;
    }
  | {
      readonly id: "prompt-overhead";
      readonly kind: "prompt-overhead";
      readonly source: string;
    };

export const cases: ReadonlyArray<TokenEfficiencyCase> = [
  {
    id: "selective-reading",
    kind: "selective-reading",
    source: "#75 selective-reading acceptance case",
    prompt:
      "In the simulated repository, find the function that calculates an order total. Report its name and file. Use the available search and ranged-read tools; do not edit files.",
    expectedAnswer: "calculateOrderTotal",
    maxContextBytes: 2_000,
  },
  {
    id: "error-exit-status",
    kind: "error-exit-status",
    source: "#75 error and exit-status acceptance case",
    prompt:
      "Run the simulated repository's tests with `npm test`, diagnose the failure, and report the relevant error and command exit status. Do not edit files.",
    expectedError: "AssertionError: expected 42, received 41",
  },
  {
    id: "ordinary-edit",
    kind: "ordinary-edit",
    source: "#75 ordinary-work control",
    prompt:
      "In src/config.ts, change `retries: 2` to `retries: 3`, then confirm the edit. Keep the change to one line.",
    maxToolCalls: 3,
  },
  {
    id: "prompt-overhead",
    kind: "prompt-overhead",
    source: "#75 deterministic delivery-overhead case",
  },
];
