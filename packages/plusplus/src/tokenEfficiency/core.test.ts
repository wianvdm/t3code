import { describe, expect, it } from "vite-plus/test";

import { BUNDLED_CORE, UPSTREAM_LICENSE } from "./bundledCore.ts";
import {
  adaptCore,
  formatTokenEfficiencyInstructions,
  gitBlobSha,
  tokenEfficiencyInstructionsId,
  validateCoreBytes,
} from "./core.ts";
import { MAX_CORE_BYTES } from "./source.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const referral = "For the full playbook, invoke the `token-efficiency` skill.";

describe("bundled CORE", () => {
  it("is the pinned upstream blob with MIT attribution and adaptable text", () => {
    const bytes = encode(BUNDLED_CORE.raw);
    expect(gitBlobSha(bytes)).toBe(BUNDLED_CORE.blobSha);
    expect(BUNDLED_CORE.upstreamCommit).toBe("8dc98e1c70ebe395c31b2a16c9376ca7e4071ba7");
    expect(UPSTREAM_LICENSE).toContain("MIT License");
    expect(UPSTREAM_LICENSE).toContain("Copyright (c) 2026 Tarek Sabet");
    expect(adaptCore(BUNDLED_CORE.raw)._tag).toBe("Adapted");
  });
});

describe("validateCoreBytes", () => {
  it("accepts exactly 16 KiB and rejects 16 KiB plus one byte", () => {
    expect(validateCoreBytes(new Uint8Array(MAX_CORE_BYTES).fill(97))._tag).toBe("Valid");
    expect(validateCoreBytes(new Uint8Array(MAX_CORE_BYTES + 1).fill(97))).toEqual({
      _tag: "Invalid",
      reason: "too-large",
    });
  });

  it.each([
    ["invalid UTF-8", new Uint8Array([0xff]), "encoding"],
    ["empty text", encode(" \r\n\t"), "empty"],
    ["a NUL byte", encode("before\0after"), "nul-byte"],
  ] as const)("rejects %s", (_name, bytes, reason) => {
    expect(validateCoreBytes(bytes)).toEqual({ _tag: "Invalid", reason });
  });
});

describe("adaptCore", () => {
  it("normalizes line endings, trims trailing whitespace, and removes the final referral", () => {
    expect(adaptCore(`First rule.  \r\n\r\nSecond rule.\r\r${referral}\r\n`)).toEqual({
      _tag: "Adapted",
      text: "First rule.  \n\nSecond rule.",
    });
  });

  it("accepts a reworded final referral", () => {
    expect(adaptCore(`Rules.\n\nFor the full playbook, use the token-efficiency skill`)).toEqual({
      _tag: "Adapted",
      text: "Rules.",
    });
  });

  it("rejects a missing referral", () => {
    expect(adaptCore("Rules only.")).toEqual({
      _tag: "Rejected",
      reason: "referral-missing",
    });
  });

  it("rejects a referral or skill mention in an earlier paragraph", () => {
    expect(adaptCore(`Use the full playbook first.\n\nRules.\n\n${referral}`)).toEqual({
      _tag: "Rejected",
      reason: "referral-ambiguous",
    });
  });

  it("rejects a non-final referral and an empty result", () => {
    expect(adaptCore(`${referral}\n\nRules.`)).toEqual({
      _tag: "Rejected",
      reason: "referral-ambiguous",
    });
    expect(adaptCore(referral)).toEqual({
      _tag: "Rejected",
      reason: "empty-after-adaptation",
    });
  });
});

it("formats the fixed instruction envelope and identity", () => {
  expect(formatTokenEfficiencyInstructions("Rules.")).toBe(
    "<token_efficiency>\nRules.\n</token_efficiency>",
  );
  expect(tokenEfficiencyInstructionsId(BUNDLED_CORE.blobSha)).toBe(
    `token-efficiency/f1.a1/${BUNDLED_CORE.blobSha}`,
  );
});
