// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { ADAPTATION_VERSION, INSTRUCTIONS_FORMAT_VERSION, MAX_CORE_BYTES } from "./source.ts";

export type CoreValidation =
  | { readonly _tag: "Valid"; readonly raw: string; readonly blobSha: string }
  | {
      readonly _tag: "Invalid";
      readonly reason: "too-large" | "encoding" | "empty" | "nul-byte";
    };

export function gitBlobSha(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

/** Bytes as received. Fatal UTF-8 decode, non-empty after trim, no U+0000, at most MAX_CORE_BYTES. */
export function validateCoreBytes(bytes: Uint8Array): CoreValidation {
  if (bytes.byteLength > MAX_CORE_BYTES) return { _tag: "Invalid", reason: "too-large" };
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { _tag: "Invalid", reason: "encoding" };
  }
  if (raw.trim().length === 0) return { _tag: "Invalid", reason: "empty" };
  if (raw.includes("\0")) return { _tag: "Invalid", reason: "nul-byte" };
  return { _tag: "Valid", raw, blobSha: gitBlobSha(bytes) };
}

export type CoreAdaptation =
  | { readonly _tag: "Adapted"; readonly text: string }
  | {
      readonly _tag: "Rejected";
      readonly reason: "referral-missing" | "referral-ambiguous" | "empty-after-adaptation";
    };

const FINAL_REFERRAL = /^for the full playbook\b.*\btoken-efficiency\b.*\bskill\.?$/i;
const EARLIER_REFERRAL = /full playbook|token-efficiency` skill/i;

/**
 * Adaptation v1: CRLF/CR -> LF, trim the end, split paragraphs on /\n{2,}/.
 * The last paragraph must be one line matching the expected full-playbook referral.
 */
export function adaptCore(raw: string): CoreAdaptation {
  const paragraphs = raw
    .replace(/\r\n?/g, "\n")
    .trimEnd()
    .split(/\n{2,}/);
  const matches = paragraphs.filter((paragraph) => FINAL_REFERRAL.test(paragraph));
  if (matches.length === 0) return { _tag: "Rejected", reason: "referral-missing" };
  if (
    matches.length > 1 ||
    !FINAL_REFERRAL.test(paragraphs.at(-1) ?? "") ||
    paragraphs.slice(0, -1).some((paragraph) => EARLIER_REFERRAL.test(paragraph))
  ) {
    return { _tag: "Rejected", reason: "referral-ambiguous" };
  }
  const text = paragraphs.slice(0, -1).join("\n\n");
  if (text.trim().length === 0) return { _tag: "Rejected", reason: "empty-after-adaptation" };
  return { _tag: "Adapted", text };
}

/** The text agents receive. Its envelope is fixed by INSTRUCTIONS_FORMAT_VERSION. */
export function formatTokenEfficiencyInstructions(adapted: string): string {
  return `<token_efficiency>\n${adapted}\n</token_efficiency>`;
}

/** Changes exactly when the delivered text can change. */
export function tokenEfficiencyInstructionsId(blobSha: string): string {
  return `token-efficiency/f${INSTRUCTIONS_FORMAT_VERSION}.a${ADAPTATION_VERSION}/${blobSha}`;
}
