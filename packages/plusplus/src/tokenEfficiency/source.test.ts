import { expect, it } from "vite-plus/test";

import { TOKEN_EFFICIENCY_CORE_URL, TOKEN_EFFICIENCY_LINKS } from "./source.ts";

it("pins retrieval to CORE.md and keeps the other upstream resources as links", () => {
  expect(TOKEN_EFFICIENCY_CORE_URL).toBe(
    "https://raw.githubusercontent.com/undefdev/token-efficiency/main/skills/token-efficiency/CORE.md",
  );
  expect(TOKEN_EFFICIENCY_LINKS.fullPlaybook).toBe(
    "https://github.com/undefdev/token-efficiency/blob/main/skills/token-efficiency/SKILL.md",
  );
  expect(new URL(TOKEN_EFFICIENCY_LINKS.license).hostname).toBe("github.com");
});
