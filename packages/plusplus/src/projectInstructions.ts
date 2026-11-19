/** Application-owned instructions for one turn. Not user text, never persisted as a message. */
export interface ProjectInstructions {
  /** Equal ids mean equal text; adapters compare ids, never text. */
  readonly id: string;
  readonly text: string;
}

export const PI_T3_PROJECT_INSTRUCTIONS_COMMAND = "t3-project-instructions";

export type ProjectInstructionsChange =
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Deliver"; readonly instructions: ProjectInstructions }
  | { readonly _tag: "Withdraw" };

export function planProjectInstructionsChange(
  deliveredId: string | null,
  current: ProjectInstructions | undefined,
): ProjectInstructionsChange {
  if (current === undefined) {
    return deliveredId === null ? { _tag: "Unchanged" } : { _tag: "Withdraw" };
  }
  return deliveredId === current.id
    ? { _tag: "Unchanged" }
    : { _tag: "Deliver", instructions: current };
}

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).byteLength;

function utf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return text.slice(0, end);
}

function boundaryEnd(text: string, boundary: "\n\n" | "\n"): number {
  const index = text.lastIndexOf(boundary);
  return index > 0 ? index + boundary.length : 0;
}

/** Paragraph, then line, then UTF-8 code-point boundaries; every chunk <= maxBytes; order preserved. */
export function chunkProjectInstructions(text: string, maxBytes: number): ReadonlyArray<string> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive integer.");
  }
  if (text.length === 0) return [];

  const chunks: string[] = [];
  let remaining = text;
  while (byteLength(remaining) > maxBytes) {
    const prefix = utf8Prefix(remaining, maxBytes);
    if (prefix.length === 0) {
      throw new RangeError("maxBytes must fit a UTF-8 code point.");
    }
    const end = boundaryEnd(prefix, "\n\n") || boundaryEnd(prefix, "\n") || prefix.length;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  chunks.push(remaining);
  return chunks;
}

/** Reuse key for providers whose system prompt is fixed per native process (Claude). */
export function withProjectInstructionsKey(
  baseKey: string,
  current: ProjectInstructions | undefined,
): string {
  return JSON.stringify([baseKey, current?.id ?? null]);
}

export function differsOnlyByProjectInstructions(a: string, b: string): boolean {
  try {
    const left: unknown = JSON.parse(a);
    const right: unknown = JSON.parse(b);
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== 2 || right.length !== 2) {
      return false;
    }
    return typeof left[0] === "string" && left[0] === right[0];
  } catch {
    return false;
  }
}
