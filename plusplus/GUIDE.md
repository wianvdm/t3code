# T3 Code ++ guide

This guide governs contributions and agent work in `WianVDM/t3code`. It takes precedence over inherited upstream guidance where they conflict.

## Remotes and upstream contact

- `origin` is `WianVDM/t3code`. `upstream` is `pingdotgg/t3code`, fetch-only with push disabled.
- Never push, open a PR, file an issue or security report, or send anything else to `pingdotgg/t3code`. Keep all work and reports in `WianVDM/t3code`.

## Issues and pull requests

- Link each PR to the issue it addresses. Use sub-issues to divide multi-part work into focused, reviewable units.
- Keep each PR to [one problem](../CONTRIBUTING.md#one-problem), including only the changes that problem needs.
- The solo maintainer self-reviews every PR and merges only when `Check`, `Agent context budget`, and `Fork Boundaries` pass.

## ++ architecture

Follow [plusplus/ARCHITECTURE.md](ARCHITECTURE.md) for ++ directory conventions, upstream ownership, and seam rules.

## Upstream syncs and releases

Follow [the release runbook](docs/release.md#updating-from-upstream) for upstream syncs and [releases](docs/release.md). After every upstream sync, re-check:

- every new or renamed workflow file;
- every restored workflow whose jobs are no longer all skipped on the fork;
- every new `pull_request_target` or `workflow_run` workflow;
- every new `uses: ./.github/workflows/<disabled file>` reference.

## Verification and security

Follow the [verification expectations](../AGENTS.md#verifying) and report vulnerabilities through [the fork's security policy](../.github/SECURITY.md).

## Inherited upstream policies

Upstream's vouching and automatic closure of outside PRs, [release process](../docs/operations/release.md), and upstream-only hosting such as `app.t3.codes` deploys do not govern this fork. Leave those policies in inherited upstream files.
