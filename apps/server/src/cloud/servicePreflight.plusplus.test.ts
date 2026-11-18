import { expect, it } from "@effect/vitest";
import { forkInstallCommand } from "@t3tools/plusplus/forkInstallCommands";

import { runServicePreflight } from "./servicePreflight.ts";

it("uses the fork installer with the exact version in launcher recovery", () => {
  const result = runServicePreflight({
    databasePath: "/missing/state.sqlite",
    launcherProtocol: 1,
    version: "9.8.7-plusplus.1",
  });
  const reason = result.status === "blocked" ? result.reason : "";
  expect(reason).toContain(forkInstallCommand("sh", "9.8.7-plusplus.1"));
  expect(reason).not.toContain("t3.codes/install");
});
