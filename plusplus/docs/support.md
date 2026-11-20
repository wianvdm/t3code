# Support and releases

T3 Code ++ is maintained separately from upstream by one person. Support and fixes are best effort, and only the latest stable release receives fixes.

## Release channel

Stable is the only public channel. Releases are published on [GitHub Releases](https://github.com/WianVDM/t3code/releases) after maintainer approval. The v0.1.9 line uses `v0.1.9-plusplus.N` tags, where `N` identifies the ++ revision on that upstream base.

There is no nightly channel. Preview builds are maintainer-only dry runs and receive no support.

See [Install T3 Code ++](./install.md) for installation and updates.

## Available builds

The fork publishes desktop and CLI builds for Windows x64 and Linux x64, plus unsigned macOS arm64 builds that require manual updates. It does not publish a hosted web app or mobile-store builds. The CLI and desktop app provide the local web client; browsers on other devices can connect through [remote access](../../docs/user/remote-access.md).

## Report an issue

Search existing issues, then use the [fork's issue forms](https://github.com/WianVDM/t3code/issues/new/choose). Report ++ bugs and feature requests in the fork. If a behavior exists only in upstream T3 Code, you may report it to upstream yourself; this repository never forwards reports or other work upstream.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/WianVDM/t3code/security/advisories/new), not a public issue. Reports stay private between you and the maintainer until a fix ships and are not forwarded upstream. The [security policy](../../.github/SECURITY.md) covers the process and supported versions.
