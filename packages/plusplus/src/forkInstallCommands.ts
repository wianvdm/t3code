import { FORK_REPOSITORY } from "./forkRepository.ts";

const FORK_INSTALL_SCRIPT_BASE_URL = `https://raw.githubusercontent.com/${FORK_REPOSITORY}/main/scripts/install`;

export function forkInstallCommand(shell: "sh" | "powershell", version?: string): string {
  if (shell === "powershell") {
    const versionCommand = version === undefined ? "" : `$env:T3CODE_VERSION = '${version}'; `;
    return `${versionCommand}irm ${FORK_INSTALL_SCRIPT_BASE_URL}.ps1 | iex`;
  }
  const versionCommand = version === undefined ? "" : `T3CODE_VERSION=${version} `;
  return `curl -fsSL ${FORK_INSTALL_SCRIPT_BASE_URL}.sh | ${versionCommand}sh`;
}
