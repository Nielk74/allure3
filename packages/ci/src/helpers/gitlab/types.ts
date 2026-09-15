import type { Statistic } from "@allurereport/core-api";

export type GitlabIntegrationOptions = {
  token?: string;
  warn?: (message: string) => void;
};

export type GitlabOperationResult = {
  status: "ok" | "skipped";
  reason?: string;
};

export type GitlabReportSummary = {
  name: string;
  duration: number;
  stats: Statistic;
  newTests: number;
  flakyTests: number;
  retryTests: number;
};
