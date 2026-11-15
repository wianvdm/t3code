# T3 Code ++ FAQ

These answers replace their counterparts in the [main FAQ](../../docs/user/faq.md); everything else there applies. Install steps are in [Install T3 Code ++](./install.md).

## Why use T3 Code ++ instead of Claude Code or the Codex app?

- Bring your own sub. Claude, Codex, and whatever else you already have installed.
- Best in class remote. Run `t3 connect` on any box and drive it from anywhere.
- Truly 100% open source. If we go the wrong direction, fork it.

There is no mobile app in this fork; see [phone](#how-do-i-use-t3-code-on-my-phone).

## How do I use T3 Code remotely?

Your agents run wherever T3 Code runs: your desktop, a server, a VPS. You connect to it from anywhere. Run `t3 connect` on that machine and you get really good remote support. T3 Connect is the easy path. LAN pairing and Tailscale work too, and [app.t3.codes](https://app.t3.codes) is the web client. [Remote access](../../docs/user/remote-access.md)

## How do I use T3 Code on my phone?

This fork has no mobile app. The desktop app is published for Windows x64 and Linux x64, plus an unsigned macOS arm64 DMG you can download and install manually (no macOS updater feed, and no Intel Mac build); you can also use the local web client on any platform. To drive it from your phone, connect the phone's browser to your computer over T3 Connect, LAN pairing, or Tailscale. The computer does the work and needs to stay on. [Remote access](../../docs/user/remote-access.md)

## Is there voice input?

Not in this fork, which has no mobile app. Upstream T3 Code has it on iPhone (iOS 26 or later): tap the mic in the composer, talk, check the text, then send. Web, desktop, and Android do not have it there yet.

## Does it work on Windows, Mac, and Linux?

Yes, all three. Desktop app, CLI, the works. One catch: there is no `t3` binary for Intel Macs and no desktop app build for them either, so use the web client there. Windows folks can also run agents inside WSL. [Install](./install.md)
