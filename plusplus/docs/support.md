# Support and releases

T3 Code ++ is an unofficial fork of [T3 Code](https://github.com/pingdotgg/t3code). It is not affiliated with, endorsed by, or maintained by T3 Tools, Inc. See [TRADEMARK.md](../../TRADEMARK.md).

T3 Code ++ is maintained separately from upstream by one person. Support and fixes are best effort, and only the latest stable release receives fixes.

## Release channel

Stable is the only supported channel. Releases are published on [GitHub Releases](https://github.com/WianVDM/t3code/releases) after maintainer approval. Stable releases use `vX.Y.Z-plusplus.N` tags: the upstream base version plus the ++ revision.

No nightly builds are published on the fork, so the Nightly update track has nothing to install. Preview builds are maintainer-only dry runs and receive no support.

See [Install T3 Code ++](./install.md) for installation and updates.

## Available builds

All builds are unsigned: Windows shows SmartScreen warnings, the Linux AppImage never carried a signature, and macOS asks you to confirm past Gatekeeper. The fork publishes desktop and CLI builds for Windows x64 and Linux x64, plus macOS arm64 builds; only macOS lacks auto-update and needs manual updates. It does not publish a hosted web app or mobile-store builds. The CLI and desktop app provide the local web client; browsers on other devices can connect through [remote access](../../docs/user/remote-access.md).

## Report an issue

Search existing issues, then use the [fork's issue forms](https://github.com/WianVDM/t3code/issues/new/choose). Report ++ bugs and feature requests in the fork. If a behavior exists only in upstream T3 Code, you may report it to upstream yourself; this repository never forwards reports or other work upstream.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/WianVDM/t3code/security/advisories/new), not a public issue. Reports stay private between you and the maintainer until a fix ships and are not forwarded upstream. The [security policy](../../.github/SECURITY.md) covers the process and supported versions.
