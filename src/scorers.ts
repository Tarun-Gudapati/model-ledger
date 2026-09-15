import type {
  BaseScorerConfig,
  BuiltInScorerConfig,
  EvaluationOutput,
  ScorerPlugin,
} from "./domain.js";
import { UnknownScorerError } from "./errors.js";

function normalizeText(
  value: string,
  options: { trim?: boolean; caseSensitive?: boolean; collapseWhitespace?: boolean } = {},
): string {
  let normalized = options.trim === false ? value : value.trim();
  if (options.collapseWhitespace === true) {
    normalized = normalized.replace(/\s+/gu, " ");
  }
  if (options.caseSensitive === false) {
    normalized = normalized.toLocaleLowerCase("en-US");
  }
  return normalized;
}

function requireConfig<TType extends BuiltInScorerConfig["type"]>(
  config: BaseScorerConfig,
  type: TType,
): Extract<BuiltInScorerConfig, { type: TType }> {
  if (config.type !== type) {
    throw new Error(`Invalid configuration supplied to ${type}`);
  }
  return config as Extract<BuiltInScorerConfig, { type: TType }>;
}

export function estimateCostUsd(output: EvaluationOutput): number | undefined {
  if (output.estimatedCostUsd !== undefined) {
    return output.estimatedCostUsd;
  }
  if (output.usage === undefined || output.pricing === undefined) {
    return undefined;
  }

  const inputCost =
    (output.usage.inputTokens * output.pricing.inputPerMillionUsd) / 1_000_000;
  const outputCost =
    (output.usage.outputTokens * output.pricing.outputPerMillionUsd) / 1_000_000;
  return inputCost + outputCost;
}

function requiredNumber(value: number | undefined, label: string): number {
  if (value === undefined) {
    throw new Error(`${label} is required by this scorer but is missing from the fixture`);
  }
  return value;
}

function allowedByAbsoluteAndRelativeBudgets(
  candidate: number,
  baseline: number | undefined,
  maxAbsolute: number | undefined,
  maxIncreasePercent: number | undefined,
): { passed: boolean; relativeLimit?: number } {
  const absolutePassed = maxAbsolute === undefined || candidate <= maxAbsolute;
  if (maxIncreasePercent === undefined) {
    return { passed: absolutePassed };
  }

  const baselineValue = requiredNumber(baseline, "baseline metric");
  const relativeLimit = baselineValue * (1 + maxIncreasePercent / 100);
  return {
    passed: absolutePassed && candidate <= relativeLimit,
    relativeLimit,
  };
}

const exactMatchScorer: ScorerPlugin = {
  type: "exact-match",
  score(context, config) {
    const scorerConfig = requireConfig(config, "exact-match");
    const baseline = normalizeText(context.baseline.content, scorerConfig.options);
    const candidate = normalizeText(context.candidate.content, scorerConfig.options);
    const passed = baseline === candidate;
    return {
      passed,
      score: passed ? 1 : 0,
      summary: passed ? "Candidate matches the baseline" : "Candidate differs from the baseline",
      measurements: {
        baselineCharacters: baseline.length,
        candidateCharacters: candidate.length,
      },
    };
  },
};

const containsRequiredTermsScorer: ScorerPlugin = {
  type: "contains-required-terms",
  score(context, config) {
    const scorerConfig = requireConfig(config, "contains-required-terms");
    const caseSensitive = scorerConfig.options.caseSensitive ?? false;
    const candidate = caseSensitive
      ? context.candidate.content
      : context.candidate.content.toLocaleLowerCase("en-US");
    const matched = scorerConfig.options.terms.filter((term) => {
      const expected = caseSensitive ? term : term.toLocaleLowerCase("en-US");
      return candidate.includes(expected);
    });
    const mode = scorerConfig.options.match ?? "all";
    const passed =
      mode === "all" ? matched.length === scorerConfig.options.terms.length : matched.length > 0;
    const missing = scorerConfig.options.terms.filter((term) => !matched.includes(term));
    return {
      passed,
      score: matched.length / scorerConfig.options.terms.length,
      summary: passed
        ? `Matched ${matched.length}/${scorerConfig.options.terms.length} required terms`
        : `Missing required terms: ${missing.join(", ")}`,
      measurements: {
        matchedTerms: matched.length,
        requiredTerms: scorerConfig.options.terms.length,
        mode,
      },
    };
  },
};

const validJsonScorer: ScorerPlugin = {
  type: "valid-json",
  score(context, config) {
    const scorerConfig = requireConfig(config, "valid-json");
    try {
      const value = JSON.parse(context.candidate.content) as unknown;
      const requireObject = scorerConfig.options?.requireObject ?? false;
      const isObject = typeof value === "object" && value !== null && !Array.isArray(value);
      const passed = !requireObject || isObject;
      return {
        passed,
        score: passed ? 1 : 0,
        summary: passed
          ? "Candidate contains valid JSON"
          : "Candidate JSON is valid but is not an object",
        measurements: {
          requireObject,
          parsedType: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
        },
      };
    } catch {
      return {
        passed: false,
        score: 0,
        summary: "Candidate is not valid JSON",
      };
    }
  },
};

const latencyBudgetScorer: ScorerPlugin = {
  type: "latency-budget",
  score(context, config) {
    const scorerConfig = requireConfig(config, "latency-budget");
    const candidateMs = requiredNumber(context.candidate.latencyMs, "candidate latencyMs");
    const budget = allowedByAbsoluteAndRelativeBudgets(
      candidateMs,
      context.baseline.latencyMs,
      scorerConfig.options.maxMs,
      scorerConfig.options.maxIncreasePercent,
    );
    return {
      passed: budget.passed,
      score: budget.passed ? 1 : 0,
      summary: budget.passed
        ? `Latency ${candidateMs}ms is within budget`
        : `Latency ${candidateMs}ms exceeds budget`,
      measurements: {
        candidateMs,
        baselineMs: context.baseline.latencyMs ?? null,
        maxMs: scorerConfig.options.maxMs ?? null,
        relativeLimitMs: budget.relativeLimit ?? null,
      },
    };
  },
};

const estimatedCostBudgetScorer: ScorerPlugin = {
  type: "estimated-cost-budget",
  score(context, config) {
    const scorerConfig = requireConfig(config, "estimated-cost-budget");
    const candidateUsd = requiredNumber(estimateCostUsd(context.candidate), "candidate estimated cost");
    const baselineUsd = estimateCostUsd(context.baseline);
    const budget = allowedByAbsoluteAndRelativeBudgets(
      candidateUsd,
      baselineUsd,
      scorerConfig.options.maxUsd,
      scorerConfig.options.maxIncreasePercent,
    );
    return {
      passed: budget.passed,
      score: budget.passed ? 1 : 0,
      summary: budget.passed
        ? `Estimated cost $${candidateUsd.toFixed(6)} is within budget`
        : `Estimated cost $${candidateUsd.toFixed(6)} exceeds budget`,
      measurements: {
        candidateUsd,
        baselineUsd: baselineUsd ?? null,
        maxUsd: scorerConfig.options.maxUsd ?? null,
        relativeLimitUsd: budget.relativeLimit ?? null,
      },
    };
  },
};

export const builtInScorers: readonly ScorerPlugin[] = [
  exactMatchScorer,
  containsRequiredTermsScorer,
  validJsonScorer,
  latencyBudgetScorer,
  estimatedCostBudgetScorer,
];

export class ScorerRegistry {
  private readonly plugins = new Map<string, ScorerPlugin>();

  constructor(plugins: readonly ScorerPlugin[] = builtInScorers) {
    plugins.forEach((plugin) => this.register(plugin));
  }

  register(plugin: ScorerPlugin): void {
    if (this.plugins.has(plugin.type)) {
      throw new Error(`A scorer plugin named "${plugin.type}" is already registered`);
    }
    this.plugins.set(plugin.type, plugin);
  }

  get(config: BaseScorerConfig, caseId: string): ScorerPlugin {
    const plugin = this.plugins.get(config.type);
    if (plugin === undefined) {
      throw new UnknownScorerError(config.type, caseId);
    }
    return plugin;
  }
}
