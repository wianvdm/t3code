# Install T3 Code ++

T3 Code ++ runs coding agents on your computer and lets you control them from its
desktop or web app. Set up the machine where the agents will work first.

## Requirements

Windows x64, Linux x64, or macOS arm64. Every release is published on
[GitHub Releases](https://github.com/WianVDM/t3code/releases) only. There is no
macOS Intel, Linux ARM, or Windows ARM build, no mobile app, and nothing here
needs Node.js or npm.

You need an installed, authenticated provider before starting a thread. You can
launch T3 Code and configure providers afterwards. See
[provider setup](../../docs/user/install.md#providers).

## Command line

```bash
curl -fsSL https://raw.githubusercontent.com/WianVDM/t3code/main/scripts/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/WianVDM/t3code/main/scripts/install.ps1 | iex
```

The installer downloads the release archive for your platform and links `t3`
into `~/.local/bin` (`%USERPROFILE%\.local\bin` on Windows). If your shell
reports `command not found` afterwards, that directory is not on your `PATH`
yet; the installer prints the line to add. Set `T3CODE_CHANNEL=nightly` to
install the nightly train, or `T3CODE_VERSION` to pin an exact version.

| Task                                             | Command                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Start the server and open the web app            | `t3`                                                                                  |
| Start the server without a browser               | `t3 serve`                                                                            |
| Use it from your other devices                   | `t3 up` ([details](../../docs/user/remote-access.md))                                 |
| Keep it running in the background (macOS, Linux) | `t3 service install` ([details](../../docs/user/background-service.md))               |
| Move to the newest release                       | `t3 update`                                                                           |
| Reclaim database space                           | `t3 doctor` ([details](../../docs/user/background-service.md#reclaim-database-space)) |
| Import an old fork's history                     | `t3 import-old-fork --source <path-to-old-statev2.sqlite>`                            |
| Remove it again                                  | `t3 uninstall`                                                                        |

Run `t3 help` or `t3 --help` for the full reference. To start in a new working
directory, use an explicit path such as `t3 ./my-project`. A bare directory name
is accepted only if it already exists.

If `t3` or `t3 start` reports an already running server, connect to that server
instead. Stop it before starting a replacement, or use a different `--base-dir`
for an independent server.

### Importing your old fork

On first start, if `~/.t3-fork` exists, T3 Code merges it into `~/.t3`. This
runs once for the default home and only when no `--base-dir` is set; an explicit
data directory never triggers it.

What you get:

- **Old fork wins where they overlap.** Its settings, themes, keybindings, and
  shared conversation history replace this installation's copies; sessions and
  threads that only exist here are kept.
- **Provider sign-ins come across.** Credentials required by your old fork's
  settings are copied so providers keep working. This installation's identity,
  cloud link, session tokens, and other server secrets are never imported.
- **Live work does not resume.** Running turns, scheduled tasks, and pairing
  sessions from the old fork are dropped, not restarted.

Stop every T3 Code server and the desktop app on both homes before the first
start. A server still running against either home blocks the merge; running two
servers over the same data is never safe.

The merge runs once. A blocked merge is not retried automatically, even after
you fix the cause. A merge that finds another process still working reports busy
and waits for the next start.

To retry a blocked merge, stop both servers, then run:

```bash
t3 retry-old-fork-merge --base-dir ~/.t3
```

This re-runs only the steps that are safe to repeat. It never resumes or
deletes running work.

To bring an old fork into a different data directory instead, use the manual
command with an explicit destination:

```bash
t3 import-old-fork --source ~/.t3-fork/userdata/statev2.sqlite --base-dir /path/to/home
```

The manual command copies the database as-is when the destination is empty. It
never overwrites an existing database, so it is also how you set up a second
server from old-fork history. Stop any server using that directory first.

### From an archive

Every release also carries the CLI on its own: a `.tar.gz` for Linux x64 and
macOS arm64, a `.zip` for Windows x64, and `SHA256SUMS` beside them. Unpack one and put `t3`
somewhere on your `PATH`. Updates are then manual, so download the newer archive
and replace the binary. Use the installer instead when you want `t3 update` and
the background service to follow releases for you.

### Coming from npm or npx

`npm install -g t3`, `npx t3@latest`, `pnpm dlx`, and `bunx` no longer install
or update T3 Code. If your `t3` came from one of them, stop the server, install
the current release with the installer above, and use `t3 update` from then on.
Projects, threads, and settings in your T3 home directory are kept.

### Intel Macs

There is no `t3` executable and no desktop app build for Intel Macs. Use the web
client there.

## Desktop app

Download the installer from [GitHub Releases](https://github.com/WianVDM/t3code/releases):

| Platform    | File                             |
| ----------- | -------------------------------- |
| Windows     | `T3-Code-<version>-x64.exe`      |
| Linux       | `T3-Code-<version>-x64.AppImage` |
| Linux       | `T3-Code-<version>-x64.deb`      |
| macOS arm64 | `T3-Code-<version>-arm64.dmg`    |

The AppImage has to be executable (`chmod +x`) before the first run. Open the
`.dmg` and drag T3 Code into Applications on macOS. There is no macOS Intel,
Linux ARM, or Windows ARM build, no mobile app, and no Homebrew, AUR, or Nix
package.

The macOS build is unsigned and has no updater feed. macOS may warn that it
cannot verify the developer on first open; right-click the app and choose
**Open** to run it anyway, and expect the same after each update. To update,
download the newer `.dmg` and replace the app yourself. On Windows and Linux
the app installs its own updates from the same releases; see
[Updating T3 Code](../../docs/user/updating.md).

### The `t3` command

The desktop app includes the `t3` command-line tool. To run it from any
terminal, open **Settings → About** and choose **Install** next to
**t3 command**. On macOS and Linux it adds a `t3` link to a folder on your
`PATH`; on Windows it adds the app's command folder to your `PATH`. Open a new
terminal afterwards. **Remove** takes it off again.

## More

Windows Subsystem for Linux, `t3 app`, and provider setup work as in the main guide:
[Windows Subsystem for Linux](../../docs/user/install.md#windows-subsystem-for-linux),
[Open a project from a terminal](../../docs/user/install.md#open-a-project-from-a-terminal),
[Providers](../../docs/user/install.md#providers).
