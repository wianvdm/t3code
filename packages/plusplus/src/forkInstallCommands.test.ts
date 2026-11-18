// @effect-diagnostics nodeBuiltinImport:off - Reads upstream call sites for the installer source guard.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";

import { forkInstallCommand } from "./forkInstallCommands.ts";

it("builds fork installer commands with optional version pins", () => {
  expect(forkInstallCommand("sh")).toBe(
    "curl -fsSL https://raw.githubusercontent.com/WianVDM/t3code/main/scripts/install.sh | sh",
  );
  expect(forkInstallCommand("sh", "1.2.3-plusplus.4")).toBe(
    "curl -fsSL https://raw.githubusercontent.com/WianVDM/t3code/main/scripts/install.sh | T3CODE_VERSION=1.2.3-plusplus.4 sh",
  );
  expect(forkInstallCommand("powershell")).toBe(
    "irm https://raw.githubusercontent.com/WianVDM/t3code/main/scripts/install.ps1 | iex",
  );
  expect(forkInstallCommand("powershell", "1.2.3-plusplus.4")).toBe(
    "$env:T3CODE_VERSION = '1.2.3-plusplus.4'; irm https://raw.githubusercontent.com/WianVDM/t3code/main/scripts/install.ps1 | iex",
  );
});

it("keeps upstream installer URLs out of every fork call site", () => {
  const root = NodePath.resolve(import.meta.dirname, "../../..");
  const callSites = [
    "apps/server/src/cloud/servicePreflight.ts",
    "apps/server/src/cli/install.ts",
    "apps/web/src/components/InstallT3Commands.tsx",
  ];
  for (const callSite of callSites) {
    const source = NodeFS.readFileSync(NodePath.join(root, callSite), "utf8");
    expect(source, callSite).not.toContain("t3.codes/install");
    expect(source, callSite).toContain("forkInstallCommand(");
  }
});
