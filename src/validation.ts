import { z } from "zod";

import type { EvaluationOutput, EvaluationSuiteConfig } from "./domain.js";
import { ValidationError } from "./errors.js";

const nonNegativeNumber = z.number().finite().nonnegative();
const percentage = nonNegativeNumber;

const outputReferenceSchema = z
  .object({
    fixture: z.string().trim().min(1, "fixture path must not be empty"),
  })
  .strict();

const scorerBase = {
  id: z.string().trim().min(1).optional(),
  gate: z.boolean().optional(),
  weight: z.number().finite().positive().optional(),
};

const exactMatchSchema = z
  .object({
    ...scorerBase,
    type: z.literal("exact-match"),
    options: z
      .object({
        trim: z.boolean().optional(),
        caseSensitive: z.boolean().optional(),
        collapseWhitespace: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const containsRequiredTermsSchema = z
  .object({
    ...scorerBase,
    type: z.literal("contains-required-terms"),
    options: z
      .object({
        terms: z.array(z.string().min(1, "required terms must not be empty")).min(1),
        caseSensitive: z.boolean().optional(),
        match: z.enum(["all", "any"]).optional(),
      })
      .strict(),
  })
  .strict();

const validJsonSchema = z
  .object({
    ...scorerBase,
    type: z.literal("valid-json"),
    options: z
      .object({
        requireObject: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const latencyBudgetSchema = z
  .object({
    ...scorerBase,
    type: z.literal("latency-budget"),
    options: z
      .object({
        maxMs: nonNegativeNumber.optional(),
        maxIncreasePercent: percentage.optional(),
      })
      .strict()
      .refine((value) => value.maxMs !== undefined || value.maxIncreasePercent !== undefined, {
        message: "at least one of maxMs or maxIncreasePercent is required",
      }),
  })
  .strict();

const estimatedCostBudgetSchema = z
  .object({
    ...scorerBase,
    type: z.literal("estimated-cost-budget"),
    options: z
      .object({
        maxUsd: nonNegativeNumber.optional(),
        maxIncreasePercent: percentage.optional(),
      })
      .strict()
      .refine((value) => value.maxUsd !== undefined || value.maxIncreasePercent !== undefined, {
        message: "at least one of maxUsd or maxIncreasePercent is required",
      }),
  })
  .strict();

const scorerSchema = z.discriminatedUnion("type", [
  exactMatchSchema,
  containsRequiredTermsSchema,
  validJsonSchema,
  latencyBudgetSchema,
  estimatedCostBudgetSchema,
]);

const builtInScorerTypes = new Set([
  "exact-match",
  "contains-required-terms",
  "valid-json",
  "latency-budget",
  "estimated-cost-budget",
]);

const extensibleScorerSchema = z
  .object({
    ...scorerBase,
    type: z.string().trim().min(1),
    options: z.unknown().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!builtInScorerTypes.has(value.type)) {
      return;
    }
    const result = scorerSchema.safeParse(value);
    if (!result.success) {
      result.error.issues.forEach((issue) => {
        context.addIssue({
          code: "custom",
          message: issue.message,
          path: issue.path,
        });
      });
    }
  });

const evaluationCaseSchema = z
  .object({
    id: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    baseline: outputReferenceSchema,
    candidate: outputReferenceSchema,
    scorers: z.array(extensibleScorerSchema).min(1, "at least one scorer is required"),
    minimumScore: z.number().finite().min(0).max(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const scorerIds = new Set<string>();
    value.scorers.forEach((scorer, index) => {
      const id = scorer.id ?? `${scorer.type}-${index + 1}`;
      if (scorerIds.has(id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate scorer id "${id}"`,
          path: ["scorers", index, "id"],
        });
      }
      scorerIds.add(id);
    });
  });

const suiteSchema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    gates: z
      .object({
        minimumScore: z.number().finite().min(0).max(1).optional(),
        maxFailedCases: z.number().int().nonnegative().optional(),
        failOnScorerError: z.boolean().optional(),
      })
      .strict()
      .optional(),
    cases: z.array(evaluationCaseSchema).min(1, "at least one case is required"),
  })
  .strict()
  .superRefine((value, context) => {
    const caseIds = new Set<string>();
    value.cases.forEach((evaluationCase, index) => {
      if (caseIds.has(evaluationCase.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate case id "${evaluationCase.id}"`,
          path: ["cases", index, "id"],
        });
      }
      caseIds.add(evaluationCase.id);
    });
  });

const outputSchema = z
  .object({
    content: z.string(),
    latencyMs: nonNegativeNumber.optional(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    pricing: z
      .object({
        inputPerMillionUsd: nonNegativeNumber,
        outputPerMillionUsd: nonNegativeNumber,
      })
      .strict()
      .optional(),
    estimatedCostUsd: nonNegativeNumber.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((value) => value.pricing === undefined || value.usage !== undefined, {
    message: "usage is required when pricing is supplied",
    path: ["usage"],
  });

function formatPath(path: PropertyKey[]): string {
  if (path.length === 0) {
    return "$";
  }

  return path.reduce<string>((result, segment) => {
    if (typeof segment === "number") {
      return `${result}[${segment}]`;
    }
    return result === "$" ? `$.${String(segment)}` : `${result}.${String(segment)}`;
  }, "$");
}

function validationIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`);
}

export function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ValidationError(source, [`invalid JSON: ${message}`], { cause: error });
  }
}

export function validateSuiteConfig(value: unknown, source: string): EvaluationSuiteConfig {
  const result = suiteSchema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(source, validationIssues(result.error));
  }
  return result.data as EvaluationSuiteConfig;
}

export function validateOutput(value: unknown, source: string): EvaluationOutput {
  const result = outputSchema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(source, validationIssues(result.error));
  }
  return result.data as EvaluationOutput;
}
