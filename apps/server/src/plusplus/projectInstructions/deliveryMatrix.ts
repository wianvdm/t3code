import { ProviderDriverKind, type ProviderDriverKind as DriverKind } from "@t3tools/contracts";

export interface ProjectInstructionsDelivery {
  readonly mechanism:
    | "system-prompt"
    | "developer-context"
    | "session-instructions"
    | "prompt-block"
    | "pi-system-prompt";
  readonly cadence: string;
  readonly compaction: "not-needed" | "reinject" | "unsupported";
  readonly nativeSubagents: "not-covered";
}

/**
 * How each built-in provider delivers application-owned project instructions (design-72 §2.4).
 * Keyed by the driver kind the provider registry uses.
 */
export const PROJECT_INSTRUCTIONS_DELIVERY: Partial<
  Record<DriverKind, ProjectInstructionsDelivery>
> = {
  [ProviderDriverKind.make("claudeAgent")]: {
    mechanism: "system-prompt",
    cadence:
      "Every query: appended via buildRuntimeInstructions to systemPrompt.append, and the query reuse key includes the instructions id so a change starts a new query",
    compaction: "not-needed",
    nativeSubagents: "not-covered",
  },
  [ProviderDriverKind.make("codex")]: {
    mechanism: "developer-context",
    cadence:
      "additionalContext entries keyed t3_project_instructions_NN; Codex resends them only when the instructions id changes",
    compaction: "reinject",
    nativeSubagents: "not-covered",
  },
  [ProviderDriverKind.make("cursor")]: {
    mechanism: "prompt-block",
    cadence:
      "Once per native session, on change, and after T3-initiated /compress; native auto-compaction is not observable",
    compaction: "reinject",
    nativeSubagents: "not-covered",
  },
  [ProviderDriverKind.make("muse")]: {
    mechanism: "prompt-block",
    cadence:
      "Once per session and on change; reinjected after observed compaction items and session/compact",
    compaction: "reinject",
    nativeSubagents: "not-covered",
  },
};

/** Built-in driver kinds without a row yet. #78 PRs move kinds from this list into rows; it must be empty before the feature is described as cross-provider. */
export const PROJECT_INSTRUCTIONS_PENDING: ReadonlyArray<DriverKind> = [
  ProviderDriverKind.make("opencode"),
  ProviderDriverKind.make("acpRegistry"),
  ProviderDriverKind.make("grok"),
  ProviderDriverKind.make("kiro"),
  ProviderDriverKind.make("fx"),
  ProviderDriverKind.make("antigravity"),
  ProviderDriverKind.make("pi"),
];
