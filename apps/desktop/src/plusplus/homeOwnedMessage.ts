import * as Option from "effect/Option";

import { CLI_RELEASES_PAGE_URL } from "@t3tools/shared/cliRelease";

import * as DesktopHomeOwner from "../backend/DesktopHomeOwner.ts";

// The fork publishes no `t3` npm package, so upstream's `npx t3@latest` hint would install upstream's CLI.
export const homeOwnedMessage = (owner: Option.Option<DesktopHomeOwner.HomeOwner>): string =>
  Option.isSome(owner)
    ? DesktopHomeOwner.homeOwnedMessage(owner)
    : `Another T3 Code server, such as the background service, is using this data directory, or an older background service is set up for it. Stop that server or try \`t3 update\`. If the older launcher cannot update, run \`t3 service uninstall\` and optionally reinstall with \`t3 service install\` from a current CLI. If \`t3\` is missing or outdated, install a current CLI from ${CLI_RELEASES_PAGE_URL}, and pass \`--base-dir\` with the service's T3 home to each command. Then reopen T3 Code. You can also set a separate T3CODE_HOME and pair with the running server.`;
