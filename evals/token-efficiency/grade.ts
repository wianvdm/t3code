import {
  chunkProjectInstructions,
  planProjectInstructionsChange,
} from "@t3tools/provider-core/server/projectInstructions";
import type { TokenEfficiencyCase } from "./cases.ts";

export interface ToolExchange {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly output: string;
}

export interface Transcript {
  readonly exchanges: ReadonlyArray<ToolExchange>;
  readonly final: string;
}

export interface Grade {
  readonly pass: boolean;
  readonly contextBytes: number;
  readonly toolCalls: number;
  readonly searchedBeforeFullRead?: boolean;
  readonly preservedExitStatus?: boolean;
  readonly relevantError?: boolean;
}

const utf8Length = (text: string) => new TextEncoder().encode(text).byteLength;

export function gradeTranscript(
  entry: Exclude<TokenEfficiencyCase, { readonly kind: "prompt-overhead" }>,
  transcript: Transcript,
): Grade {
  const contextBytes = transcript.exchanges.reduce(
    (total, exchange) => total + utf8Length(exchange.output),
    0,
  );
  const base = { contextBytes, toolCalls: transcript.exchanges.length };
  if (entry.kind === "selective-reading") {
    const searchIndex = transcript.exchanges.findIndex(
      (exchange) => exchange.name === "grep" || exchange.name === "symbol_search",
    );
    const fullReadIndex = transcript.exchanges.findIndex(
      (exchange) =>
        exchange.name === "read_file" &&
        exchange.arguments.start_line === undefined &&
        exchange.arguments.end_line === undefined,
    );
    const searchedBeforeFullRead =
      searchIndex >= 0 && (fullReadIndex < 0 || searchIndex < fullReadIndex);
    return {
      ...base,
      searchedBeforeFullRead,
      pass:
        transcript.final.includes(entry.expectedAnswer) &&
        searchedBeforeFullRead &&
        contextBytes <= entry.maxContextBytes,
    };
  }
  if (entry.kind === "error-exit-status") {
    const unsafePipeline = transcript.exchanges.some(
      (exchange) =>
        exchange.name === "run_command" &&
        /\|\s*tail\b/.test(String(exchange.arguments.command ?? "")) &&
        !/pipefail/.test(String(exchange.arguments.command ?? "")),
    );
    const preservedExitStatus =
      /exit(?:ed)?(?:\s+with)?(?:\s+status|\s+code)?\s*[:=]?\s*1\b/i.test(transcript.final) &&
      !unsafePipeline;
    const relevantError = transcript.final.includes(entry.expectedError);
    return {
      ...base,
      preservedExitStatus,
      relevantError,
      pass: preservedExitStatus && relevantError,
    };
  }
  const edits = transcript.exchanges.filter((exchange) => exchange.name === "edit_file");
  const correctEdit =
    edits.length === 1 &&
    edits.every(
      (edit) =>
        edit.arguments.path === "src/config.ts" &&
        edit.arguments.old_text === "retries: 2" &&
        edit.arguments.new_text === "retries: 3",
    );
  return {
    ...base,
    pass: correctEdit && transcript.exchanges.length <= entry.maxToolCalls,
  };
}

export function calculatePromptOverhead(
  text: string,
  options: {
    readonly turns?: number;
    readonly changesAt?: ReadonlyArray<number>;
    readonly compactionsAt?: ReadonlyArray<number>;
  } = {},
) {
  const turns = options.turns ?? 10;
  const changesAt = new Set(options.changesAt ?? [4]);
  const compactionsAt = new Set(options.compactionsAt ?? [7]);
  let deliveredId: string | null = null;
  let changeNumber = 0;
  let promptHistoryCopies = 0;
  for (let turn = 1; turn <= turns; turn++) {
    if (compactionsAt.has(turn)) deliveredId = null;
    if (changesAt.has(turn)) changeNumber++;
    const current = { id: `snapshot-${changeNumber}`, text };
    const change = planProjectInstructionsChange(deliveredId, current);
    if (change._tag === "Deliver") {
      promptHistoryCopies++;
      deliveredId = current.id;
    }
  }
  const codexChunks = chunkProjectInstructions(text, 4_000).length;
  return {
    blockBytes: utf8Length(text),
    codexChunks,
    systemRequests: turns,
    systemHistoryCopies: 0,
    promptHistoryCopies,
    codexHistoryCopies: codexChunks * (1 + changesAt.size + compactionsAt.size),
  };
}
