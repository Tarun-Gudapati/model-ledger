# ModelLedger

> **Status: Concept scaffold (working offline baseline).**

ModelLedger is a small, deterministic harness for checking recorded LLM outputs before a prompt
or model change ships. It compares baseline and candidate JSON fixtures, applies configured
regression gates, prints a readable summary, writes a machine-readable report, and returns a
non-zero exit code when a gate fails.

This repository is intentionally honest about its scope: it is a compiling local baseline, not a
hosted evaluation platform and not proof that an LLM is correct. It makes no network requests,
requires no API key, and can run in CI with fixed fixtures.

## What works

- Strong TypeScript domain types and strict runtime validation with JSON paths in errors.
- Built-in deterministic scorers:
  - `exact-match`
  - `contains-required-terms`
  - `valid-json`
  - `latency-budget`
  - `estimated-cost-budget`
- Per-scorer gates, per-case minimum scores, and suite-level minimum-score and failed-case gates.
- Costs supplied directly in a fixture or estimated from recorded token usage and pricing.
- Human-readable terminal output and a stable JSON report (`schemaVersion: 1`).
- Exit code `0` for a passing suite, `1` for failed regression gates, and `2` for invalid input or
  execution errors.
- An output-loader boundary and scorer registry that can be extended without coupling the runner
  to a model provider.
- Passing and intentionally failing sample suites.

## Requirements and setup

Use Node.js 24 and npm:

```powershell
git clone <your-copy>
cd model-ledger
npm ci
npm run build
```

For this uncommitted starter repository, `npm install` creates the initial lockfile. After the
lockfile is committed, use `npm ci` locally and in CI.

No environment variables or credentials are needed.

## CLI

Build and run the passing sample:

```powershell
npm run build
node dist/cli.js run samples/passing/suite.json --report reports/passing.json
```

Run the intentionally failing sample:

```powershell
node dist/cli.js run samples/failing/suite.json --report reports/failing.json
$LASTEXITCODE # 1
```

The default report path is `model-ledger-report.json`. Use `--no-report` to avoid writing a file,
`--quiet` to suppress the readable summary, or `--json` to emit JSON on stdout. With `--json`, the
readable summary goes to stderr so stdout remains parseable:

```powershell
node dist/cli.js run samples/passing/suite.json --json --no-report > result.json
```

After packaging or linking, the equivalent command is:

```powershell
model-ledger run samples/passing/suite.json
```

## Configuration

A suite points to recorded baseline and candidate fixtures. Paths are resolved relative to the
suite file.

```json
{
  "version": 1,
  "name": "support-answer-regression",
  "gates": {
    "minimumScore": 0.9,
    "maxFailedCases": 0,
    "failOnScorerError": true
  },
  "cases": [
    {
      "id": "refund-policy",
      "baseline": { "fixture": "fixtures/refund-baseline.json" },
      "candidate": { "fixture": "fixtures/refund-candidate.json" },
      "minimumScore": 0.8,
      "scorers": [
        {
          "type": "contains-required-terms",
          "options": { "terms": ["refund", "30 days"] }
        },
        {
          "type": "latency-budget",
          "options": { "maxMs": 650, "maxIncreasePercent": 30 }
        }
      ]
    }
  ]
}
```

Each scorer accepts an optional `id`, positive `weight`, and `gate`. `gate` defaults to `true`.
Setting it to `false` keeps that scorer in the weighted score without making its individual failure
a direct gate failure. Multiple limits in one budget scorer must all pass.

An output fixture has this shape:

```json
{
  "content": "The refund window is 30 days.",
  "latencyMs": 500,
  "usage": {
    "inputTokens": 800,
    "outputTokens": 100
  },
  "pricing": {
    "inputPerMillionUsd": 0.5,
    "outputPerMillionUsd": 1.5
  },
  "metadata": {
    "model": "recorded-candidate"
  }
}
```

`estimatedCostUsd` can be recorded instead of `usage` plus `pricing`. Cost values are estimates
only; ModelLedger does not query provider billing.

### Scorer behavior

- `exact-match` compares baseline and candidate content. Options control trimming (on by default),
  case sensitivity (on by default), and whitespace collapsing.
- `contains-required-terms` checks the candidate for all terms by default; `match: "any"` and
  `caseSensitive: true` are available.
- `valid-json` parses candidate content. `requireObject: true` rejects arrays, primitives, and
  `null`.
- `latency-budget` accepts `maxMs`, `maxIncreasePercent`, or both. Relative checks require baseline
  latency.
- `estimated-cost-budget` accepts `maxUsd`, `maxIncreasePercent`, or both. Relative checks require
  an estimated baseline cost.

Missing metrics needed by a configured scorer are reported as scorer errors. By default scorer
errors fail the suite; set `gates.failOnScorerError` to `false` only when that behavior is deliberate.

## Scripts

- `npm run lint` — lint source and tests.
- `npm run typecheck` — strict typecheck without emitting files.
- `npm test` — run the Vitest suite.
- `npm run build` — emit the production ESM build and declarations to `dist/`.
- `npm run demo` — build and run the passing sample.
- `npm run demo:failing` — build and run the failing sample; exit code `1` is expected.

## Architecture

The execution flow is:

1. `src/loaders.ts` loads the suite and fixtures through an `OutputLoader`.
2. `src/validation.ts` validates untrusted JSON before it enters the typed domain.
3. `src/runner.ts` resolves scorer plugins, computes weighted scores, and evaluates gates.
4. `src/reporters.ts` renders terminal and JSON output.
5. `src/cli.ts` owns argument parsing and maps results to process exit codes.

`src/domain.ts` contains the public contracts. `src/scorers.ts` contains stateless built-ins and the
`ScorerRegistry`. `src/index.ts` exposes the library API.

The default `JsonFixtureOutputLoader` is deliberately provider-neutral. A future provider adapter
can implement `OutputLoader` and supply outputs to `runSuite`; a future scorer can implement
`ScorerPlugin` and be registered through `RunSuiteOptions.plugins`. No provider adapter is bundled
in this scaffold, so current CLI runs remain offline and reproducible.

## CI

`.github/workflows/ci.yml` runs on Node 24 and performs locked installation, linting, typechecking,
tests, production build, the passing demo, and a high-severity runtime dependency audit.

For a gate job that evaluates project-specific fixtures:

```yaml
- name: Evaluate recorded outputs
  run: node dist/cli.js run evaluations/release.json --report reports/model-ledger.json

- name: Upload report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: model-ledger-report
    path: reports/model-ledger.json
```

The evaluation step fails naturally when the CLI returns exit code `1`.

## Limitations

- The CLI compares recorded fixtures; it does not call OpenAI, Anthropic, or any other provider.
- Results are deterministic checks, not statistical evidence. There is no repeated sampling,
  confidence interval, variance tracking, or drift history.
- Text scorers are lexical. There is no embedding similarity, task-specific grading, or LLM judge.
- `valid-json` checks parsing and an optional object shape, not JSON Schema.
- Token costs depend on user-recorded pricing and can diverge from real invoices.
- Latency is fixture metadata, not measured by this process.
- Configuration is JSON-only and schema version 1 has no migration tooling.
- Reports are local files; there is no dashboard, database, trend view, or artifact uploader.

## Roadmap

1. Publish JSON Schema files and editor completions for suites and reports.
2. Add a typed custom-scorer configuration hook and separately versioned plugin API.
3. Add JSON Schema, numeric tolerance, regex, and structured-field scorers.
4. Add opt-in provider adapters with record/replay, retries, redaction, and rate controls.
5. Add repeated runs, distributions, confidence-aware gates, and historical comparisons.
6. Add JUnit/SARIF reporters and richer CI annotations.

## License

MIT. See `LICENSE`.
