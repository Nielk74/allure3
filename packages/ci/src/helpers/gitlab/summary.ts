import { formatDuration } from "@allurereport/core-api";

import type { GitlabReportSummary } from "./types.js";

const CHARTS_BASE_URL = "https://allurecharts.qameta.workers.dev";

const statuses = ["passed", "failed", "broken", "skipped", "unknown"] as const;

type Status = (typeof statuses)[number];

const statusLabels: Record<Status, string> = {
  passed: "Passed",
  failed: "Failed",
  broken: "Broken",
  skipped: "Skipped",
  unknown: "Unknown",
};

const assertSafeHttpUrl = (value: string, name: string): string => {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error(`missing ${name}`);
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`invalid ${name}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`invalid ${name}`);
  }

  if (url.username || url.password) {
    throw new Error(`unsafe ${name}`);
  }

  return url.toString();
};

const escapeTableText = (value: string): string =>
  value
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}[\]()#+\-.!])/g, "\\$1")
    .replace(/\|/g, "\\|");

const count = (value: number): number => (Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0);

const escapeMarkdownLinkDestination = (url: string): string =>
  url.replace(/\|/g, "%7C").replace(/\(/g, "%28").replace(/\)/g, "%29");

const markdownLink = (label: string, url: string): string => `[${label}](${escapeMarkdownLinkDestination(url)})`;

const pieChartUrl = (summary: GitlabReportSummary): string => {
  const params = new URLSearchParams();

  for (const status of statuses) {
    params.set(status, String(count(summary.stats[status] ?? 0)));
  }

  return `${CHARTS_BASE_URL}/pie?${params.toString()}`;
};

const statusDotUrl = (status: Status): string => `${CHARTS_BASE_URL}/dot?status=${status}`;

const statsCell = (summary: GitlabReportSummary): string =>
  statuses
    .map((status) => ({ status, value: count(summary.stats[status] ?? 0) }))
    .filter(({ value }) => value > 0)
    .map(({ status, value }) => `![${statusLabels[status]}](${statusDotUrl(status)}) ${statusLabels[status]} ${value}`)
    .join("<br/>");

export const formatGitlabSummary = (
  summary: GitlabReportSummary,
  links: { reportUrl: string; jobUrl?: string },
): string => {
  const reportUrl = assertSafeHttpUrl(links.reportUrl, "report URL");
  const jobUrl = links.jobUrl ? assertSafeHttpUrl(links.jobUrl, "job URL") : undefined;
  const table = [
    "|  | Name | Duration | Stats | New | Flaky | Retry | Report |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    `| ![Status chart](${pieChartUrl(summary)}) | ${escapeTableText(summary.name)} | ${escapeTableText(
      formatDuration(summary.duration),
    )} | ${statsCell(summary)} | ${count(summary.newTests)} | ${count(summary.flakyTests)} | ${count(
      summary.retryTests,
    )} | ${markdownLink("View", reportUrl)} |`,
  ].join("\n");

  return ["# Allure Report Summary", jobUrl ? markdownLink("View GitLab job", jobUrl) : undefined, table]
    .filter((line): line is string => line !== undefined)
    .join("\n\n");
};
