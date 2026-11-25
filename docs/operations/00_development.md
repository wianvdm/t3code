# Development

## First checkout

Install [Vite+](https://viteplus.dev/guide/) (`vp` provides the pinned Node version from `package.json`):

```sh
curl -fsSL https://vite.plus | bash
# Windows PowerShell: irm https://vite.plus/ps1 | iex
```

On Windows, clone with long paths enabled so `.repos/` checks out cleanly:

```powershell
git clone -c core.longpaths=true https://github.com/pingdotgg/t3code.git
```

From the repository root:

```sh
vp i
vp run dev
```

Open the pairing URL printed by the dev runner (the bare origin does not authenticate a new browser). Prefer a container? See [Dev container](./01_devcontainer.md).

## Forge mirror (optional)

GitHub is the source of truth; [source.tanstack.com/@pingdotgg/t3code](https://source.tanstack.com/@pingdotgg/t3code) is a two-way mirror for parallel agent work:

```sh
git remote set-url origin https://source.tanstack.com/@pingdotgg/t3code.git
git remote add github https://github.com/pingdotgg/t3code.git
src auth login --web && src auth setup-git
```

With `origin` on the mirror, use `src` instead of `gh`. PRs into `main` still merge on GitHub, and numbers can differ between forges—use the GitHub number in text that reaches GitHub.

## Running dev servers

- `vp run dev` (server + web), `vp run dev:desktop` (Electron), `vp run dev:server`, `vp run dev:web`. See [apps/mobile/README.md](../../apps/mobile/README.md) for mobile.
- Pass flags directly after the task name (e.g. `vp run dev --home-dir /tmp/t3code-dev`, `--browser`).
- **State and ports:** Linked worktrees default to `<worktree>/.t3/userdata` (outranking `T3CODE_HOME`) and seed on first start from a read-only snapshot of `~/.t3/userdata/statev2.sqlite` when it is at most 500 MiB (`--no-seed` or `T3CODE_DEV_SEED=0` skips; `vp run migrate-dev-db` refreshes manually). Plain clones and the main checkout default to `~/.t3/dev`. Never point a dev server at `~/.t3/userdata`. Read actual ports from `[dev-runner]` output (`T3CODE_PORT_OFFSET` / `T3CODE_DEV_INSTANCE` override).
- **Resource monitor:** First start builds `native/resource-monitor` via Cargo when missing; without Rust, dev starts without process telemetry.
- **Sharing:** `vp run dev --share` exposes the web port over Tailscale and prints a pairing URL. Add `--built` to serve `apps/web/dist` via `vp build --watch` (no HMR, faster over slow links). Never set `VITE_HTTP_URL` or `VITE_WS_URL` in dev—Vite proxies `/api` and `/ws` single-origin.
- **Startup profiling:** `vp run profile:startup` captures the first 20 s of Node processes under `.t3/startup-profiles/<timestamp>`.

### Replay provider

`vp run dev` registers `Replay (dev)` ([dev-replay-agent.ts](../../apps/server/scripts/dev-replay-agent.ts)), a local ACP agent that streams recorded transcripts without calling a paid model. Add scenarios under `SCENARIOS` pointing at a generic ACP fixture (`registry_transcript.ndjson`) or a file in `apps/server/scripts/dev-replay`.

### Reusable dev credential

Only use this on a hostname where you trust every service (browsers share cookies across ports on the same hostname). Generate one secret once and put it in the main checkout's gitignored `.env` (which `t3.json` links into worktrees):

```sh
openssl rand -hex 32
# Add to .env: T3CODE_DEV_AUTH_TOKEN=<value>
```

Restart `vp run dev --share` and open its printed pairing URL once per browser profile. Never commit or publish the token or startup URLs. Desktop and non-dev servers ignore it; see [environment auth](../internals/04_environment-auth.md#reusable-dev-credential).

## Checks

- `vp run check:changed` — CI's fast checks for your branch (format, lint, knip, affected typechecks, nearby tests, and React Compiler coverage).
- Focused iteration: `vp test run <files>`, `vp lint <files>`, `vp run --filter <pkg> typecheck`, `vp run knip:check`, `vp run lint:mobile`.
- `apps/web` uses real Chromium (`*.browser.test.{ts,tsx}`) for DOM/React tests (no jsdom) and Node for `*.test.ts`.
- Typechecking uses `effect-tsgo tsrs --noEmit` (`@effect/tsgo`), not `typescript` (except `apps/marketing` for Astro). On Windows, open the workspace through WSL for VS Code's `.vscode/tsdk/tsgo`.

Windows verification is scoped and aggregates through CI's `Check`: a change that can affect the
desktop distribution or the release scripts runs the affected packages in the desktop distribution
closure (desktop's workspace dependencies, without client-runtime's web-only provider and
source-control registries), plus `scripts`, on a Windows runner; every other PR skips the lane.
The runner tests each selected package to completion and fails at the end if any package failed,
so one run exposes every failure instead of stopping at the first. `Check` also rejects
a run whose change detection fell back (`fail_open`), so an unresolvable diff never merges on
healthy-looking skips. The [Windows lane](../../.github/workflows/windows-tests.yml) still takes
manual runs for focused investigation over one package or a file list; Windows is not an
individually required check.

## Merging pull requests

Two statuses are required: `Check` and `Agent context budget`. `Check` is the aggregate job at the end
of [ci.yml](../../.github/workflows/ci.yml). It fails when any job fails, is cancelled, or is skipped
with no reason, so it covers every gate above, plus `Shared Persistence Compat` and the release smoke
run. Persistence compat compares this branch's migrations with a fresh fetch of upstream `main`, and
fails on fork-only migrations or DDL divergence. `Agent context budget` fails when a PR raises
`apps/server/src/provider/agentContextBudget.json` above main's.

Agent context growth is sometimes correct. The `agent-context-increase` label accepts it on purpose:
review the added model-facing text against [the eval rules](../../AGENTS.md#evals), run the evals that
cover it, and only then add the label. It records an argued override, not a routine unblock.

CodeRabbit comments are advisory input, never a gate. Verify each finding against the source, fix the
real ones, and dismiss false positives with a written reason.

A second human approval is not part of the gate in this fork. Working solo, merge your own PR once
both statuses pass on the latest commit. Squash merge with the PR title as the commit message: one
conventional title in plain language, such as `fix(web): new threads no longer spike CPU`.

Stacks are fine when one problem genuinely decomposes: a main PR plus focused child PRs that each
stand alone. One problem per PR still holds, and the stack merges bottom-up.

External PRs run CI under `pull_request`, so fork code gets a read-only token and no repository
secrets. Do not add a workflow that installs, builds, or tests untrusted code under
`pull_request_target`; [pr-size.yml](../../.github/workflows/pr-size.yml) is the narrow exception and
reads PR commits only as passive git data.

### Upstream sync designations

`upstream-sync` is a protected designation, not a taxonomy tag: a verified designation forces the
full CI pipeline (Windows included) plus the `Upstream Sync Merge` identity validation on a sync PR,
and an invalid or unproven claim forces the same full run and fails `Check`. Only maintainers/triage
may attach or remove it, plus the reconciliation workflow's own official `github-actions[bot]`
writes; [upstream-sync-pr.yml](../../.github/workflows/upstream-sync-pr.yml) removes unauthorized
additions and restores unauthorized removals of a provable designation.

The fork-boundary check (#39, A7) is not implemented yet. When it lands, it must resolve the
designation through `resolveUpstreamSyncDesignation` in
[upstream-sync-pr.cjs](../../.github/scripts/upstream-sync-pr.cjs), executed from trusted base code:

- Exclude only PRs whose designation resolves to `designated`. Nothing else is a sync PR.
- `invalid` results and lookup errors mean no exclusion, and the error must be surfaced; never fail
  open into skipping the boundary check.
- Never infer the designation from the raw label's presence, branch name, PR title or body, or the
  author. Those are all attacker-controlled inputs; the resolver's timeline and permission proof is
  the only source of truth.

## Desktop artifacts

Unsigned local builds write to `release/`:

```sh
vp run dist:desktop:dmg
vp run dist:desktop:linux
vp run dist:desktop:win
# Linux ARM64: vp run dist:desktop:artifact --platform linux --target AppImage --arch arm64
```

Run `vp run dist:desktop:artifact --help` for `--arch`, `--signed`, and `--keep-stage`.

### Linux AppImage prerequisites

Build on Linux (the browser-secret helper links against `libsecret`). Install Rust stable (`rustup`), C/C++ build tools, `libsecret` dev headers, `pkg-config`, ImageMagick, and Electron runtime libs (`gtk3`, `nss`, `alsa`, `gbm`):

```sh
# Ubuntu 24.04 / Debian 13 (on 22.04/Debian 12 use libgtk-3-0 and libasound2)
sudo apt-get install build-essential libsecret-1-dev pkg-config imagemagick libgtk-3-0t64 libnss3 libasound2t64 libgbm1

# Fedora
sudo dnf install gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick gtk3 nss alsa-lib mesa-libgbm

# Arch
sudo pacman -S base-devel libsecret pkgconf imagemagick gtk3 nss alsa-lib mesa
```

### macOS DMG prerequisites

Install Xcode Command Line Tools (`xcode-select --install`) and Rust. For cross-arch/universal builds:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

### Windows installer prerequisites

Install Rust, Python 3, and Visual Studio Build Tools (**Desktop development with C++**, Windows SDK, MSVC build tools, Spectre-mitigated libraries), then add the Rust target:

```powershell
rustup target add x86_64-pc-windows-msvc   # or aarch64-pc-windows-msvc
```

WSL support also requires passing the Linux CLI archive via `--wsl-runtime`; see [release runbook](./03_release.md#windows-payload-topology-and-update-validation). For signing and macOS passkeys, see [release](./03_release.md) and [Connect setup](./02_connect-setup.md#desktop-passkeys).
