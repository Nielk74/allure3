import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { run } from "clipanion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitlabGenerateCommand } from "../../../src/commands/gitlab/generate.js";

type ResultStatus = "passed" | "failed" | "broken" | "skipped";

type StubRequest = {
  method: string;
  url: string;
  body: string;
};

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf-8");
};

const sendJson = (response: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(data));
};

const writeResult = async (resultsDir: string, id: string, status: ResultStatus, duration: number) => {
  await writeFile(
    join(resultsDir, `${id}-result.json`),
    `${JSON.stringify(
      {
        uuid: id,
        name: `${id} test`,
        fullName: `suite.${id}`,
        testCaseId: id,
        historyId: id,
        status,
        start: 1_700_000_000_000,
        stop: 1_700_000_000_000 + duration,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
};

const readJsonLines = async (filePath: string) =>
  (await readFile(filePath, "utf-8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const withEnv = (values: Record<string, string>) => {
  const original = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    original.set(key, process.env[key]);
    process.env[key] = value;
  }

  return () => {
    for (const [key, value] of original) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
};

describe("gitlab generate integration", () => {
  let tempDir: string;
  let restoreEnv: (() => void) | undefined;
  let restoreBaseEnv: (() => void) | undefined;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "allure-gitlab-generate-"));
    restoreBaseEnv = withEnv({
      GITHUB_ACTIONS: "",
      GITLAB_CI: "true",
      CI_SERVER_URL: "https://gitlab.example.com",
      CI_PAGES_DOMAIN: "",
      CI_PROJECT_ROOT_NAMESPACE_SLUG: "group",
      CI_PROJECT_NAME: "project",
      CI_PROJECT_ID: "100",
      CI_PROJECT_PATH: "group/project",
      CI_PROJECT_DIR: tempDir,
      CI_PIPELINE_ID: "10",
      CI_PIPELINE_SOURCE: "merge_request_event",
      CI_COMMIT_REF_NAME: "feature",
      CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feature",
      CI_JOB_NAME: "generate-report",
      CI_JOB_ID: "501",
      CI_JOB_URL: "https://gitlab.example.com/group/project/-/jobs/501",
      CI_MERGE_REQUEST_IID: "",
      CI_MERGE_REQUEST_PROJECT_ID: "",
      CI_API_V4_URL: "",
      CI_API_GRAPHQL_URL: "",
      GITLAB_TOKEN: "",
    });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    restoreEnv?.();
    restoreBaseEnv?.();
    restoreEnv = undefined;
    restoreBaseEnv = undefined;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("restores a failed prior job artifact, appends one history point, and updates the owned MR note with the report URL", async () => {
    const firstResults = join(tempDir, "first-results");
    const firstReport = join(tempDir, "first-report");
    const firstHistory = join(tempDir, "history.jsonl");
    await mkdir(firstResults, { recursive: true });
    await writeResult(firstResults, "alpha", "passed", 40);
    await writeResult(firstResults, "beta", "failed", 20);

    const commandStderr: string[] = [];
    const commandStdout: string[] = [];
    const commandIo = {
      stdout: { write: (chunk: string) => commandStdout.push(chunk) } as never,
      stderr: { write: (chunk: string) => commandStderr.push(chunk) } as never,
    };

    process.chdir(tempDir);
    await expect(
      run(
        GitlabGenerateCommand,
        ["gitlab", "generate", "--output", "first-report", "--history-path", "history.jsonl", firstResults],
        commandIo,
      ),
    ).resolves.toBe(0);

    expect(commandStderr.join("")).toContain("GitLab integration skipped: missing token");
    expect(commandStderr.join("")).toContain("GitLab summary note skipped: missing merge request");
    expect(commandStdout.join("")).toContain(
      "GitLab report URL: https://group.gitlab.io/-/project/-/jobs/501/artifacts/first-report/index.html",
    );
    await expect(readFile(join(firstReport, "index.html"), "utf-8")).resolves.toContain("Allure");

    const priorHistory = await readFile(firstHistory, "utf-8");
    await rm(firstHistory, { force: true });
    const createdBodies: string[] = [];
    const updatedBodies: string[] = [];
    const existingOwnedNoteBody =
      "<!-- allure-gitlab-summary:v1:Z2VuZXJhdGUtcmVwb3J0:10:501 -->\n# Previous Allure Report Summary";
    const requests: StubRequest[] = [];
    const server = createServer(async (request, response) => {
      const body = await readBody(request);
      requests.push({ method: request.method ?? "", url: request.url ?? "", body });

      if (request.url === "/api/graphql" && request.method === "POST") {
        sendJson(response, 200, {
          data: {
            project: {
              pipelines: {
                nodes: [
                  {
                    id: "gid://gitlab/Ci::Pipeline/20",
                    source: "merge_request_event",
                    job: {
                      id: "gid://gitlab/Ci::Build/700",
                      name: "generate-report",
                      status: "SUCCESS",
                      retried: false,
                    },
                  },
                  {
                    id: "gid://gitlab/Ci::Pipeline/10",
                    source: "merge_request_event",
                    job: {
                      id: "gid://gitlab/Ci::Build/501",
                      name: "generate-report",
                      status: "FAILED",
                      retried: false,
                    },
                  },
                  {
                    id: "gid://gitlab/Ci::Pipeline/9",
                    source: "merge_request_event",
                    job: {
                      id: "gid://gitlab/Ci::Build/500",
                      name: "generate-report",
                      status: "SUCCESS",
                      retried: false,
                    },
                  },
                ],
              },
            },
          },
        });
        return;
      }

      if (request.url === "/api/v4/projects/100/jobs/501/artifacts/history.jsonl" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(priorHistory);
        return;
      }

      if (
        request.url === "/api/v4/projects/100/merge_requests/5/notes?per_page=100&page=1" &&
        request.method === "GET"
      ) {
        sendJson(response, 200, [{ id: 77, body: existingOwnedNoteBody }], { "x-next-page": "" });
        return;
      }

      if (request.url === "/api/v4/projects/100/merge_requests/5/notes/77" && request.method === "PUT") {
        updatedBodies.push((JSON.parse(body) as { body: string }).body);
        sendJson(response, 200, { id: 77, body: updatedBodies.at(-1) });
        return;
      }

      if (request.url === "/api/v4/projects/100/merge_requests/5/notes" && request.method === "POST") {
        createdBodies.push((JSON.parse(body) as { body: string }).body);
        sendJson(response, 500, { message: "unexpected create" });
        return;
      }

      sendJson(response, 404, { message: "not found" });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server did not bind to a local port");
    }

    const secondResults = join(tempDir, "second-results");
    const secondReport = join(tempDir, "second-report");
    const secondHistory = firstHistory;
    await mkdir(secondResults, { recursive: true });
    await writeResult(secondResults, "alpha", "passed", 30);
    await writeResult(secondResults, "gamma", "failed", 50);

    const serverBase = `http://127.0.0.1:${address.port}`;
    restoreEnv = withEnv({
      GITLAB_CI: "true",
      CI_PROJECT_ID: "100",
      CI_PROJECT_PATH: "group/project",
      CI_PROJECT_DIR: tempDir,
      CI_PIPELINE_ID: "20",
      CI_PIPELINE_SOURCE: "merge_request_event",
      CI_COMMIT_REF_NAME: "feature",
      CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feature",
      CI_JOB_NAME: "generate-report",
      CI_JOB_ID: "700",
      CI_JOB_URL: `${serverBase}/group/project/-/jobs/700`,
      CI_MERGE_REQUEST_IID: "5",
      CI_MERGE_REQUEST_PROJECT_ID: "100",
      CI_API_V4_URL: `${serverBase}/api/v4`,
      CI_API_GRAPHQL_URL: `${serverBase}/api/graphql`,
      GITLAB_TOKEN: "local-token",
    });

    try {
      await expect(
        run(
          GitlabGenerateCommand,
          ["gitlab", "generate", "--output", "second-report", "--history-path", "history.jsonl", secondResults],
          commandIo,
        ),
      ).resolves.toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    await expect(readFile(join(secondReport, "index.html"), "utf-8")).resolves.toContain("Allure");
    const historyPoints = await readJsonLines(secondHistory);
    expect(historyPoints).toHaveLength(2);
    expect(historyPoints.map(({ url }) => url).sort()).toEqual([
      "https://group.gitlab.io/-/project/-/jobs/501/artifacts/first-report/index.html",
      "https://group.gitlab.io/-/project/-/jobs/700/artifacts/second-report/index.html",
    ]);
    expect(requests.filter(({ url }) => url === "/api/graphql")).toHaveLength(1);
    expect(requests.filter(({ url }) => url.includes("/artifacts/"))).toEqual([
      expect.objectContaining({ url: "/api/v4/projects/100/jobs/501/artifacts/history.jsonl" }),
    ]);
    expect(createdBodies).toEqual([]);
    expect(updatedBodies).toHaveLength(1);
    expect(
      requests.filter(
        ({ method, url }) => method === "PUT" && url === "/api/v4/projects/100/merge_requests/5/notes/77",
      ),
    ).toHaveLength(1);
    expect(updatedBodies[0]).toBe(
      "<!-- allure-gitlab-summary:v1:Z2VuZXJhdGUtcmVwb3J0:20:700 -->\n" +
        "https://group.gitlab.io/-/project/-/jobs/700/artifacts/second-report/index.html",
    );
    expect(commandStdout.join("")).toContain(
      "GitLab report URL: https://group.gitlab.io/-/project/-/jobs/700/artifacts/second-report/index.html",
    );
  }, 120_000);

  it("does not fall back to an older artifact after the selected prior job returns 404", async () => {
    const requests: StubRequest[] = [];
    const commandStderr: string[] = [];
    const commandStdout: string[] = [];
    const commandIo = {
      stdout: { write: (chunk: string) => commandStdout.push(chunk) } as never,
      stderr: { write: (chunk: string) => commandStderr.push(chunk) } as never,
    };
    const server = createServer(async (request, response) => {
      const body = await readBody(request);
      requests.push({ method: request.method ?? "", url: request.url ?? "", body });

      if (request.url === "/api/graphql" && request.method === "POST") {
        sendJson(response, 200, {
          data: {
            project: {
              pipelines: {
                nodes: [
                  {
                    id: "gid://gitlab/Ci::Pipeline/10",
                    source: "merge_request_event",
                    job: {
                      id: "gid://gitlab/Ci::Build/501",
                      name: "generate-report",
                      status: "FAILED",
                      retried: false,
                    },
                  },
                  {
                    id: "gid://gitlab/Ci::Pipeline/9",
                    source: "merge_request_event",
                    job: {
                      id: "gid://gitlab/Ci::Build/500",
                      name: "generate-report",
                      status: "SUCCESS",
                      retried: false,
                    },
                  },
                ],
              },
            },
          },
        });
        return;
      }

      if (request.url?.includes("/artifacts/")) {
        sendJson(response, request.url.includes("/jobs/501/") ? 404 : 200, { message: "artifact" });
        return;
      }

      if (request.url === "/api/v4/projects/100/merge_requests/5/notes?per_page=100&page=1") {
        sendJson(response, 200, [], { "x-next-page": "" });
        return;
      }

      if (request.url === "/api/v4/projects/100/merge_requests/5/notes" && request.method === "POST") {
        sendJson(response, 201, { id: 1, body });
        return;
      }

      sendJson(response, 404, { message: "not found" });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server did not bind to a local port");
    }

    const results = join(tempDir, "results");
    const report = join(tempDir, "report");
    const history = join(tempDir, "history.jsonl");
    await mkdir(results, { recursive: true });
    await writeResult(results, "delta", "passed", 10);

    const serverBase = `http://127.0.0.1:${address.port}`;
    restoreEnv = withEnv({
      GITLAB_CI: "true",
      CI_PROJECT_ID: "100",
      CI_PROJECT_PATH: "group/project",
      CI_PROJECT_DIR: tempDir,
      CI_PIPELINE_ID: "20",
      CI_PIPELINE_SOURCE: "merge_request_event",
      CI_COMMIT_REF_NAME: "feature",
      CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feature",
      CI_JOB_NAME: "generate-report",
      CI_JOB_ID: "700",
      CI_JOB_URL: `${serverBase}/group/project/-/jobs/700`,
      CI_MERGE_REQUEST_IID: "5",
      CI_MERGE_REQUEST_PROJECT_ID: "100",
      CI_API_V4_URL: `${serverBase}/api/v4`,
      CI_API_GRAPHQL_URL: `${serverBase}/api/graphql`,
      GITLAB_TOKEN: "local-token",
    });

    process.chdir(tempDir);
    try {
      await expect(
        run(
          GitlabGenerateCommand,
          [
            "gitlab",
            "generate",
            "--output",
            "report",
            "--history-path",
            "history.jsonl",
            "--history-base-url",
            `${serverBase}/group/project/-/jobs/700/artifacts/report`,
            results,
          ],
          commandIo,
        ),
      ).resolves.toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(requests.filter(({ url }) => url.includes("/artifacts/"))).toEqual([
      expect.objectContaining({ url: "/api/v4/projects/100/jobs/501/artifacts/history.jsonl" }),
    ]);
    expect(commandStderr.join("")).toContain("GitLab history restore skipped: artifact download failed");
    await expect(readJsonLines(history)).resolves.toEqual([
      expect.objectContaining({ url: `${serverBase}/group/project/-/jobs/700/artifacts/report/index.html` }),
    ]);
    await expect(readFile(join(report, "index.html"), "utf-8")).resolves.toContain("Allure");
    const notes = requests.filter(
      ({ method, url }) => method === "POST" && url === "/api/v4/projects/100/merge_requests/5/notes",
    );
    expect(notes).toHaveLength(1);
    expect(JSON.parse(notes[0].body).body).toBe(
      "<!-- allure-gitlab-summary:v1:Z2VuZXJhdGUtcmVwb3J0:20:700 -->\n" +
        `${serverBase}/group/project/-/jobs/700/artifacts/report/index.html`,
    );
    expect(commandStdout.join("")).toContain(
      `GitLab report URL: ${serverBase}/group/project/-/jobs/700/artifacts/report/index.html`,
    );
  }, 120_000);
});
