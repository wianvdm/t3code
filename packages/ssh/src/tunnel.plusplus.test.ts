// @effect-diagnostics nodeBuiltinImport:off - Runs the generated runner in a real shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import * as SshTunnel from "./tunnel.ts";

const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;

describe("ssh tunnel scripts (++)", () => {
  it.each([
    { host: "Linux arm64", system: "Linux", machine: "arm64", error: true },
    { host: "Linux aarch64", system: "Linux", machine: "aarch64", error: true },
    { host: "Linux x86_64", system: "Linux", machine: "x86_64", error: false },
  ])("linux arm64 remotes fail without a ++ build: $host", ({ system, machine, error }) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-runner-plusplus-"));
    try {
      const bin = NodePath.join(root, "bin");
      NodeFS.mkdirSync(bin);
      NodeFS.mkdirSync(NodePath.join(root, "home"));
      NodeFS.writeFileSync(
        NodePath.join(bin, "uname"),
        `#!/bin/sh\ncase "$1" in -s) echo ${system} ;; -m) echo ${machine} ;; esac\n`,
        { mode: 0o755 },
      );
      NodeFS.writeFileSync(
        NodePath.join(bin, "curl"),
        "#!/bin/sh\necho 'download attempt' >&2\nexit 22\n",
        { mode: 0o755 },
      );
      const runner = NodePath.join(root, "run-t3.sh");
      NodeFS.writeFileSync(runner, SshTunnel.buildRemoteT3RunnerScript(ARCHIVE));
      const result = NodeChildProcess.spawnSync("sh", [runner, "--version"], {
        encoding: "utf8",
        env: { HOME: NodePath.join(root, "home"), PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      assert.notEqual(result.status, 0);
      if (error) {
        assert.include(result.stderr, "has no release build for Linux");
        assert.include(result.stderr, "linux-arm64");
        assert.notInclude(result.stderr, "download attempt");
      } else {
        assert.include(result.stderr, "download attempt");
      }
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
