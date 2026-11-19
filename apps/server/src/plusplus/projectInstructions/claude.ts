import type { ProjectInstructions } from "@t3tools/plusplus/projectInstructions";
import {
  differsOnlyByProjectInstructions,
  withProjectInstructionsKey,
} from "@t3tools/plusplus/projectInstructions";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

interface ClaudeQueryReuseState {
  readonly nativeThreadId: string;
  readonly stopping: boolean;
  readonly queryPolicyKey: string;
}

export const claudeEffectiveQueryKey = Effect.fn("ProjectInstructions.claudeEffectiveQueryKey")(
  function* <Live extends ClaudeQueryReuseState>(input: {
    readonly base: string;
    readonly projectInstructions: ProjectInstructions | undefined;
    readonly queryContext: Ref.Ref<Live | null>;
    readonly nativeThreadId: string;
    readonly backgroundBusy: (live: Live) => Effect.Effect<boolean>;
  }) {
    const next = withProjectInstructionsKey(input.base, input.projectInstructions);
    const existing = yield* Ref.get(input.queryContext);
    if (
      existing !== null &&
      existing.nativeThreadId === input.nativeThreadId &&
      !existing.stopping &&
      differsOnlyByProjectInstructions(existing.queryPolicyKey, next) &&
      (yield* input.backgroundBusy(existing))
    ) {
      return existing.queryPolicyKey;
    }
    return next;
  },
);
