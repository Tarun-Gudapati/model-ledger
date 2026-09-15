import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import type { BaseScorerConfig, ScorerPlugin } from "../src/domain.js";
import { builtInScorers, estimateCostUsd, ScorerRegistry } from "../src/scorers.js";
import { runSuite } from "../src/runner.js";
import { validateSuiteConfig } from "../src/validation.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const passingSuite = path.join(projectRoot, "samples", "passing", "suite.json");
const failingSuite = path.join(projectRoot, "samples", "failing", "suite.json");

describe("runSuite", () => {
  it("passes a candidate inside every configured gate", async () => {
    const result = await runSuite(passingSuite);

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.totals).toMatchObject({
      cases: 2,
      passedCases: 2,
      failedCases: 0,
      scorers: 8,
      passedScorers: 8,
    });
    expect(result.gateFailures).toEqual([]);
    expect(result.estimatedCostUsd.baseline).toBeCloseTo(0.00086, 8);
    expect(result.estimatedCostUsd.candidate).toBeCloseTo(0.000915, 8);
  });

  it("reports deterministic gate failures for a regressed candidate", async () => {
    const result = await runSuite(failingSuite);

    expect(result.passed).toBe(false);
    expect(result.totals.failedCases).toBe(1);
    expect(result.totals.failedScorers).toBe(5);
    expect(result.gateFailures.map((failure) => failure.gate)).toEqual([
      "scorer",
      "scorer",
      "scorer",
      "scorer",
      "scorer",
      "case-minimum-score",
      "suite-minimum-score",
      "suite-max-failed-cases",
    ]);
  });
});

describe("CLI", () => {
  it("returns zero for a passing suite and one for failed regression gates", async () => {
    await expect(main(["run", passingSuite, "--quiet", "--no-report"])).resolves.toBe(0);
    await expect(main(["run", failingSuite, "--quiet", "--no-report"])).resolves.toBe(1);
  });
});

describe("validation and cost estimation", () => {
  it("returns source paths in validation errors", () => {
    expect(() =>
      validateSuiteConfig(
        {
          version: 1,
          name: "empty",
          cases: [],
        },
        "inline suite",
      ),
    ).toThrow(/inline suite[\s\S]*\$\.cases: at least one case is required/u);
  });

  it("estimates token cost when no explicit estimate is recorded", () => {
    expect(
      estimateCostUsd({
        content: "ok",
        usage: { inputTokens: 1_000, outputTokens: 500 },
        pricing: { inputPerMillionUsd: 2, outputPerMillionUsd: 4 },
      }),
    ).toBeCloseTo(0.004, 10);
  });

  it("accepts and runs a registered custom scorer", async () => {
    interface MinimumLengthConfig extends BaseScorerConfig {
      type: "minimum-length";
      options: { minimum: number };
    }

    const suite = validateSuiteConfig(
      {
        version: 1,
        name: "plugin suite",
        cases: [
          {
            id: "plugin-case",
            baseline: { fixture: "unused-baseline.json" },
            candidate: { fixture: "unused-candidate.json" },
            scorers: [{ type: "minimum-length", options: { minimum: 4 } }],
          },
        ],
      },
      "inline plugin suite",
    );
    const plugin: ScorerPlugin<MinimumLengthConfig> = {
      type: "minimum-length",
      score(context, config) {
        const passed = context.candidate.content.length >= config.options.minimum;
        return { passed, score: passed ? 1 : 0, summary: "Checked minimum length" };
      },
    };
    const registry = new ScorerRegistry([...builtInScorers, plugin]);
    const evaluationCase = suite.cases[0];
    const scorerConfig = evaluationCase?.scorers[0];
    expect(evaluationCase).toBeDefined();
    expect(scorerConfig).toBeDefined();
    if (evaluationCase === undefined || scorerConfig === undefined) {
      throw new Error("Expected the inline suite to contain one scorer");
    }

    const result = await registry.get(scorerConfig, evaluationCase.id).score(
      {
        suite,
        evaluationCase,
        baseline: { content: "old" },
        candidate: { content: "long enough" },
      },
      scorerConfig,
    );

    expect(result.passed).toBe(true);
  });
});
