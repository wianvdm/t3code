import type { ProjectInstructions } from "@t3tools/plusplus/projectInstructions";
import { chunkProjectInstructions } from "@t3tools/plusplus/projectInstructions";
import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES } from "../../provider/CodexDeveloperInstructions.ts";

const PROJECT_INSTRUCTIONS_KEY_PREFIX = "t3_project_instructions_";
type AdditionalContext = Record<string, V2TurnStartParams__AdditionalContextEntry>;
type AdditionalContextByThread = Ref.Ref<Map<string, AdditionalContext>>;

export function withCodexProjectInstructions(
  additionalContext: AdditionalContext | undefined,
  projectInstructions: ProjectInstructions | undefined,
): AdditionalContext | undefined {
  const existing = Object.fromEntries(
    Object.entries(additionalContext ?? {}).filter(
      ([key]) => !key.startsWith(PROJECT_INSTRUCTIONS_KEY_PREFIX),
    ),
  );
  const chunks = projectInstructions
    ? chunkProjectInstructions(projectInstructions.text, CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES)
    : [];
  const instructions = Object.fromEntries(
    chunks.map((value, index) => [
      `${PROJECT_INSTRUCTIONS_KEY_PREFIX}${String(index + 1).padStart(2, "0")}`,
      { kind: "application" as const, value },
    ]),
  );
  const merged = { ...existing, ...instructions };
  return Object.keys(merged).length === 0 ? undefined : merged;
}

export const refreshCodexProjectInstructionsCache = Effect.fn(
  "ProjectInstructions.refreshCodexProjectInstructionsCache",
)(function* (
  additionalContextByThread: AdditionalContextByThread,
  threadId: string,
  projectInstructions: ProjectInstructions | undefined,
) {
  yield* Ref.update(additionalContextByThread, (current) => {
    const next = new Map(current);
    const additionalContext = withCodexProjectInstructions(next.get(threadId), projectInstructions);
    if (additionalContext === undefined) next.delete(threadId);
    else next.set(threadId, additionalContext);
    return next;
  });
});
