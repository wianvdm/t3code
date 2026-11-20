# T3 Code ++ features

T3 Code ++ follows upstream T3 Code and adds these features:

- **Context bridge** routes another provider's instructions and skills into a supported provider; Antigravity can also route hooks. Choose routes under **Settings → Providers**.
- **Token efficiency** adds an opt-in, per-project checklist that helps agents reduce unnecessary context and tool output. Read the [Token efficiency guide](./token-efficiency.md).
- **Usage limits** keeps account-level and monetary-only usage visible in pooled limits, shows provider-reported dollar amounts, and adds model vendor icons. See [Usage and limits](../../docs/user/usage.md#track-subscription-limits).
- **Process details** lists a thread's active terminals and background work, with status, elapsed time, available details, and controls to open or stop work.
- **Old-fork import** brings settings, provider sign-ins, and saved history from a previous `~/.t3-fork` installation without resuming live work. See [Importing your old fork](./install.md#importing-your-old-fork).

## Maintainer tools

- **Upstream merge drafts** let a maintainer check for an unmerged upstream release and create a local merge-draft thread from a fork checkout. Nothing is pushed. The [release runbook](./release.md#updating-from-upstream) covers the maintainer workflow.
