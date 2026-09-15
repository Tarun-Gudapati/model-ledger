import path from "node:path";

import type {
  CaseResult,
  GateFailure,
  PluginScore,
  RunOptions,
  ScorerResult,
  SuiteResult,
} from "./domain.js";
import { JsonFixtureOutputLoader, loadSuiteConfig, type OutputLoader } from "./loaders.js";
import { builtInScorers, estimateCostUsd, ScorerRegistry } from "./scorers.js";

export interface RunSuiteOptions extends RunOptions {
  outputLoader?: OutputLoader;
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function validatePluginScore(score: PluginScore, type: string): PluginScore {
  if (
    typeof score.passed !== "boolean" ||
    typeof score.score !== "number" ||
    !Number.isFinite(score.score) ||
    score.score < 0 ||
    score.score > 1 ||
    typeof score.summary !== "string"
  ) {
    throw new Error(
      `Scorer plugin "${type}" returned an invalid result; score must be between 0 and 1`,
    );
  }
  return score;
}

function weightedScore(results: ScorerResult[]): number {
  const totalWeight = results.reduce((sum, result) => sum + result.weight, 0);
  if (totalWeight === 0) {
    return 0;
  }
  return round(
    results.reduce((sum, result) => sum + result.score * result.weight, 0) / totalWeight,
  );
}

function sumCosts(values: Array<number | undefined>): number | null {
  if (values.some((value) => value === undefined)) {
    return null;
  }
  return round(values.reduce<number>((sum, value) => sum + (value ?? 0), 0));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runSuite(
  configPath: string,
  options: RunSuiteOptions = {},
): Promise<SuiteResult> {
  const now = options.now ?? (() => new Date());
  const started = now();
  const absoluteConfigPath = path.resolve(configPath);
  const configDirectory = path.dirname(absoluteConfigPath);
  const suite = await loadSuiteConfig(absoluteConfigPath);
  const loader = options.outputLoader ?? new JsonFixtureOutputLoader();
  const registry = new ScorerRegistry([...builtInScorers, ...(options.plugins ?? [])]);
  const failOnScorerError = suite.gates?.failOnScorerError ?? true;
  const gateFailures: GateFailure[] = [];
  const caseResults: CaseResult[] = [];
  const baselineCosts: Array<number | undefined> = [];
  const candidateCosts: Array<number | undefined> = [];

  for (const evaluationCase of suite.cases) {
    const [baseline, candidate] = await Promise.all([
      loader.load(evaluationCase.baseline, {
        configDirectory,
        caseId: evaluationCase.id,
        role: "baseline",
      }),
      loader.load(evaluationCase.candidate, {
        configDirectory,
        caseId: evaluationCase.id,
        role: "candidate",
      }),
    ]);
    baselineCosts.push(estimateCostUsd(baseline));
    candidateCosts.push(estimateCostUsd(candidate));

    const context = { suite, evaluationCase, baseline, candidate };
    const scorerResults: ScorerResult[] = [];

    for (const [index, scorerConfig] of evaluationCase.scorers.entries()) {
      const id = scorerConfig.id ?? `${scorerConfig.type}-${index + 1}`;
      const gate = scorerConfig.gate ?? true;
      const weight = scorerConfig.weight ?? 1;
      let result: ScorerResult;

      try {
        const plugin = registry.get(scorerConfig, evaluationCase.id);
        const pluginScore = validatePluginScore(
          await plugin.score(context, scorerConfig),
          scorerConfig.type,
        );
        result = {
          ...pluginScore,
          id,
          type: scorerConfig.type,
          gate,
          weight,
        };
      } catch (error) {
        result = {
          id,
          type: scorerConfig.type,
          gate,
          weight,
          passed: false,
          score: 0,
          summary: "Scorer could not be evaluated",
          error: errorMessage(error),
        };
      }

      scorerResults.push(result);
      if (result.error !== undefined && failOnScorerError) {
        gateFailures.push({
          gate: "scorer-error",
          message: `Scorer "${id}" errored: ${result.error}`,
          caseId: evaluationCase.id,
          scorerId: id,
        });
      } else if (result.error === undefined && gate && !result.passed) {
        gateFailures.push({
          gate: "scorer",
          message: `Scorer "${id}" failed: ${result.summary}`,
          caseId: evaluationCase.id,
          scorerId: id,
        });
      }
    }

    const score = weightedScore(scorerResults);
    if (evaluationCase.minimumScore !== undefined && score < evaluationCase.minimumScore) {
      gateFailures.push({
        gate: "case-minimum-score",
        message: `Case score ${score} is below required ${evaluationCase.minimumScore}`,
        caseId: evaluationCase.id,
      });
    }
    const passed = !gateFailures.some((failure) => failure.caseId === evaluationCase.id);
    caseResults.push({
      id: evaluationCase.id,
      ...(evaluationCase.description === undefined
        ? {}
        : { description: evaluationCase.description }),
      passed,
      score,
      scorers: scorerResults,
    });
  }

  const allScorers = caseResults.flatMap((result) => result.scorers);
  const score = weightedScore(allScorers);
  const failedCases = caseResults.filter((result) => !result.passed).length;

  if (suite.gates?.minimumScore !== undefined && score < suite.gates.minimumScore) {
    gateFailures.push({
      gate: "suite-minimum-score",
      message: `Suite score ${score} is below required ${suite.gates.minimumScore}`,
    });
  }
  if (
    suite.gates?.maxFailedCases !== undefined &&
    failedCases > suite.gates.maxFailedCases
  ) {
    gateFailures.push({
      gate: "suite-max-failed-cases",
      message: `${failedCases} failed cases exceeds allowed ${suite.gates.maxFailedCases}`,
    });
  }

  const finished = now();
  const baselineCost = sumCosts(baselineCosts);
  const candidateCost = sumCosts(candidateCosts);

  return {
    schemaVersion: 1,
    suite: suite.name,
    configPath: absoluteConfigPath,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: Math.max(0, finished.getTime() - started.getTime()),
    passed: gateFailures.length === 0,
    score,
    totals: {
      cases: caseResults.length,
      passedCases: caseResults.length - failedCases,
      failedCases,
      scorers: allScorers.length,
      passedScorers: allScorers.filter((result) => result.passed).length,
      failedScorers: allScorers.filter((result) => !result.passed).length,
    },
    estimatedCostUsd: {
      baseline: baselineCost,
      candidate: candidateCost,
      delta:
        baselineCost === null || candidateCost === null
          ? null
          : round(candidateCost - baselineCost),
    },
    cases: caseResults,
    gateFailures,
  };
}
