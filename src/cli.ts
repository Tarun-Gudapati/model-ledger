#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { ModelLedgerError } from "./errors.js";
import { formatTerminalSummary, serializeJsonReport, writeJsonReport } from "./reporters.js";
import { runSuite } from "./runner.js";

interface RunCommand {
  configPath: string;
  reportPath?: string;
  writeReport: boolean;
  json: boolean;
  quiet: boolean;
}

const help = `ModelLedger 0.1.0

Offline regression checks for recorded LLM outputs.

Usage:
  model-ledger run <suite.json> [options]
  model-ledger --help
  model-ledger --version

Options:
  --report <path>  JSON report path (default: model-ledger-report.json)
  --no-report      Do not write a JSON report file
  --json           Print the JSON report to stdout
  --quiet          Suppress the readable terminal summary
  -h, --help       Show help
`;

function parseRunCommand(args: string[]): RunCommand {
  const configPath = args[0];
  if (configPath === undefined || configPath.startsWith("-")) {
    throw new ModelLedgerError("A suite configuration path is required.\n\n" + help);
  }

  let reportPath = "model-ledger-report.json";
  let writeReport = true;
  let json = false;
  let quiet = false;

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--report": {
        const value = args[index + 1];
        if (value === undefined || value.startsWith("-")) {
          throw new ModelLedgerError("--report requires a path");
        }
        reportPath = value;
        index += 1;
        break;
      }
      case "--no-report":
        writeReport = false;
        break;
      case "--json":
        json = true;
        break;
      case "--quiet":
        quiet = true;
        break;
      case "--help":
      case "-h":
        throw new ModelLedgerError(help);
      default:
        throw new ModelLedgerError(`Unknown option "${argument}"`);
    }
  }

  return { configPath, reportPath, writeReport, json, quiet };
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(help);
    return 0;
  }
  if (args[0] === "--version") {
    console.log("0.1.0");
    return 0;
  }
  if (args[0] !== "run") {
    console.error(`Unknown command "${args[0]}".\n\n${help}`);
    return 2;
  }

  try {
    const command = parseRunCommand(args.slice(1));
    const result = await runSuite(command.configPath);
    let writtenReportPath: string | undefined;
    if (command.writeReport && command.reportPath !== undefined) {
      writtenReportPath = await writeJsonReport(result, command.reportPath);
    }

    if (command.json) {
      process.stdout.write(serializeJsonReport(result));
    }
    if (!command.quiet) {
      const destination = command.json ? console.error : console.log;
      destination(formatTerminalSummary(result));
      if (writtenReportPath !== undefined) {
        destination(`\nJSON report: ${writtenReportPath}`);
      }
    }
    return result.passed ? 0 : 1;
  } catch (error) {
    const message =
      error instanceof ModelLedgerError || error instanceof Error ? error.message : String(error);
    console.error(`ModelLedger error: ${message}`);
    return 2;
  }
}

const entryPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (entryPath === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
