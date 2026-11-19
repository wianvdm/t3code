import { ProviderInstanceId } from "@t3tools/contracts";
import type { ProjectInstructions } from "@t3tools/plusplus/projectInstructions";
import { assert, describe, it } from "@effect/vitest";
import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES } from "../../provider/CodexDeveloperInstructions.ts";
import { refreshCodexProjectInstructionsCache } from "../../plusplus/projectInstructions/codex.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";

const first = { id: "snapshot-1", text: "<token_efficiency>first</token_efficiency>" };
const second = { id: "snapshot-2", text: "<token_efficiency>second</token_efficiency>" };
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
} as const;
const utf8Length = (text: string) => new TextEncoder().encode(text).byteLength;

const buildParams = (input: {
  readonly hasT3Mcp?: boolean;
  readonly projectInstructions?: ProjectInstructions;
  readonly appContext?: ReadonlyArray<{ readonly key: string; readonly text: string }>;
}) =>
  CodexAdapterV2.buildCodexTurnStartParams({
    nativeThreadId: "native-codex-thread",
    codexInput: [{ type: "text", text: "Continue." }],
    runtimePolicy,
    modelSelection,
    ...(input.hasT3Mcp === undefined ? {} : { hasT3Mcp: input.hasT3Mcp }),
    ...(input.projectInstructions === undefined
      ? {}
      : { projectInstructions: input.projectInstructions }),
    ...(input.appContext === undefined ? {} : { appContext: input.appContext }),
  });

const instructionEntries = (
  additionalContext: Record<string, V2TurnStartParams__AdditionalContextEntry> | undefined,
) =>
  Object.entries(additionalContext ?? {}).filter(([key]) =>
    key.startsWith("t3_project_instructions_"),
  );

describe("Codex project instruction delivery", () => {
  it.effect.each([false, true])("delivers application context with hasT3Mcp=%s", (hasT3Mcp) =>
    Effect.gen(function* () {
      const params = yield* buildParams({ hasT3Mcp, projectInstructions: first });
      assert.deepEqual(instructionEntries(params.additionalContext), [
        ["t3_project_instructions_01", { kind: "application", value: first.text }],
      ]);
    }),
  );

  it.effect("chunks at UTF-8-safe paragraph and code-point boundaries with ordered keys", () =>
    Effect.gen(function* () {
      const text = `${"a".repeat(3900)}\n\n${"🙂".repeat(1000)}\nlast`;
      const params = yield* buildParams({
        projectInstructions: { id: "large", text },
      });
      const entries = instructionEntries(params.additionalContext);
      const keys = entries.map(([key]) => key);

      assert.deepEqual(keys, [
        "t3_project_instructions_01",
        "t3_project_instructions_02",
        "t3_project_instructions_03",
      ]);
      assert.equal(entries.map(([, entry]) => entry.value).join(""), text);
      assert.isTrue(entries[0]?.[1].value.endsWith("\n\n"));
      assert.isTrue(
        entries.every(
          ([, entry]) =>
            entry.value.length > 0 &&
            utf8Length(entry.value) <= CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
        ),
      );
    }),
  );

  it.effect("leaves untrusted appContext unchanged and omits instruction keys when disabled", () =>
    Effect.gen(function* () {
      const appContext = [{ key: "mcp_app_todos", text: "Filtered to overdue" }];
      const enabled = yield* buildParams({ projectInstructions: first, appContext });
      const disabled = yield* buildParams({ appContext });

      assert.deepEqual(enabled.additionalContext?.mcp_app_todos, {
        kind: "untrusted",
        value: "Filtered to overdue",
      });
      assert.deepEqual(disabled.additionalContext?.mcp_app_todos, {
        kind: "untrusted",
        value: "Filtered to overdue",
      });
      assert.deepEqual(instructionEntries(disabled.additionalContext), []);
    }),
  );

  it.effect(
    "refreshes compaction restoration after disable, replacement and an adapter restart",
    () =>
      Effect.gen(function* () {
        const threadId = "native-codex-thread";
        const existing = {
          t3_code_runtime: { kind: "application", value: "runtime" },
          mcp_app_todos: { kind: "untrusted", value: "user data" },
          t3_project_instructions_01: { kind: "application", value: "stale-1" },
          t3_project_instructions_02: { kind: "application", value: "stale-2" },
        } satisfies Record<string, V2TurnStartParams__AdditionalContextEntry>;
        const cache = yield* Ref.make(
          new Map<string, Record<string, V2TurnStartParams__AdditionalContextEntry>>([
            [threadId, existing],
          ]),
        );

        yield* refreshCodexProjectInstructionsCache(cache, threadId, first);
        const replaced = (yield* Ref.get(cache)).get(threadId);
        assert.deepEqual(instructionEntries(replaced), [
          ["t3_project_instructions_01", { kind: "application", value: first.text }],
        ]);
        assert.equal(replaced?.t3_code_runtime, existing.t3_code_runtime);
        assert.equal(replaced?.mcp_app_todos, existing.mcp_app_todos);

        yield* refreshCodexProjectInstructionsCache(cache, threadId, undefined);
        const disabled = (yield* Ref.get(cache)).get(threadId);
        assert.deepEqual(instructionEntries(disabled), []);
        assert.equal(disabled?.t3_code_runtime, existing.t3_code_runtime);
        assert.equal(disabled?.mcp_app_todos, existing.mcp_app_todos);

        const emptyCache = yield* Ref.make(
          new Map<string, Record<string, V2TurnStartParams__AdditionalContextEntry>>(),
        );
        yield* refreshCodexProjectInstructionsCache(emptyCache, threadId, second);
        assert.deepEqual(instructionEntries((yield* Ref.get(emptyCache)).get(threadId)), [
          ["t3_project_instructions_01", { kind: "application", value: second.text }],
        ]);
      }),
  );
});
