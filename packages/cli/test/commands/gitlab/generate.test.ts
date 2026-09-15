import { existsSync } from "node:fs";

import { restoreGitlabHistory, upsertGitlabJobNote } from "@allurereport/ci";
import { readConfig } from "@allurereport/core";
import { run } from "clipanion";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { generate } from "../../../src/commands/commons/generate.js";
import { GitlabGenerateCommand } from "../../../src/commands/gitlab/generate.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(),
}));
vi.mock("@allurereport/core", () => ({
  readConfig: vi.fn(),
}));
vi.mock("@allurereport/ci", () => ({
  restoreGitlabHistory: vi.fn().mockResolvedValue({ status: "skipped", reason: "gitlab unavailable" }),
  upsertGitlabJobNote: vi.fn().mockResolvedValue({ status: "skipped", reason: "missing merge request" }),
}));
vi.mock("../../../src/commands/commons/generate.js", () => ({
  generate: vi.fn(),
}));

const output = "/tmp/allure-report";
const baseConfig = {
  name: "Allure Report",
  output,
  historyPath: "/tmp/history.jsonl",
  historyLimit: 100,
  historyBaseUrl: "https://group.gitlab.io/-/project/-/jobs/123/artifacts/allure-report/",
  open: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(readConfig).mockResolvedValue(baseConfig as never);
  vi.mocked(generate).mockResolvedValue({
    summary: {
      name: "Allure Report",
      duration: 42,
      stats: { total: 1, passed: 1, failed: 0, broken: 0, skipped: 0, unknown: 0 },
      newTests: 1,
      flakyTests: 0,
      retryTests: 0,
    },
  });
});

describe("gitlab generate command", () => {
  it("restores history before generation, snapshots summary, prints report URL, and posts after index exists", async () => {
    const events: string[] = [];
    const stdoutWrite = vi.fn();
    vi.mocked(restoreGitlabHistory).mockImplementationOnce(async () => {
      events.push("restore");

      return { status: "ok" };
    });
    vi.mocked(generate).mockImplementationOnce(async () => {
      events.push("generate");

      return {
        summary: {
          name: "Allure Report",
          duration: 42,
          stats: { total: 1, passed: 1, failed: 0, broken: 0, skipped: 0, unknown: 0 },
          newTests: 1,
          flakyTests: 0,
          retryTests: 0,
        },
      };
    });
    vi.mocked(upsertGitlabJobNote).mockImplementationOnce(async () => {
      events.push("note");

      return { status: "ok" };
    });
    vi.mocked(existsSync).mockImplementation((path) => String(path) === "/tmp/allure-report/index.html");

    const exitCode = await run(
      GitlabGenerateCommand,
      [
        "gitlab",
        "generate",
        "--history-base-url",
        "https://group.gitlab.io/-/project/-/jobs/123/artifacts/allure-report/",
        "--gitlab-token",
        "token-from-cli",
        "./results",
      ],
      {
        stdout: { write: stdoutWrite } as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(events).toEqual(["restore", "generate", "note"]);
    expect(restoreGitlabHistory).toHaveBeenCalledWith(
      expect.objectContaining({ token: "token-from-cli", historyPath: "/tmp/history.jsonl" }),
    );
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ collectSummary: true, resultsDir: ["./results"], config: baseConfig }),
    );
    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining("https://group.gitlab.io/-/project/-/jobs/123/artifacts/allure-report/index.html"),
    );
    expect(upsertGitlabJobNote).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "token-from-cli",
        reportUrl: "https://group.gitlab.io/-/project/-/jobs/123/artifacts/allure-report/index.html",
        summary: expect.objectContaining({ newTests: 1 }),
      }),
    );
  });

  it("lets config values win over command defaults and lets explicit CLI values win over config", async () => {
    await run(GitlabGenerateCommand, [
      "gitlab",
      "generate",
      "--output",
      "cli-report",
      "--report-name",
      "CLI Name",
      "--history-path",
      "cli-history.jsonl",
      "--history-limit",
      "7",
      "--history-base-url",
      "https://example.test/reports/7",
    ]);

    expect(readConfig).toHaveBeenCalledWith(expect.any(String), undefined, {
      name: "CLI Name",
      output: "cli-report",
      historyBaseUrl: "https://example.test/reports/7/",
      historyPath: "cli-history.jsonl",
      historyLimit: 7,
    });

    vi.mocked(readConfig).mockClear();
    vi.mocked(readConfig).mockResolvedValueOnce({
      ...baseConfig,
      output: "/tmp/config-report",
      historyPath: "/tmp/config-history.jsonl",
      historyLimit: 4,
      historyBaseUrl: "https://example.test/config/",
    } as never);

    await run(GitlabGenerateCommand, ["gitlab", "generate"]);

    expect(readConfig).toHaveBeenCalledWith(expect.any(String), undefined, {
      name: undefined,
      output: undefined,
      historyBaseUrl: undefined,
      historyPath: undefined,
      historyLimit: undefined,
    });
    expect(restoreGitlabHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ historyPath: "/tmp/config-history.jsonl" }),
    );
  });

  it("preserves results and dump options without replacing configured native renderers", async () => {
    vi.mocked(readConfig).mockResolvedValueOnce({
      ...baseConfig,
      plugins: [{ id: "classic", enabled: true, plugin: {}, options: {} }],
    } as never);

    await run(GitlabGenerateCommand, [
      "gitlab",
      "generate",
      "--history-base-url",
      "https://example.test/report/",
      "--dump",
      "dump.zip",
      "./results",
    ]);

    expect(readConfig).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      expect.not.objectContaining({ plugins: expect.anything() }),
    );
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        dump: ["dump.zip"],
        resultsDir: ["./results"],
        config: expect.objectContaining({ plugins: [expect.objectContaining({ id: "classic" })] }),
      }),
    );
  });

  it("does not post a note when generation fails, omits summary, or the report entry point is absent", async () => {
    vi.mocked(generate).mockResolvedValueOnce(undefined);

    await run(GitlabGenerateCommand, ["gitlab", "generate", "--history-base-url", "https://example.test/report/"]);

    expect(upsertGitlabJobNote).not.toHaveBeenCalled();

    vi.mocked(generate).mockResolvedValueOnce({});
    await run(GitlabGenerateCommand, ["gitlab", "generate", "--history-base-url", "https://example.test/report/"]);

    expect(upsertGitlabJobNote).not.toHaveBeenCalled();

    vi.mocked(generate).mockResolvedValueOnce({ summary: baseConfig as never });
    vi.mocked(existsSync).mockReturnValue(false);
    await run(GitlabGenerateCommand, ["gitlab", "generate", "--history-base-url", "https://example.test/report/"]);

    expect(upsertGitlabJobNote).not.toHaveBeenCalled();
  });

  it("rejects invalid command configuration before GitLab or generation work", async () => {
    const stderr: string[] = [];
    const runInvalidCommand = async (args: string[]) =>
      await run(GitlabGenerateCommand, args, {
        stderr: { write: (chunk: string) => stderr.push(chunk) } as never,
      });

    await expect(
      runInvalidCommand([
        "gitlab",
        "generate",
        "--history-limit",
        "bad",
        "--history-base-url",
        "https://example.test/report/",
      ]),
    ).resolves.toBe(1);
    await expect(
      runInvalidCommand([
        "gitlab",
        "generate",
        "--history-limit",
        "1".padEnd(400, "0"),
        "--history-base-url",
        "https://example.test/report/",
      ]),
    ).resolves.toBe(1);
    await expect(
      runInvalidCommand(["gitlab", "generate", "--history-base-url", "ftp://example.test/report/"]),
    ).resolves.toBe(1);
    await expect(
      runInvalidCommand(["gitlab", "generate", "--history-base-url", "https://user:pass@example.test/report/"]),
    ).resolves.toBe(1);

    vi.mocked(existsSync).mockReturnValue(false);
    await expect(
      runInvalidCommand([
        "gitlab",
        "generate",
        "--config",
        "missing.mjs",
        "--history-base-url",
        "https://example.test/report/",
      ]),
    ).resolves.toBe(1);

    expect(stderr.join("")).toContain("Invalid history limit: bad");
    expect(stderr.join("")).toContain("Invalid history limit: 1");
    expect(stderr.join("")).toContain("history base URL must use HTTP or HTTPS");
    expect(stderr.join("")).toContain("history base URL must not contain credentials");
    expect(stderr.join("")).toContain("Config file not found: missing.mjs");
    expect(restoreGitlabHistory).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects invalid configured history limits before GitLab or generation work", async () => {
    const stderr: string[] = [];
    vi.mocked(readConfig).mockResolvedValueOnce({
      ...baseConfig,
      historyLimit: "bad",
    } as never);

    await expect(
      run(GitlabGenerateCommand, ["gitlab", "generate"], {
        stderr: { write: (chunk: string) => stderr.push(chunk) } as never,
      }),
    ).resolves.toBe(1);

    expect(stderr.join("")).toContain("Invalid history limit: bad");
    expect(restoreGitlabHistory).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("accepts zero as the effective history limit", async () => {
    vi.mocked(readConfig).mockResolvedValueOnce({
      ...baseConfig,
      historyLimit: 0,
    } as never);

    await expect(run(GitlabGenerateCommand, ["gitlab", "generate"])).resolves.toBe(0);

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.objectContaining({ historyLimit: 0 }) }),
    );
  });

  it("rejects remote Allure service publishing configuration for local artifact generation", async () => {
    const stderr: string[] = [];
    vi.mocked(readConfig).mockResolvedValueOnce({
      ...baseConfig,
      allureService: { endpoint: "https://allure.example" },
    } as never);

    await expect(
      run(GitlabGenerateCommand, ["gitlab", "generate", "--history-base-url", "https://example.test/report/"], {
        stderr: { write: (chunk: string) => stderr.push(chunk) } as never,
      }),
    ).resolves.toBe(1);

    expect(stderr.join("")).toContain(
      "GitLab artifact generation cannot be combined with Allure service publishing configuration",
    );
    expect(restoreGitlabHistory).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});
