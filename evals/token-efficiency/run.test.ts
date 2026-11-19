import {
  adaptCore,
  BUNDLED_CORE,
  formatTokenEfficiencyInstructions,
} from "@t3tools/provider-core/server/projectInstructions";
import { describe, expect, it } from "vite-plus/test";
import { cases } from "./cases.ts";
import { calculatePromptOverhead, gradeTranscript, summarizeTokenEfficiency } from "./grade.ts";

const selectiveReading = cases[0];
const errorExit = cases[1];
const ordinaryEdit = cases[2];
if (
  selectiveReading?.kind !== "selective-reading" ||
  errorExit?.kind !== "error-exit-status" ||
  ordinaryEdit?.kind !== "ordinary-edit"
) {
  throw new Error("Eval case order changed.");
}

describe("token-efficiency graders", () => {
  it("requires selective search before a full read and bounds context bytes", () => {
    const pass = gradeTranscript(selectiveReading, {
      exchanges: [
        { name: "grep", arguments: { pattern: "total" }, output: "src/orders.ts:142: total" },
        {
          name: "read_file",
          arguments: { path: "src/orders.ts", start_line: 142, end_line: 145 },
          output: "calculateOrderTotal",
        },
      ],
      final: "calculateOrderTotal in src/orders.ts",
    });
    const fullRead = gradeTranscript(selectiveReading, {
      exchanges: [
        { name: "read_file", arguments: { path: "src/orders.ts" }, output: "x".repeat(2_001) },
      ],
      final: "calculateOrderTotal",
    });

    expect(pass.pass).toBe(true);
    expect(fullRead.pass).toBe(false);
    expect(fullRead.contextBytes).toBe(2_001);
  });

  it("requires the real exit status and relevant error", () => {
    const pass = gradeTranscript(errorExit, {
      exchanges: [
        {
          name: "run_command",
          arguments: { command: "set -o pipefail; npm test | tail -20" },
          output: "AssertionError: expected 42, received 41\nExit status 1.",
        },
      ],
      final: "Tests failed with exit status 1: AssertionError: expected 42, received 41",
    });
    const masked = gradeTranscript(errorExit, {
      exchanges: [
        {
          name: "run_command",
          arguments: { command: "npm test | tail -5" },
          output: "Exit status 0.",
        },
      ],
      final: "The original exit status was 1. AssertionError: expected 42, received 41",
    });

    expect(pass.pass).toBe(true);
    expect(masked.pass).toBe(false);
  });

  it("keeps ordinary edits within the tool-call budget", () => {
    const exchange = {
      name: "edit_file",
      arguments: { path: "src/config.ts", old_text: "retries: 2", new_text: "retries: 3" },
      output: "Updated src/config.ts.",
    };
    expect(gradeTranscript(ordinaryEdit, { exchanges: [exchange], final: "Done." }).pass).toBe(
      true,
    );
    expect(
      gradeTranscript(ordinaryEdit, { exchanges: [exchange, exchange], final: "Done." }).pass,
    ).toBe(false);
  });
});

describe("token-efficiency run summary", () => {
  it("uses the majority verdict and reports enabled-minus-disabled usage", () => {
    const rows = (["disabled", "enabled"] as const).flatMap((arm) =>
      [true, true, false].map((pass, index) => ({
        case: "selective-reading",
        model: "model-a",
        arm,
        sample: index + 1,
        tokens: arm === "enabled" ? 15 : 10,
        grade: {
          pass: arm === "disabled" ? pass : index === 0,
          toolCalls: index + (arm === "enabled" ? 2 : 1),
        },
      })),
    );

    expect(summarizeTokenEfficiency(rows)).toEqual({
      verdicts: [
        {
          model: "model-a",
          case: "selective-reading",
          arm: "disabled",
          passedSamples: 2,
          samples: 3,
          pass: true,
        },
        {
          model: "model-a",
          case: "selective-reading",
          arm: "enabled",
          passedSamples: 1,
          samples: 3,
          pass: false,
        },
      ],
      deltas: [
        {
          model: "model-a",
          case: "selective-reading",
          tokenDelta: 15,
          toolCallDelta: 3,
        },
      ],
    });
  });
});

describe("token-efficiency prompt overhead", () => {
  it("uses the shipped CORE and counts changes and compaction resends", () => {
    const adapted = adaptCore(BUNDLED_CORE.raw);
    if (adapted._tag !== "Adapted") throw new Error("Bundled CORE rejected.");
    const instructions = formatTokenEfficiencyInstructions(adapted.text);
    const overhead = calculatePromptOverhead(instructions);

    expect(overhead.blockBytes).toBe(Buffer.byteLength(instructions));
    expect(overhead.systemRequests).toBe(10);
    expect(overhead.systemHistoryCopies).toBe(0);
    expect(overhead.promptHistoryCopies).toBe(3);
    expect(overhead.codexChunks).toBe(1);
    expect(overhead.codexHistoryCopies).toBe(3);
  });
});
