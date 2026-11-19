import { assert, describe, it } from "@effect/vitest";

import {
  chunkProjectInstructions,
  differsOnlyByProjectInstructions,
  planProjectInstructionsChange,
  withProjectInstructionsKey,
} from "./projectInstructions.ts";

const first = { id: "revision-1", text: "First revision" };
const second = { id: "revision-2", text: "Second revision" };
const utf8Length = (text: string) => new TextEncoder().encode(text).byteLength;

describe("planProjectInstructionsChange", () => {
  it("delivers new and changed instructions only", () => {
    assert.deepEqual(planProjectInstructionsChange(null, first), {
      _tag: "Deliver",
      instructions: first,
    });
    assert.deepEqual(planProjectInstructionsChange(first.id, second), {
      _tag: "Deliver",
      instructions: second,
    });
    assert.deepEqual(planProjectInstructionsChange(first.id, first), { _tag: "Unchanged" });
  });

  it("withdraws only after a delivery", () => {
    assert.deepEqual(planProjectInstructionsChange(first.id, undefined), { _tag: "Withdraw" });
    assert.deepEqual(planProjectInstructionsChange(null, undefined), { _tag: "Unchanged" });
  });
});

describe("chunkProjectInstructions", () => {
  it("prefers paragraph and line boundaries without changing the text", () => {
    const text = "first paragraph\n\nsecond paragraph\ncontinued\n\nthird paragraph";
    const chunks = chunkProjectInstructions(text, 35);

    assert.deepEqual(chunks, [
      "first paragraph\n\n",
      "second paragraph\ncontinued\n\n",
      "third paragraph",
    ]);
    assert.equal(chunks.join(""), text);
    assert.isTrue(chunks.every((chunk) => utf8Length(chunk) <= 35));
  });

  it("splits only between code points when no line boundary fits", () => {
    const text = "ab🙂cd🙂ef";
    const chunks = chunkProjectInstructions(text, 5);

    assert.equal(chunks.join(""), text);
    assert.deepEqual(chunks, ["ab", "🙂c", "d🙂", "ef"]);
    assert.isTrue(chunks.every((chunk) => utf8Length(chunk) <= 5));
  });

  it("handles empty and exact-size text and rejects an invalid limit", () => {
    assert.deepEqual(chunkProjectInstructions("", 4), []);
    assert.deepEqual(chunkProjectInstructions("🙂", 4), ["🙂"]);
    assert.throws(() => chunkProjectInstructions("🙂🙂", 3), RangeError);
    assert.throws(() => chunkProjectInstructions("text", 0), RangeError);
  });
});

describe("project instruction reuse keys", () => {
  it("changes for enable, disable and refresh", () => {
    const disabled = withProjectInstructionsKey("base", undefined);
    const enabled = withProjectInstructionsKey("base", first);
    const refreshed = withProjectInstructionsKey("base", second);

    assert.notEqual(disabled, enabled);
    assert.notEqual(enabled, refreshed);
    assert.isTrue(differsOnlyByProjectInstructions(enabled, refreshed));
    assert.isTrue(differsOnlyByProjectInstructions(disabled, enabled));
  });

  it("rejects another base key or an unrelated key encoding", () => {
    const left = withProjectInstructionsKey("base-a", first);
    const right = withProjectInstructionsKey("base-b", second);

    assert.isFalse(differsOnlyByProjectInstructions(left, right));
    assert.isFalse(differsOnlyByProjectInstructions(left, "not-json"));
    assert.isFalse(differsOnlyByProjectInstructions(left, JSON.stringify(["base-a"])));
  });
});
