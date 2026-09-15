export class ModelLedgerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelLedgerError";
  }
}

export class ValidationError extends ModelLedgerError {
  readonly issues: string[];

  constructor(source: string, issues: string[], options?: ErrorOptions) {
    super(
      `Validation failed for ${source}:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`,
      options,
    );
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export class UnknownScorerError extends ModelLedgerError {
  constructor(type: string, caseId: string) {
    super(`Unknown scorer "${type}" in case "${caseId}". Register a plugin for this scorer type.`);
    this.name = "UnknownScorerError";
  }
}
