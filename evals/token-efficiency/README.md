# Token-efficiency eval

Measures the shipped CORE block against an identical disabled control. Paired samples cover selective reading, error and exit-status preservation, and ordinary-edit tool churn. A deterministic case measures block bytes, Codex chunks, and resend overhead over ten turns with one change and one compaction.

## Run

From `evals/`:

```sh
pnpm token-efficiency --out runs/te3-initial
```

Defaults to `gpt-6-luna`, three paired samples per arm, and the bundled CORE. Select models or cases with `--model <id>` and `--case <ids>`. Evaluate a newer upstream source with `--core-file <path>`; adaptation uses the server's real path. Compare an earlier `results.json` with `--baseline <path>`.

The no-model overhead check is free:

```sh
pnpm token-efficiency --out runs/te3-overhead --case prompt-overhead
```

Model cases use the configured eval proxy and incur provider charges. Three behavior cases, two arms, and three samples produce 18 transcripts per model; each transcript allows up to 12 API calls. `summary.json` records token usage, not monetary cost.

## Cases

Cases live in `cases.ts` and name their acceptance-criterion source. Model tools simulate a repository, long failing-test output, and exact edits. Graders live in `grade.ts`; add unit coverage in `run.test.ts` for new checks. Runs write `results.json` and `summary.json` under `--out`.
