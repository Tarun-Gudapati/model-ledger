import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SuiteResult } from "./domain.js";

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function cost(value: number | null): string {
  return value === null ? "unavailable" : `$${value.toFixed(6)}`;
}

export function formatTerminalSummary(result: SuiteResult): string {
  const lines = [
    `ModelLedger — ${result.suite}`,
    `Status: ${result.passed ? "PASS" : "FAIL"}  Score: ${percentage(result.score)}`,
    `Cases: ${result.totals.passedCases}/${result.totals.cases} passed  Scorers: ${result.totals.passedScorers}/${result.totals.scorers} passed`,
    `Estimated cost: baseline ${cost(result.estimatedCostUsd.baseline)}, candidate ${cost(result.estimatedCostUsd.candidate)}, delta ${cost(result.estimatedCostUsd.delta)}`,
    "",
  ];

  for (const evaluationCase of result.cases) {
    lines.push(
      `[${evaluationCase.passed ? "PASS" : "FAIL"}] ${evaluationCase.id} (${percentage(evaluationCase.score)})`,
    );
    for (const scorer of evaluationCase.scorers) {
      const status = scorer.error !== undefined ? "ERROR" : scorer.passed ? "PASS" : "FAIL";
      lines.push(`  [${status}] ${scorer.id}: ${scorer.summary}`);
      if (scorer.error !== undefined) {
        lines.push(`          ${scorer.error}`);
      }
    }
  }

  if (result.gateFailures.length > 0) {
    lines.push("", "Regression gates:");
    result.gateFailures.forEach((failure) => {
      lines.push(`  - ${failure.message}`);
    });
  }

  return lines.join("\n");
}

export function serializeJsonReport(result: SuiteResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export async function writeJsonReport(result: SuiteResult, reportPath: string): Promise<string> {
  const absolutePath = path.resolve(reportPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, serializeJsonReport(result), "utf8");
  return absolutePath;
}
