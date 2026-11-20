export const cliCommandText = (subcommand: string): string => `t3 ${subcommand}`;

// The fork publishes no npm package to pin, so the fix is putting the CLI and the server on one
// release. Separate commands, not `&&`, because Windows PowerShell 5.1 cannot chain them.
export const protocolMismatchHint = (pairCommand: string): string => {
  const updateCommand = pairCommand.replace(/^t3 pair/u, cliCommandText("update"));
  return `Run \`${updateCommand}\` so this CLI and the background service use the same release, restart a server you started yourself with \`t3 serve\`, then run \`${pairCommand}\`.`;
};
