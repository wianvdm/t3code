import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import type { ProjectInstructions } from "@t3tools/plusplus/projectInstructions";
import { withProjectInstructionsKey } from "@t3tools/plusplus/projectInstructions";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { claudeEffectiveQueryKey } from "../../plusplus/projectInstructions/claude.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";

const first = { id: "snapshot-1", text: "<token_efficiency>first</token_efficiency>" };
const second = { id: "snapshot-2", text: "<token_efficiency>second</token_efficiency>" };
const base = "claude-query-policy";
const nativeThreadId = "native-claude-thread";
const defaultSettings = Schema.decodeSync(ClaudeSettings)({});

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

const systemPromptAppend = (projectInstructions: ProjectInstructions | undefined) => {
  const options = ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
      model: "claude-haiku-4-5-20251001",
    },
    nativeThreadId,
    resume: false,
    cwd: "/workspace",
    settings: defaultSettings,
    projectInstructions: projectInstructions?.text,
  });
  return (options.systemPrompt as { readonly append?: string }).append ?? "";
};

describe("Claude project instruction delivery", () => {
  it.effect(
    "replaces the live-query key on enable, disable and refresh, but not on an unchanged id",
    () =>
      Effect.gen(function* () {
        const disabled = withProjectInstructionsKey(base, undefined);
        const enabled = withProjectInstructionsKey(base, first);
        const refreshed = withProjectInstructionsKey(base, second);

        assert.equal(yield* effectiveKey(null, undefined), disabled);
        assert.equal(
          yield* effectiveKey({ nativeThreadId, stopping: false, queryPolicyKey: disabled }, first),
          enabled,
        );
        assert.equal(
          yield* effectiveKey(
            { nativeThreadId, stopping: false, queryPolicyKey: enabled },
            undefined,
          ),
          disabled,
        );
        assert.equal(
          yield* effectiveKey({ nativeThreadId, stopping: false, queryPolicyKey: enabled }, second),
          refreshed,
        );
        assert.equal(
          yield* effectiveKey({ nativeThreadId, stopping: false, queryPolicyKey: enabled }, first),
          enabled,
        );
      }),
  );

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

  it("appends the active block last and removes it when disabled", () => {
    const disabled = systemPromptAppend(undefined);
    const enabled = systemPromptAppend(first);
    const refreshed = systemPromptAppend(second);

    assert.isTrue(enabled.endsWith(first.text));
    assert.isTrue(refreshed.endsWith(second.text));
    assert.notInclude(disabled, "<token_efficiency>");
    assert.notInclude(enabled, second.text);
  });

  it.effect("keeps the same live-query key for an unchanged /compact turn", () =>
    Effect.gen(function* () {
      const enabled = withProjectInstructionsKey(base, first);
      assert.equal(
        yield* effectiveKey({ nativeThreadId, stopping: false, queryPolicyKey: enabled }, first),
        enabled,
      );
    }),
  );
});
