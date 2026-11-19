#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  adaptCore,
  BUNDLED_CORE,
  formatTokenEfficiencyInstructions,
  tokenEfficiencyInstructionsId,
} from "@t3tools/provider-core/server/projectInstructions";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Schema from "effect/Schema";
import { proxyConfig } from "../shared/proxy.ts";
import { cases, type TokenEfficiencyCase } from "./cases.ts";
import { calculatePromptOverhead, gradeTranscript, type ToolExchange } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", multiple: true },
    baseline: { type: "string" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "3" },
    "core-file": { type: "string" },
  },
});
if (!values.out) throw new Error("Use --out <directory> [--model <id>] [--case <ids>].");
const selected = values.case ? cases.filter((entry) => values.case!.includes(entry.id)) : cases;
if (selected.length === 0) throw new Error("No cases selected.");
const models = values.model ?? ["gpt-6-luna"];
const samples = Number(values.samples);
if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be positive.");

const adapted = adaptCore(
  values["core-file"] ? NodeFS.readFileSync(values["core-file"], "utf8") : BUNDLED_CORE.raw,
);
if (adapted._tag !== "Adapted") throw new Error(`CORE rejected: ${adapted.reason}.`);
const instructions = formatTokenEfficiencyInstructions(adapted.text);
const raw = values["core-file"]
  ? NodeFS.readFileSync(values["core-file"], "utf8")
  : BUNDLED_CORE.raw;
const blobSha = values["core-file"]
  ? NodeCrypto.createHash("sha1")
      .update(`blob ${Buffer.byteLength(raw)}\0`)
      .update(raw)
      .digest("hex")
  : BUNDLED_CORE.blobSha;
const instructionsId = tokenEfficiencyInstructionsId(blobSha);

const ordersSource = [
  "import type { Order } from './types';",
  ...Array.from({ length: 140 }, (_, index) => `export const orderFixture${index} = ${index};`),
  "export function calculateOrderTotal(order: Order): number {",
  "  return order.items.reduce((total, item) => total + item.price * item.quantity, 0);",
  "}",
].join("\n");
const initialFiles = () =>
  new Map<string, string>([
    ["src/orders.ts", ordersSource],
    ["src/config.ts", "export const config = {\n  retries: 2,\n};\n"],
  ]);

const tools = [
  {
    type: "function",
    name: "grep",
    description: "Search simulated repository lines with a fixed string.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
  {
    type: "function",
    name: "symbol_search",
    description: "Find a function symbol and its location without reading the whole file.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    type: "function",
    name: "read_file",
    description: "Read a simulated file, optionally with one-based start_line and end_line.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        start_line: { type: "integer" },
        end_line: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    type: "function",
    name: "run_command",
    description:
      "Run a simulated shell command. Only npm test and optional tail pipelines are supported.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    type: "function",
    name: "edit_file",
    description: "Replace one exact string in a simulated file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
];

const decodeResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      output: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
      usage: Schema.optional(Schema.Struct({ total_tokens: Schema.optional(Schema.Number) })),
    }),
  ),
);
const decodeArguments = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const executeTool = (
  entry: Exclude<TokenEfficiencyCase, { readonly kind: "prompt-overhead" }>,
  files: Map<string, string>,
  name: string,
  args: Record<string, unknown>,
): string => {
  if (name === "grep" || name === "symbol_search") {
    const needle = String(args.pattern ?? args.name ?? "");
    const matches = [...files].flatMap(([path, text]) =>
      text
        .split("\n")
        .flatMap((line, index) => (line.includes(needle) ? [`${path}:${index + 1}:${line}`] : [])),
    );
    return matches.join("\n") || "No matches.";
  }
  if (name === "read_file") {
    const text = files.get(String(args.path));
    if (text === undefined) return "File not found.";
    const lines = text.split("\n");
    const start = Number(args.start_line ?? 1);
    const end = Number(args.end_line ?? lines.length);
    return lines
      .slice(start - 1, end)
      .map((line, index) => `${start + index}: ${line}`)
      .join("\n");
  }
  if (name === "run_command") {
    const command = String(args.command ?? "");
    if (!command.includes("npm test")) return "Unsupported command. Exit status 2.";
    const output = [
      ...Array.from({ length: 80 }, (_, index) => `test setup diagnostic ${index}`),
      "FAIL src/orders.test.ts",
      "AssertionError: expected 42, received 41",
    ];
    const tailed = /\|\s*tail\b/.test(command);
    const pipefail = /pipefail/.test(command);
    const status = tailed && !pipefail ? 0 : 1;
    return `${(tailed ? output.slice(-5) : output).join("\n")}\nExit status ${status}.`;
  }
  if (name === "edit_file") {
    const path = String(args.path);
    const text = files.get(path);
    const oldText = String(args.old_text);
    if (text === undefined || !text.includes(oldText)) return "Edit target not found.";
    files.set(path, text.replace(oldText, String(args.new_text)));
    return `Updated ${path}.`;
  }
  return "Unknown tool.";
};

const postResponse = Effect.fn("evaluateTokenEfficiency.post")(function* (
  body: unknown,
  proxy: ReturnType<typeof proxyConfig>,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.post(`${proxy.url}/responses`).pipe(
    HttpClientRequest.setHeaders(proxy.headers),
    HttpClientRequest.bodyJson(body),
    Effect.flatMap(client.execute),
  );
  const text = yield* response.text;
  if (response.status !== 200) {
    return yield* Effect.die(new Error(`Model API ${response.status}: ${text}`));
  }
  return decodeResponse(text);
});

const runModelCase = async (
  entry: Exclude<TokenEfficiencyCase, { readonly kind: "prompt-overhead" }>,
  model: string,
  arm: "disabled" | "enabled",
  sample: number,
  proxy: ReturnType<typeof proxyConfig>,
) => {
  const system = [
    "You are a coding agent working in a simulated repository. Use the provided tools and finish the requested task.",
    ...(arm === "enabled" ? [instructions] : []),
  ].join("\n\n");
  const input: Array<unknown> = [{ role: "user", content: entry.prompt }];
  const mutableExchanges: Array<ToolExchange> = [];
  const files = initialFiles();
  let final = "";
  let tokens = 0;
  for (let step = 0; step < 12; step++) {
    const decoded = await Effect.runPromise(
      postResponse(
        {
          model,
          instructions: system,
          input,
          tools,
          store: false,
          include: ["reasoning.encrypted_content"],
        },
        proxy,
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    tokens += decoded.usage?.total_tokens ?? 0;
    input.push(...decoded.output);
    const calls = decoded.output.filter((item) => item.type === "function_call");
    final = decoded.output
      .filter((item) => item.type === "message")
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part ? String(part.text) : "",
      )
      .join("");
    if (calls.length === 0) break;
    for (const call of calls) {
      const args = decodeArguments(String(call.arguments));
      const name = String(call.name);
      const output = executeTool(entry, files, name, args);
      mutableExchanges.push({ name, arguments: args, output });
      input.push({ type: "function_call_output", call_id: call.call_id, output });
    }
  }
  const transcript = { exchanges: mutableExchanges, final };
  return {
    case: entry.id,
    model,
    arm,
    sample,
    tokens,
    transcript,
    grade: gradeTranscript(entry, transcript),
  };
};

const modelCases = selected.filter(
  (entry): entry is Exclude<TokenEfficiencyCase, { readonly kind: "prompt-overhead" }> =>
    entry.kind !== "prompt-overhead",
);
const results = [];
if (modelCases.length > 0) {
  const proxy = proxyConfig();
  for (const model of models) {
    for (const entry of modelCases) {
      for (const arm of ["disabled", "enabled"] as const) {
        for (let sample = 1; sample <= samples; sample++) {
          results.push(await runModelCase(entry, model, arm, sample, proxy));
        }
      }
    }
  }
}
const overhead = selected.some((entry) => entry.kind === "prompt-overhead")
  ? calculatePromptOverhead(instructions)
  : undefined;
const baseline = values.baseline
  ? (JSON.parse(NodeFS.readFileSync(values.baseline, "utf8")) as Array<{
      readonly case: string;
      readonly model: string;
      readonly arm: string;
      readonly sample: number;
      readonly grade: { readonly pass: boolean };
    }>)
  : [];
const comparisons = results.map((row) => ({
  case: row.case,
  model: row.model,
  arm: row.arm,
  sample: row.sample,
  pass: row.grade.pass,
  baselinePass: baseline.find(
    (previous) =>
      previous.case === row.case &&
      previous.model === row.model &&
      previous.arm === row.arm &&
      previous.sample === row.sample,
  )?.grade.pass,
}));
const summary = {
  instructionsId,
  instructionBytes: Buffer.byteLength(instructions),
  models,
  samples,
  tokens: results.reduce((total, row) => total + row.tokens, 0),
  cost: "not calculated",
  comparisons,
  overhead,
};
NodeFS.mkdirSync(values.out, { recursive: true });
NodeFS.writeFileSync(NodePath.join(values.out, "results.json"), JSON.stringify(results, null, 2));
NodeFS.writeFileSync(NodePath.join(values.out, "summary.json"), JSON.stringify(summary, null, 2));
process.stdout.write(`Wrote ${results.length} model samples to ${values.out}.\n`);
