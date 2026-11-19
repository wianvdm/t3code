/** Upstream CORE.md, MIT, Copyright (c) 2026 Tarek Sabet. Pinned; see UPSTREAM_LICENSE. */
export const BUNDLED_CORE = {
  upstreamCommit: "8dc98e1c70ebe395c31b2a16c9376ca7e4071ba7",
  blobSha: "416ae435f8488d114752fe35da16c45488cadd44",
  raw: `# Token-efficiency core rules

Minimize total cost and time to a verified result.

- Reuse current evidence; retrieve only what the next decision needs.
- Filter and query before output enters context. Follow the harness's tool guidance.
- Preserve relevant errors and constraints. Expand incomplete or ambiguous reads.
- Save verbose output for selective inspection, preserving the command's exit status.
- Include setup, retries, and child-agent usage when judging savings.
- Keep prompt prefixes stable where practical; use native context management when needed.

For the full playbook, invoke the \`token-efficiency\` skill.
`,
} as const;

export const UPSTREAM_LICENSE = `MIT License

Copyright (c) 2026 Tarek Sabet

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
