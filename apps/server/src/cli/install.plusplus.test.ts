import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { forkInstallCommand } from "@t3tools/plusplus/forkInstallCommands";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { installCli } from "./install.ts";

it.layer(NodeServices.layer)("fork CLI install guidance", (it) => {
  it.effect("uses fork installers when the standalone runtime is unavailable", () =>
    Effect.gen(function* () {
      for (const [platform, shell] of [
        ["linux", "sh"],
        ["win32", "powershell"],
      ] as const) {
        const error = yield* installCli().pipe(
          Effect.flip,
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.Platform, platform),
        );
        expect(error.message).toContain(forkInstallCommand(shell));
        expect(error.message).not.toContain("t3.codes/install");
      }
    }),
  );
});
