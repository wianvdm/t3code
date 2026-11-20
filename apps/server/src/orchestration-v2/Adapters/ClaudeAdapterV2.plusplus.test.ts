import type { ProjectInstructions } from "@t3tools/plusplus/projectInstructions";
import { withProjectInstructionsKey } from "@t3tools/plusplus/projectInstructions";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { claudeEffectiveQueryKey } from "../../plusplus/projectInstructions/claude.ts";

const first = { id: "snapshot-1", text: "<token_efficiency>first</token_efficiency>" };
const second = { id: "snapshot-2", text: "<token_efficiency>second</token_efficiency>" };
const base = "claude-query-policy";
const nativeThreadId = "native-claude-thread";

interface LiveQuery {
  readonly nativeThreadId: string;
  readonly stopping: boolean;
  readonly queryPolicyKey: string;
}

const effectiveKey = (
  existing: LiveQuery | null,
  projectInstructions: ProjectInstructions | undefined,
  backgroundBusy = false,
  baseKey = base,
) =>
  Ref.make(existing).pipe(
    Effect.flatMap((queryContext) =>
      claudeEffectiveQueryKey({
        base: baseKey,
        projectInstructions,
        queryContext,
        nativeThreadId,
        backgroundBusy: () => Effect.succeed(backgroundBusy),
      }),
    ),
  );

describe("Claude project instruction delivery", () => {
  it.effect(
    "defers enable, disable and refresh only while provider-native background work runs",
    () =>
      Effect.gen(function* () {
        const disabled = withProjectInstructionsKey(base, undefined);
        const enabled = withProjectInstructionsKey(base, first);
        const refreshed = withProjectInstructionsKey(base, second);

        assert.equal(
          yield* effectiveKey(
            { nativeThreadId, stopping: false, queryPolicyKey: disabled },
            first,
            true,
          ),
          disabled,
        );
        assert.equal(
          yield* effectiveKey(
            { nativeThreadId, stopping: false, queryPolicyKey: enabled },
            undefined,
            true,
          ),
          enabled,
        );
        assert.equal(
          yield* effectiveKey(
            { nativeThreadId, stopping: false, queryPolicyKey: enabled },
            second,
            true,
          ),
          enabled,
        );
        assert.equal(
          yield* effectiveKey({ nativeThreadId, stopping: false, queryPolicyKey: enabled }, second),
          refreshed,
        );
      }),
  );
});
