import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  PI_T3_MCP_EXTENSION_FILENAME,
  T3_PI_CONTEXT_BRIDGE_REPORT_PATH_ENV,
} from "./mcpExtensionSource.ts";
import {
  buildPiRpcLaunch,
  materializePiT3McpExtension,
  piT3ContextBridgeReportPath,
  removePiT3SessionScopedFiles,
} from "./mcpInjection.ts";

describe("pi T3 MCP injection ++", () => {
  it.effect("materializes a session-scoped extension with the bridge payload embedded", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-extensions-" });
      const contextBridge = {
        instructions: {
          source: "claudeAgent",
          block: "<!-- t3-context-bridge -->\nBRIDGED_CONTENT_MARKER",
          files: [
            {
              path: "/home/.claude/CLAUDE.md",
              tier: "global" as const,
              status: "injected" as const,
            },
          ],
        },
        skillRoots: ["/home/.codex/skills"],
      };
      const dest = yield* materializePiT3McpExtension(cacheDir, {
        contextBridge,
        sessionId: "session-1",
      });
      assert.isTrue(dest.endsWith("pi-t3-mcp-extension.session-1.ts"));
      const source = yield* fs.readFileString(dest);
      assert.include(source, "BRIDGED_CONTENT_MARKER");
      assert.include(source, "/home/.codex/skills");

      // An unchanged payload is not rewritten; a changed one is.
      const firstStat = yield* fs.stat(dest);
      yield* materializePiT3McpExtension(cacheDir, { contextBridge, sessionId: "session-1" });
      const secondStat = yield* fs.stat(dest);
      assert.deepEqual(secondStat.mtime, firstStat.mtime);
      const updated = {
        ...contextBridge,
        instructions: { ...contextBridge.instructions, block: "UPDATED_BRIDGED_CONTENT" },
      };
      yield* materializePiT3McpExtension(cacheDir, {
        contextBridge: updated,
        sessionId: "session-1",
      });
      assert.include(yield* fs.readFileString(dest), "UPDATED_BRIDGED_CONTENT");

      // Sessions without a route share the static extension file.
      const shared = yield* materializePiT3McpExtension(cacheDir);
      assert.isTrue(shared.endsWith(PI_T3_MCP_EXTENSION_FILENAME));
      assert.include(yield* fs.readFileString(shared), "const CONTEXT_BRIDGE = null;");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("bounds session-scoped filenames for deeply delegated session ids", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-extensions-" });
      const contextBridge = {
        instructions: {
          source: "claudeAgent" as const,
          block: "BRIDGED_CONTENT_MARKER",
          files: [],
        },
        skillRoots: [],
      };
      // Delegated sessions chain their parent ids; these reach the 254-char
      // component length that overflows NTFS once the extension prefix and
      // jiti's cache suffix are appended.
      const delegatedSegment = (depth: number) =>
        `delegated-task-${depth}-c5f1e0d9-8a3b-4f2e-9d77-1a2b3c4d5e6f`;
      const sessionId = [
        "provider-session",
        "provider-instance",
        "pi-local",
        "shared",
        ...[0, 1, 2, 3].map(delegatedSegment),
      ].join(":");
      const siblingId = [
        "provider-session",
        "provider-instance",
        "pi-local",
        "shared",
        ...[0, 1, 2, 3].map((depth) => `${delegatedSegment(depth)}-sibling`),
      ].join(":");

      const dest = yield* materializePiT3McpExtension(cacheDir, { contextBridge, sessionId });
      const destName = dest.slice(dest.lastIndexOf("/") + 1);
      assert.isTrue(dest.startsWith(`${cacheDir.replace(/\\/g, "/")}/`));
      assert.isTrue(destName.endsWith(".ts"));
      assert.isBelow(destName.length, 128);
      assert.isTrue(yield* fs.exists(dest));
      assert.equal(
        yield* materializePiT3McpExtension(cacheDir, { contextBridge, sessionId }),
        dest,
      );

      const reportPath = piT3ContextBridgeReportPath(cacheDir, sessionId);
      assert.isBelow(reportPath.slice(reportPath.lastIndexOf("/") + 1).length, 128);
      yield* fs.makeDirectory(`${cacheDir}/context-bridge`);
      yield* fs.writeFileString(reportPath, "{}");

      // Distinct sessions keep distinct files, and removal still targets the
      // same bounded paths that materialization wrote.
      const siblingDest = yield* materializePiT3McpExtension(cacheDir, {
        contextBridge,
        sessionId: siblingId,
      });
      assert.notEqual(siblingDest, dest);
      yield* removePiT3SessionScopedFiles(cacheDir, sessionId);
      assert.isFalse(yield* fs.exists(dest));
      assert.isFalse(yield* fs.exists(reportPath));
      assert.isTrue(yield* fs.exists(siblingDest));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the session-scoped files and keeps the shared extension", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-extensions-" });
      const contextBridge = {
        instructions: {
          source: "claudeAgent",
          block: "BRIDGED_CONTENT_MARKER",
          files: [],
        },
        skillRoots: [],
      };
      const sessionDest = yield* materializePiT3McpExtension(cacheDir, {
        contextBridge,
        sessionId: "session-1",
      });
      const sharedDest = yield* materializePiT3McpExtension(cacheDir);
      const reportPath = piT3ContextBridgeReportPath(cacheDir, "session-1");
      yield* fs.makeDirectory(`${cacheDir}/context-bridge`);
      yield* fs.writeFileString(reportPath, "{}");

      yield* removePiT3SessionScopedFiles(cacheDir, "session-1");

      assert.isFalse(yield* fs.exists(sessionDest));
      assert.isFalse(yield* fs.exists(reportPath));
      assert.isTrue(yield* fs.exists(sharedDest));

      // Already-gone files stay a no-op, so teardown never fails on a session
      // whose extension never wrote its report.
      yield* removePiT3SessionScopedFiles(cacheDir, "session-1");
      assert.isTrue(yield* fs.exists(sharedDest));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("passes the context bridge report path only to bridged sessions and strips inherited ones", () => {
    const reportPath = piT3ContextBridgeReportPath("C:\\t3\\cache", "session/1");
    assert.equal(reportPath, "C:/t3/cache/context-bridge/session_1.json");

    const bridged = buildPiRpcLaunch({
      launchArgs: [],
      environment: { [T3_PI_CONTEXT_BRIDGE_REPORT_PATH_ENV]: "/inherited/report.json" },
      mcpSession: undefined,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.session-1.ts",
      contextBridgeReportPath: reportPath,
    });
    assert.equal(bridged.env[T3_PI_CONTEXT_BRIDGE_REPORT_PATH_ENV], reportPath);

    const unbridged = buildPiRpcLaunch({
      launchArgs: [],
      environment: { [T3_PI_CONTEXT_BRIDGE_REPORT_PATH_ENV]: "/inherited/report.json" },
      mcpSession: undefined,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
    });
    assert.isUndefined(unbridged.env[T3_PI_CONTEXT_BRIDGE_REPORT_PATH_ENV]);
  });
});
