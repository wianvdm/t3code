import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { applyServerSettingsPatch } from "./serverSettings.ts";

describe("contextBridge sidecar patching", () => {
  const routes = { codex: { instructions: "claudeAgent" as const } };
  const seeded = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
    contextBridge: { enabled: true, defaultSource: "pi", routes },
  });

  it("dual-writes the released field and the sidecar from a legacy patch", () => {
    expect(seeded.contextBridge).toEqual({ enabled: true, defaultSource: "pi", routes });
    expect(seeded.plusplus).toEqual({
      contextBridge: { enabled: true, defaultSource: "pi", routes },
    });
  });

  it("leaves settings without a contextBridge patch sparse", () => {
    const untouched = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { worktreesDirectory: "" });
    expect("plusplus" in untouched).toBe(false);
  });

  it("merges enabled and defaultSource but replaces routes wholesale", () => {
    const patched = applyServerSettingsPatch(seeded, {
      contextBridge: { enabled: false, routes: {} },
    });
    expect(patched.contextBridge).toEqual({ enabled: false, defaultSource: "pi", routes: {} });
    expect(patched.plusplus).toEqual({ contextBridge: patched.contextBridge });
  });

  it("lets a valid sidecar patch win over conflicting legacy patch fields", () => {
    const patched = applyServerSettingsPatch(seeded, {
      contextBridge: { enabled: false },
      plusplus: { contextBridge: { enabled: true, defaultSource: "claudeAgent" } },
    });
    expect(patched.contextBridge).toEqual({
      enabled: true,
      defaultSource: "claudeAgent",
      routes,
    });
    expect(patched.plusplus).toEqual({ contextBridge: patched.contextBridge });
  });

  it("falls back to the legacy patch for a malformed sidecar patch", () => {
    const patched = applyServerSettingsPatch(seeded, {
      contextBridge: { enabled: false },
      plusplus: { contextBridge: { enabled: "yes" } },
    });
    expect(patched.contextBridge).toEqual({
      enabled: false,
      defaultSource: "pi",
      routes,
    });
  });

  it("resolves a legacy patch against sidecar-first current settings", () => {
    const sidecarCurrent: ServerSettings = {
      ...seeded,
      contextBridge: { enabled: false, defaultSource: "claudeAgent", routes: {} },
      plusplus: { contextBridge: { enabled: true, defaultSource: "pi", routes } },
    };
    const patched = applyServerSettingsPatch(sidecarCurrent, {
      contextBridge: { defaultSource: "grok" },
    });
    expect(patched.contextBridge).toEqual({ enabled: true, defaultSource: "grok", routes });
  });

  it("preserves unknown sidecar areas from current settings and patches", () => {
    const withFuture: ServerSettings = {
      ...seeded,
      plusplus: { contextBridge: seeded.contextBridge, future: { kept: 1 } },
    };
    const patched = applyServerSettingsPatch(withFuture, {
      contextBridge: { enabled: false },
      plusplus: { other: 2 },
    });
    expect(patched.plusplus).toEqual({
      future: { kept: 1 },
      other: 2,
      contextBridge: patched.contextBridge,
    });
  });

  it("ignores a malformed carrier on current settings when patching other keys", () => {
    const patched = applyServerSettingsPatch(seeded, { worktreesDirectory: "" });
    expect(patched.contextBridge).toEqual(seeded.contextBridge);
    expect(patched.plusplus).toEqual(seeded.plusplus);
  });
});
