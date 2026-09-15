export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TokenPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export interface EvaluationOutput {
  content: string;
  latencyMs?: number;
  usage?: TokenUsage;
  pricing?: TokenPricing;
  estimatedCostUsd?: number;
  metadata?: Record<string, unknown>;
}

export interface OutputReference {
  fixture: string;
}

export interface BaseScorerConfig {
  type: string;
  id?: string;
  gate?: boolean;
  weight?: number;
  options?: unknown;
}

export interface TextNormalizationOptions {
  trim?: boolean;
  caseSensitive?: boolean;
  collapseWhitespace?: boolean;
}

export interface ExactMatchScorerConfig extends BaseScorerConfig {
  type: "exact-match";
  options?: TextNormalizationOptions;
}

export interface ContainsRequiredTermsScorerConfig extends BaseScorerConfig {
  type: "contains-required-terms";
  options: {
    terms: string[];
    caseSensitive?: boolean;
    match?: "all" | "any";
  };
}

export interface ValidJsonScorerConfig extends BaseScorerConfig {
  type: "valid-json";
  options?: {
    requireObject?: boolean;
  };
}

export interface LatencyBudgetScorerConfig extends BaseScorerConfig {
  type: "latency-budget";
  options: {
    maxMs?: number;
    maxIncreasePercent?: number;
  };
}

export interface EstimatedCostBudgetScorerConfig extends BaseScorerConfig {
  type: "estimated-cost-budget";
  options: {
    maxUsd?: number;
    maxIncreasePercent?: number;
  };
}

export type BuiltInScorerConfig =
  | ExactMatchScorerConfig
  | ContainsRequiredTermsScorerConfig
  | ValidJsonScorerConfig
  | LatencyBudgetScorerConfig
  | EstimatedCostBudgetScorerConfig;

export interface PluginScorerConfig extends BaseScorerConfig {
  type: string;
}

export type ScorerConfig = BuiltInScorerConfig | PluginScorerConfig;

export interface EvaluationCaseConfig {
  id: string;
  description?: string;
  baseline: OutputReference;
  candidate: OutputReference;
  scorers: ScorerConfig[];
  minimumScore?: number;
}

export interface SuiteGates {
  minimumScore?: number;
  maxFailedCases?: number;
  failOnScorerError?: boolean;
}

export interface EvaluationSuiteConfig {
  version: 1;
  name: string;
  description?: string;
  gates?: SuiteGates;
  cases: EvaluationCaseConfig[];
}

export interface ScorerContext {
  suite: EvaluationSuiteConfig;
  evaluationCase: EvaluationCaseConfig;
  baseline: EvaluationOutput;
  candidate: EvaluationOutput;
}

export interface PluginScore {
  passed: boolean;
  score: number;
  summary: string;
  measurements?: Record<string, boolean | number | string | null>;
}

export interface ScorerPlugin<TConfig extends BaseScorerConfig = BaseScorerConfig> {
  readonly type: string;
  score(context: ScorerContext, config: TConfig): PluginScore | Promise<PluginScore>;
}

export interface ScorerResult extends PluginScore {
  id: string;
  type: string;
  gate: boolean;
  weight: number;
  error?: string;
}

export interface CaseResult {
  id: string;
  description?: string;
  passed: boolean;
  score: number;
  scorers: ScorerResult[];
}

export interface GateFailure {
  gate: string;
  message: string;
  caseId?: string;
  scorerId?: string;
}

export interface SuiteTotals {
  cases: number;
  passedCases: number;
  failedCases: number;
  scorers: number;
  passedScorers: number;
  failedScorers: number;
}

export interface SuiteResult {
  schemaVersion: 1;
  suite: string;
  configPath: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  passed: boolean;
  score: number;
  totals: SuiteTotals;
  estimatedCostUsd: {
    baseline: number | null;
    candidate: number | null;
    delta: number | null;
  };
  cases: CaseResult[];
  gateFailures: GateFailure[];
}

export interface RunOptions {
  plugins?: ScorerPlugin[];
  now?: () => Date;
}
