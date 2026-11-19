// @effect-diagnostics nodeBuiltinImport:off -- Executes the generated extension at Pi's JavaScript boundary.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";
import { PI_T3_PROJECT_INSTRUCTIONS_COMMAND } from "@t3tools/plusplus/projectInstructions";
import { PI_T3_MCP_EXTENSION_SOURCE } from "./mcpExtensionSource.ts";

type AgentStartEvent = {
  systemPrompt: string;
  systemPromptOptions?:
    | {
        sections?: Record<string, string> | null;
        forceSystemPrompt?: string;
      }
    | undefined;
};

type AgentStartHook = (
  event: AgentStartEvent,
  ctx: {
    cwd: string;
    isProjectTrusted: () => boolean;
    ui: { notify: (message: string, severity: string) => void };
  },
) => { systemPrompt: string } | undefined;

type CommandHandler = (args: string) => Promise<void>;

async function loadProjectInstructions() {
  const handlers = new Map<string, AgentStartHook[]>();
  const commands = new Map<string, CommandHandler>();
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: { env: {}, argv: [] },
    Buffer,
    NodePath,
    stripFrontmatter: (content: string) => content,
    pi: {
      on: (name: string, handler: AgentStartHook) => {
        const registered = handlers.get(name) ?? [];
        registered.push(handler);
        handlers.set(name, registered);
      },
      registerCommand: (name: string, options: { handler: CommandHandler }) => {
        commands.set(name, options.handler);
      },
      getCommands: () => [],
    },
  });
  const command = commands.get(PI_T3_PROJECT_INSTRUCTIONS_COMMAND);
  const hook = handlers.get("before_agent_start")?.[0];
  assert.isDefined(command);
  assert.isDefined(hook);
  return { command: command!, hook: hook! };
}

const ctx = {
  cwd: "/repo",
  isProjectTrusted: () => true,
  ui: { notify: assert.fail },
};

const encode = (text: string) => Buffer.from(text, "utf8").toString("base64url");

describe("Pi project instructions extension", () => {
  it("sets, updates and clears the dedicated prompt section without duplicating it", async () => {
    const { command, hook } = await loadProjectInstructions();
    const sections: Record<string, string> = { existing: "keep" };
    const event: AgentStartEvent = { systemPrompt: "base", systemPromptOptions: { sections } };

    await command(encode("First π instructions"));
    assert.isUndefined(hook(event, ctx));
    assert.equal(sections.t3_project_instructions, "First π instructions");
    assert.isUndefined(hook(event, ctx));
    assert.equal(sections.t3_project_instructions, "First π instructions");

    await command(encode("Updated instructions"));
    assert.isUndefined(hook(event, ctx));
    assert.deepEqual(sections, {
      existing: "keep",
      t3_project_instructions: "Updated instructions",
    });

    await command("");
    assert.isUndefined(hook(event, ctx));
    assert.deepEqual(sections, { existing: "keep" });
  });

  it.each([
    { name: "without sections", systemPromptOptions: undefined },
    { name: "with null sections", systemPromptOptions: { sections: null } },
    {
      name: "with a forced system prompt",
      systemPromptOptions: { sections: {}, forceSystemPrompt: "forced" },
    },
  ])("appends changes once $name and stops after clearing", async ({ systemPromptOptions }) => {
    const { command, hook } = await loadProjectInstructions();
    await command(encode("First π instructions"));
    const first = hook({ systemPrompt: "base", systemPromptOptions }, ctx);
    assert.equal(first?.systemPrompt, "base\n\nFirst π instructions");

    const repeated = hook({ systemPrompt: first!.systemPrompt, systemPromptOptions }, ctx);
    assert.isUndefined(repeated);

    await command(encode("Updated instructions"));
    const updated = hook({ systemPrompt: "base", systemPromptOptions }, ctx);
    assert.equal(updated?.systemPrompt, "base\n\nUpdated instructions");

    await command("   ");
    assert.isUndefined(hook({ systemPrompt: "base", systemPromptOptions }, ctx));
  });
});
