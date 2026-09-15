import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  EvaluationOutput,
  EvaluationSuiteConfig,
  OutputReference,
} from "./domain.js";
import { ModelLedgerError } from "./errors.js";
import { parseJson, validateOutput, validateSuiteConfig } from "./validation.js";

export interface OutputLoaderContext {
  configDirectory: string;
  caseId: string;
  role: "baseline" | "candidate";
}

export interface OutputLoader {
  load(reference: OutputReference, context: OutputLoaderContext): Promise<EvaluationOutput>;
}

async function readJsonFile(filePath: string, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelLedgerError(`Unable to read ${label} at ${filePath}: ${message}`, {
      cause: error,
    });
  }
  return parseJson(text, filePath);
}

export class JsonFixtureOutputLoader implements OutputLoader {
  async load(reference: OutputReference, context: OutputLoaderContext): Promise<EvaluationOutput> {
    const fixturePath = path.resolve(context.configDirectory, reference.fixture);
    const value = await readJsonFile(
      fixturePath,
      `${context.role} fixture for case "${context.caseId}"`,
    );
    return validateOutput(value, fixturePath);
  }
}

export async function loadSuiteConfig(configPath: string): Promise<EvaluationSuiteConfig> {
  const absolutePath = path.resolve(configPath);
  const value = await readJsonFile(absolutePath, "suite configuration");
  return validateSuiteConfig(value, absolutePath);
}
