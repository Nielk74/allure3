import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { cwd as processCwd } from "node:process";

import { restoreGitlabHistory, upsertGitlabJobNote } from "@allurereport/ci";
import { readConfig } from "@allurereport/core";
import { Command, Option } from "clipanion";
import { red } from "yoctocolors";

import { generate } from "../commons/generate.js";

const isDecimalString = (value: string): boolean => /^[0-9]+$/.test(value);

const parseHistoryLimit = (value: unknown): number | undefined => {
  if (typeof value === "string") {
    if (!isDecimalString(value)) {
      return undefined;
    }

    const parsed = Number(value);

    return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : undefined;
  }

  return undefined;
};

const formatHistoryLimit = (value: unknown): string => (typeof value === "string" ? value : String(value));

const normalizeReportDirectoryUrl = (value: string): { historyBaseUrl: string; reportUrl: string } => {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error("missing history base URL");
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("invalid history base URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("history base URL must use HTTP or HTTPS");
  }

  if (url.username || url.password) {
    throw new Error("history base URL must not contain credentials");
  }

  const directoryUrl = url.pathname.endsWith("/index.html") ? new URL("./", url) : url;

  if (!directoryUrl.pathname.endsWith("/")) {
    directoryUrl.pathname = `${directoryUrl.pathname}/`;
  }

  return {
    historyBaseUrl: directoryUrl.toString(),
    reportUrl: new URL("index.html", directoryUrl).toString(),
  };
};

export class GitlabGenerateCommand extends Command {
  static paths = [["gitlab", "generate"]];

  static usage = Command.Usage({
    category: "Integrations",
    description: "Generate test report and post report summary in merge request comments",
    details:
      "This command generates a report from the provided Allure Results directories. When api access token is configured, " +
      "integration will post summary as comment for merge request pipelines and attempt to lookup history file from previously executed job ." +
      "This integration is designed to be executed from within GitLab CI job.",
    examples: [["gitlab generate ./allure-results", "Generate a report from the ./allure-results directory"]],
  });

  resultsDir = Option.Rest({
    name: "Patterns to match test results directories. Overrides config.resultsDir. Defaults to ./**/allure-results when neither is set.",
  });

  config = Option.String("--config,-c", {
    description: "The path to Allure config file",
  });

  output = Option.String("--output,-o", {
    description: "The output directory name. Absolute paths are accepted as well (default: allure-report)",
  });

  reportName = Option.String("--report-name,--name", {
    description: "The report name (default: Allure Report)",
  });

  dump = Option.Array("--dump", {
    description:
      "Path or pattern that matches one or more archives created by `allure run --dump ...`. " +
      "Allure loads the matched archives before generating the report. " +
      "This option can be specified multiple times.",
  });

  historyPath = Option.String("--history-path", {
    description: "History file path",
  });

  historyLimit = Option.String("--history-limit", {
    description: "Limits the number of history entries to keep (default: 100)",
  });

  historyBaseUrl = Option.String("--history-base-url", {
    description: "The public base URL of the generated report directory",
  });

  gitlabToken = Option.String("--gitlab-token", {
    description: "GitLab api token with api write access",
  });

  async execute() {
    const cwd = processCwd();

    if (this.config && !existsSync(this.config)) {
      this.context.stderr.write(`${red(`Config file not found: ${this.config}`)}\n`);

      return 1;
    }

    const cliHistoryLimit = this.historyLimit === undefined ? undefined : parseHistoryLimit(this.historyLimit);

    if (this.historyLimit !== undefined && cliHistoryLimit === undefined) {
      this.context.stderr.write(`${red(`Invalid history limit: ${this.historyLimit}`)}\n`);

      return 1;
    }

    let cliReportUrls: { historyBaseUrl: string; reportUrl: string } | undefined;

    try {
      cliReportUrls = this.historyBaseUrl === undefined ? undefined : normalizeReportDirectoryUrl(this.historyBaseUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid history base URL";
      this.context.stderr.write(`${red(message)}\n`);

      return 1;
    }

    const config = await readConfig(cwd, this.config, {
      name: this.reportName,
      output: this.output,
      historyBaseUrl: cliReportUrls?.historyBaseUrl,
      historyPath: this.historyPath,
      historyLimit: cliHistoryLimit,
    });

    if (config.allureService) {
      this.context.stderr.write(
        `${red("GitLab artifact generation cannot be combined with Allure service publishing configuration")}\n`,
      );

      return 1;
    }

    const effectiveConfig = {
      ...config,
      historyPath: config.historyPath ?? resolve(cwd, "history.jsonl"),
      historyLimit: config.historyLimit ?? 100,
      historyBaseUrl: config.historyBaseUrl ?? cliReportUrls?.historyBaseUrl,
    };
    const effectiveHistoryLimit = parseHistoryLimit(effectiveConfig.historyLimit);

    if (effectiveHistoryLimit === undefined) {
      this.context.stderr.write(
        `${red(`Invalid history limit: ${formatHistoryLimit(effectiveConfig.historyLimit)}`)}\n`,
      );

      return 1;
    }

    effectiveConfig.historyLimit = effectiveHistoryLimit;

    let reportUrls: { historyBaseUrl: string; reportUrl: string };

    try {
      reportUrls = normalizeReportDirectoryUrl(effectiveConfig.historyBaseUrl ?? "");
      effectiveConfig.historyBaseUrl = reportUrls.historyBaseUrl;
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid history base URL";
      this.context.stderr.write(`${red(message)}\n`);

      return 1;
    }

    const warn = (message: string) => {
      this.context.stderr.write(`${message}\n`);
    };

    await restoreGitlabHistory({
      token: this.gitlabToken,
      warn,
      historyPath: effectiveConfig.historyPath,
    });

    const result = await generate({
      dump: this.dump,
      resultsDir: this.resultsDir,
      cwd,
      config: effectiveConfig,
      collectSummary: true,
    });

    if (!result) {
      return;
    }

    this.context.stdout.write(`GitLab report URL: ${reportUrls.reportUrl}\n`);

    if (result.summary && existsSync(join(effectiveConfig.output, "index.html"))) {
      await upsertGitlabJobNote({
        token: this.gitlabToken,
        warn,
        summary: result.summary,
        reportUrl: reportUrls.reportUrl,
      });
    }
  }
}
