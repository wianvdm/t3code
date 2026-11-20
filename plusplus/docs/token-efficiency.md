# Token efficiency

Token efficiency gives the agents working on a project a short checklist for
reducing unnecessary context and tool output: reading only what a task needs,
preserving errors and exit codes, and skipping redundant tool calls. The
checklist is adapted from the
[undefdev/token-efficiency](https://github.com/undefdev/token-efficiency)
project (MIT license).

The feature is off by default and applies per project.

## Enable it

1. Open **Settings → Projects** and pick a project.
2. Turn on **Token efficiency** under **Agent instructions**.

On mobile, the same switch is on the project's settings screen. The change
applies to turns that start after you toggle it, on the selected environments.

## Automatic updates

Each server installs its own copy of the upstream **CORE** checklist and
controls automatic fetching separately. A server fetches the CORE file from
the upstream repository's `main` branch about every six hours only when at
least one of its own projects has the feature enabled. When all of its
projects have it off, that server does not fetch automatically.

Fetched changes can alter agent behaviour without a T3 Code ++ release;
enabling the feature is a decision to trust those updates.

## Offline fallback and refresh

A copy of the CORE checklist ships with the server, so the feature works
without network access. It is used until an upstream fetch succeeds, and a
failed fetch keeps the last good copy active.

The provenance card under the switch shows which copy is active and when it
was last checked:

- **Cached upstream** with a short revision id: a fetched copy is active.
- **Bundled fallback** with a short revision id and pinned commit: the shipped
  copy is active.

**Refresh now** checks upstream immediately and reports whether the active
copy was updated, unchanged, or kept after a failure. **View instructions**
shows the exact text agents receive, with links to the upstream CORE file, the
repository, the full playbook, and the license.

## CORE versus the full playbook

Only the CORE checklist is installed and delivered to agents. The upstream
project's full playbook is a larger document; it is linked from **View
instructions**, not installed or fetched.

## Which providers are covered

All built-in providers receive the checklist: Claude, Codex, OpenCode, Cursor,
Muse Code, Pi, and the ACP family (ACP Registry, Grok, Kiro, fx, Antigravity).

Most providers re-add the checklist after compacting a session's context.
Cursor reinjects it after T3's own /compress, but its native auto-compaction
is not observable, so a long Cursor session can lose the checklist too. On fx
and Antigravity reinjection is not supported, so a long session there can lose
the checklist as well. OpenCode 1.x command turns run without the checklist;
OpenCode 2.x command turns keep it. An ACP slash command skips delivery only
for that turn; the next ordinary turn delivers the checklist.

## Limits

- Provider-native subagents (a provider's own agent-spawning commands) do not
  receive the checklist. T3-managed delegated tasks are different: they run as
  turns in their own thread and follow their own project's setting.
- Disabling stops the checklist from being added to future turns, but it
  cannot retract instructions already present in a conversation.
- When a project spans a stock T3 Code server, that server does not have this
  feature; its provenance card shows **Not supported on \<environment\>**.
