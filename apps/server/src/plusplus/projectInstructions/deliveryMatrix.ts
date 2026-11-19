import { ProviderDriverKind } from "@t3tools/contracts";

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
 * A provider whose delivery mechanism differs across major versions, e.g. OpenCode 1.x vs 2.x.
 * Versions map to the single-row shape minus nativeSubagents, which stays row-level.
 */
export interface ProjectInstructionsDeliveryByVersion {
  readonly versions: Readonly<Record<string, Omit<ProjectInstructionsDelivery, "nativeSubagents">>>;
  readonly nativeSubagents: "not-covered";
}

export type ProjectInstructionsDeliveryRow =
  | ProjectInstructionsDelivery
  | ProjectInstructionsDeliveryByVersion;

/**
 * How each built-in provider delivers application-owned project instructions (#78).
 * Keyed by the driver kind the provider registry uses.
 */
export const PROJECT_INSTRUCTIONS_DELIVERY: Partial<
  Record<ProviderDriverKind, ProjectInstructionsDeliveryRow>
> = {
  [ProviderDriverKind.make("claudeAgent")]: {
    mechanism: "system-prompt",
    cadence:
      "Every query: appended via buildRuntimeInstructions to systemPrompt.append, and the query reuse key includes the instructions id so a changed id starts a new query once the live query has no provider-native background work (claude.ts defers replacement)",
    compaction: "not-needed",
    nativeSubagents: "not-covered",
  },
  [ProviderDriverKind.make("codex")]: {
    mechanism: "developer-context",
    cadence:
      "additionalContext entries keyed t3_project_instructions_NN; the adapter sends the entries on every turn/start and Codex dedupes them by content",
    compaction: "reinject",
    nativeSubagents: "not-covered",
  },
  [ProviderDriverKind.make("opencode")]: {
    versions: {
      "1.x": {
        mechanism: "system-prompt",
        cadence:
          "OpenCode's per-prompt `system` field; every prompt in a turn, steers included, repeats it",
        compaction: "not-needed",
      },
      "2.x": {
        mechanism: "session-instructions",
        cadence:
          "session.instructions.entry.put only when the instructions string changes; entries persist across compaction",
        compaction: "not-needed",
      },
    },
    nativeSubagents: "not-covered",
  },
  [ProviderDriverKind.make("pi")]: {
    mechanism: "pi-system-prompt",
    cadence:
      "Extension command sent only on Deliver or Withdraw; before_agent_start rebuilds the system prompt at each agent start",
    compaction: "not-needed",
    nativeSubagents: "not-covered",
  },
};

/** Built-in driver kinds without a row yet. #78 PRs move kinds from this list into rows; it must be empty before the feature is described as cross-provider. */
export const PROJECT_INSTRUCTIONS_PENDING: ReadonlyArray<ProviderDriverKind> = [
  ProviderDriverKind.make("cursor"),
  ProviderDriverKind.make("muse"),
  ProviderDriverKind.make("acpRegistry"),
  ProviderDriverKind.make("grok"),
  ProviderDriverKind.make("kiro"),
  ProviderDriverKind.make("fx"),
  ProviderDriverKind.make("antigravity"),
];
