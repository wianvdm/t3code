import * as Duration from "effect/Duration";

export const TOKEN_EFFICIENCY_CORE_URL =
  "https://raw.githubusercontent.com/undefdev/token-efficiency/main/skills/token-efficiency/CORE.md";
export const TOKEN_EFFICIENCY_LINKS = {
  core: "https://github.com/undefdev/token-efficiency/blob/main/skills/token-efficiency/CORE.md",
  repository: "https://github.com/undefdev/token-efficiency",
  fullPlaybook:
    "https://github.com/undefdev/token-efficiency/blob/main/skills/token-efficiency/SKILL.md",
  license: "https://github.com/undefdev/token-efficiency/blob/main/LICENSE",
} as const;
export const MAX_CORE_BYTES = 16 * 1024;
export const FETCH_TIMEOUT = Duration.seconds(10);
export const FRESHNESS_TTL = Duration.hours(6);
export const STALENESS_TICK = Duration.minutes(15);
/** Consecutive automatic failures n wait min(15m * 2^(n-1), 2h) after lastAttemptAt. Retry-After is honoured up to the cap. */
export const FAILURE_BACKOFF_CAP = Duration.hours(2);
export const ADAPTATION_VERSION = 1;
export const INSTRUCTIONS_FORMAT_VERSION = 1;
