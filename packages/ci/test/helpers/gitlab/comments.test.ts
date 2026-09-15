import { story } from "allure-js-commons";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { upsertGitlabJobNote } from "../../../src/helpers/gitlab/comments.js";
import type { GitlabReportSummary } from "../../../src/helpers/gitlab/types.js";
import { gitlabEnv, jsonResponse, mockEnv, stubFetch } from "./test-utils.js";

vi.mock("../../../src/utils.js", () => ({
  getEnv: vi.fn(),
}));

const summary: GitlabReportSummary = {
  name: "Tests | <smoke>",
  duration: 1000,
  stats: { total: 9, passed: 4, failed: 1, broken: 2, skipped: 1, unknown: 1 },
  newTests: 2,
  flakyTests: 1,
  retryTests: 3,
};

const mergeRequestEnv = (overrides: Record<string, string> = {}) =>
  gitlabEnv({ CI_MERGE_REQUEST_IID: "7", CI_MERGE_REQUEST_PROJECT_ID: "1", ...overrides });

const marker = (pipelineId: string, jobId: string, encodedJobName = "dGVzdHM=") =>
  `<!-- allure-gitlab-summary:v1:${encodedJobName}:${pipelineId}:${jobId} -->`;

const noteBody = (pipelineId: string, jobId: string, text = "old", encodedJobName = "dGVzdHM=") =>
  `${marker(pipelineId, jobId, encodedJobName)}\n${text}`;

const notesPath = (page: number) =>
  `https://gitlab.example.com/api/v4/projects/1/merge_requests/7/notes?per_page=100&page=${page}`;

const notesResponse = (notes: unknown, nextPage = "") =>
  jsonResponse(notes, { headers: { "content-type": "application/json", "x-next-page": nextPage } });

const requestBody = (body?: string) => JSON.parse(body ?? "{}").body as string;

beforeEach(async () => {
  await story("gitlab comments");
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("upsertGitlabJobNote", () => {
  it("creates an owned MR note with the rendered summary body when no matching note exists", async () => {
    mockEnv(mergeRequestEnv());
    const { calls } = stubFetch((call) => {
      if (call.method === "GET" && call.url === notesPath(1)) {
        return notesResponse([]);
      }

      if (
        call.method === "POST" &&
        call.url === "https://gitlab.example.com/api/v4/projects/1/merge_requests/7/notes"
      ) {
        return jsonResponse({ id: 10, body: requestBody(call.body) });
      }

      return new Response("unexpected", { status: 500 });
    });

    const result = await upsertGitlabJobNote({ summary, reportUrl: "https://reports.example/run/index.html" });

    expect(result).toEqual({ status: "ok" });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${notesPath(1)}`,
      "POST https://gitlab.example.com/api/v4/projects/1/merge_requests/7/notes",
    ]);
    const body = requestBody(calls[1].body);
    expect(body).toMatch(
      new RegExp(`^${marker("100", "1000").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n# Allure Report Summary`),
    );
    expect(body).toContain("[View GitLab job](https://gitlab.example.com/group/project/-/jobs/1000)");
    expect(body).toContain("Tests \\| &lt;smoke&gt;");
    expect(body).toContain("[View](https://reports.example/run/index.html)");
    expect(body).not.toContain("env-token");
  });

  it("updates the newest owned note for an older logical run and keeps unrelated notes untouched", async () => {
    mockEnv(mergeRequestEnv());
    const { calls } = stubFetch((call) => {
      if (call.method === "GET") {
        return notesResponse([
          { id: 1, body: "<!-- allure -->\nlegacy publisher note" },
          { id: 2, body: noteBody("98", "980", "older") },
          { id: 3, body: noteBody("99", "990", "newest older") },
          { id: 4, body: noteBody("99", "991", "different job", "bGludA==") },
        ]);
      }

      if (
        call.method === "PUT" &&
        call.url === "https://gitlab.example.com/api/v4/projects/1/merge_requests/7/notes/3"
      ) {
        return jsonResponse({ id: 3, body: requestBody(call.body) });
      }

      return new Response("unexpected", { status: 500 });
    });

    const result = await upsertGitlabJobNote({ summary, reportUrl: "https://reports.example/run/index.html" });

    expect(result).toEqual({ status: "ok" });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${notesPath(1)}`,
      "PUT https://gitlab.example.com/api/v4/projects/1/merge_requests/7/notes/3",
    ]);
    expect(requestBody(calls[1].body)).toContain(marker("100", "1000"));
  });

  it("keeps the exact-job ownership identity stable across runs within the MR", async () => {
    mockEnv(mergeRequestEnv());
    const first = stubFetch((call) => {
      if (call.method === "GET") {
        return notesResponse([]);
      }

      return jsonResponse({ id: 10, body: requestBody(call.body) });
    });

    await upsertGitlabJobNote({ summary, reportUrl: "https://reports.example/first/index.html" });
    const firstBody = requestBody(first.calls[1].body);
    expect(firstBody).toContain("allure-gitlab-summary:v1:dGVzdHM=:100:1000");

    vi.unstubAllGlobals();
    mockEnv(mergeRequestEnv({ CI_PIPELINE_ID: "101", CI_JOB_ID: "1001" }));
    const second = stubFetch((call) => {
      if (call.method === "GET") {
        return notesResponse([{ id: 10, body: firstBody }]);
      }

      return jsonResponse({ id: 10, body: requestBody(call.body) });
    });

    await upsertGitlabJobNote({ summary, reportUrl: "https://reports.example/second/index.html" });
    const secondBody = requestBody(second.calls[1].body);
    expect(second.calls.map((call) => call.method)).toEqual(["GET", "PUT"]);
    expect(second.calls[1].url).toBe("https://gitlab.example.com/api/v4/projects/1/merge_requests/7/notes/10");
    expect(secondBody).toContain("allure-gitlab-summary:v1:dGVzdHM=:101:1001");
    expect([...secondBody.matchAll(/allure-gitlab-summary:v1:/g)]).toHaveLength(1);
  });

  it("creates a separate note when existing owned notes belong to a different exact job name", async () => {
    mockEnv(mergeRequestEnv());
    const { calls } = stubFetch((call) => {
      if (call.method === "GET") {
        return notesResponse([{ id: 1, body: noteBody("100", "1000", "lint body", "bGludA==") }]);
      }

      if (call.method === "POST") {
        return jsonResponse({ id: 2, body: requestBody(call.body) });
      }

      return new Response("unexpected", { status: 500 });
    });

    const result = await upsertGitlabJobNote({ summary, reportUrl: "https://reports.example/run/index.html" });

    expect(result).toEqual({ status: "ok" });
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(requestBody(calls[1].body)).toContain("allure-gitlab-summary:v1:dGVzdHM=:100:1000");
  });

  it("warns and omits the job link when CI_JOB_URL is missing instead of reconstructing it", async () => {
    const warn = vi.fn();
    mockEnv(mergeRequestEnv({ CI_JOB_URL: "" }));
    const { calls } = stubFetch((call) => (call.method === "GET" ? notesResponse([]) : jsonResponse({ id: 10 })));

    const result = await upsertGitlabJobNote({ summary, reportUrl: "https://reports.example/run/index.html", warn });

    expect(result).toEqual({ status: "ok" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("CI_JOB_URL"));
    const body = requestBody(calls[1].body);
    expect(body).not.toContain("View GitLab job");
    expect(body).not.toContain("/-/jobs/");
    expect(body).toContain("[View](https://reports.example/run/index.html)");
  });

  it("encodes marker delimiters, newlines and Unicode in job names without losing rolling ownership", async () => {
    mockEnv(mergeRequestEnv({ CI_JOB_NAME: "tests: -->\n/close 🧪" }));
    const first = stubFetch((call) => (call.method === "GET" ? notesResponse([]) : jsonResponse({ id: 10 })));
    await upsertGitlabJobNote({ summary, reportUrl: "https://reports.example/first/index.html" });
    const body = requestBody(first.calls[1].body);
    expect(body.split("\n")[0]).toBe("<!-- allure-gitlab-summary:v1:dGVzdHM6IC0tPgovY2xvc2Ug8J+nqg==:100:1000 -->");
    expect(body).not.toContain("\n/close");

    mockEnv(mergeRequestEnv({ CI_JOB_NAME: "tests: -->\n/close 🧪", CI_JOB_ID: "1001" }));
    const second = stubFetch((call) =>
      call.method === "GET" ? notesResponse([{ id: 10, body }]) : jsonResponse({ id: 10 }),
    );
    const result = await upsertGitlabJobNote({ summary, reportUrl: "https://reports.example/retry/index.html" });

    expect(result).toEqual({ status: "ok" });
    expect(second.calls.map((call) => call.method)).toEqual(["GET", "PUT"]);
    expect(second.calls[1].url).toBe("https://gitlab.example.com/api/v4/projects/1/merge_requests/7/notes/10");
  });

  it("does not adopt malformed markers or markers with an unsupported version", async () => {
    mockEnv(mergeRequestEnv());
    const { calls } = stubFetch((call) =>
      call.method === "GET"
        ? notesResponse([
            { id: 1, body: "<!-- allure-gitlab-summary:v0:dGVzdHM=:99:990 -->\nold version" },
            { id: 2, body: "<!-- allure-gitlab-summary:v1:dGVzdHM=:bad:990 -->\ninvalid ID" },
            { id: 3, body: "<!-- allure-gitlab-summary:v1:dGVzdHM=!:99:990 -->\ninvalid name" },
            { id: 4, body: "text\n<!-- allure-gitlab-summary:v1:dGVzdHM=:99:990 -->\nembedded marker" },
          ])
        : jsonResponse({ id: 10 }),
    );

    const result = await upsertGitlabJobNote({ summary, reportUrl: "https://reports.example/run/index.html" });

    expect(result).toEqual({ status: "ok" });
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
  });

  it("updates an owned note idempotently for the same pipeline and job IDs", async () => {
    mockEnv(mergeRequestEnv());
    const { calls } = stubFetch((call) =>
      call.method === "GET"
        ? notesResponse([{ id: 5, body: noteBody("100", "1000", "same run") }])
        : jsonResponse({ id: 5, body: requestBody(call.body) }),
    );

    const result = await upsertGitlabJobNote({ summary, reportUrl: "https://reports.example/run/index.html" });

    expect(result).toEqual({ status: "ok" });
    expect(calls.map((call) => call.method)).toEqual(["GET", "PUT"]);
    expect(calls[1].url).toBe("https://gitlab.example.com/api/v4/projects/1/merge_requests/7/notes/5");
  });

  it.each([
    ["newer pipeline", noteBody("101", "900")],
    ["newer retry in the same pipeline", noteBody("100", "1001")],
  ])("skips without writing over a %s note", async (_name, existingBody) => {
    const warn = vi.fn();
    mockEnv(mergeRequestEnv());
    const { calls } = stubFetch((call) =>
      call.method === "GET" ? notesResponse([{ id: 5, body: existingBody }]) : jsonResponse({ ok: true }),
    );

    const result = await upsertGitlabJobNote({ summary, reportUrl: "https://reports.example/run/index.html", warn });

    expect(result).toEqual({ status: "skipped", reason: "newer owned note exists" });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("newer owned note exists"));
  });

  it("follows complete note pagination and updates a note found on a later page", async () => {
    mockEnv(mergeRequestEnv());
    const unrelated = Array.from({ length: 100 }, (_value, index) => ({ id: index + 1, body: `unrelated ${index}` }));
    const { calls } = stubFetch((call) => {
      if (call.method === "GET" && call.url === notesPath(1)) {
        return notesResponse(unrelated, "2");
      }

      if (call.method === "GET" && call.url === notesPath(2)) {
        return notesResponse([{ id: 200, body: noteBody("99", "990") }]);
      }

      return jsonResponse({ id: 200, body: requestBody(call.body) });
    });

    const result = await upsertGitlabJobNote({ summary, reportUrl: "https://reports.example/run/index.html" });

    expect(result).toEqual({ status: "ok" });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${notesPath(1)}`,
      `GET ${notesPath(2)}`,
      "PUT https://gitlab.example.com/api/v4/projects/1/merge_requests/7/notes/200",
    ]);
  });

  it("skips instead of creating a duplicate when the note scan is incomplete after five pages", async () => {
    const warn = vi.fn();
    mockEnv(mergeRequestEnv());
    const { calls } = stubFetch((call) => {
      if (call.method === "GET") {
        const page = Number(new URL(call.url).searchParams.get("page"));

        return notesResponse([], page === 5 ? "6" : String(page + 1));
      }

      return jsonResponse({ ok: true });
    });

    const result = await upsertGitlabJobNote({ summary, reportUrl: "https://reports.example/run/index.html", warn });

    expect(result).toEqual({ status: "skipped", reason: "incomplete note scan" });
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "GET", "GET", "GET"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("incomplete note scan"));
  });

  it("skips instead of creating a duplicate when a full note page omits pagination metadata", async () => {
    const warn = vi.fn();
    mockEnv(mergeRequestEnv());
    const fullPage = Array.from({ length: 100 }, (_value, index) => ({ id: index + 1, body: `unrelated ${index}` }));
    const { calls } = stubFetch((call) =>
      call.method === "GET" ? jsonResponse(fullPage) : jsonResponse({ ok: true }),
    );

    const result = await upsertGitlabJobNote({ summary, reportUrl: "https://reports.example/run/index.html", warn });

    expect(result).toEqual({ status: "skipped", reason: "incomplete note scan" });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("incomplete note scan"));
  });

  it("skips instead of writing when pagination jumps over an unscanned page", async () => {
    const warn = vi.fn();
    mockEnv(mergeRequestEnv());
    const { calls } = stubFetch((call) => {
      if (call.method === "GET") {
        return notesResponse([], "3");
      }

      return jsonResponse({ ok: true });
    });

    const result = await upsertGitlabJobNote({ summary, reportUrl: "https://reports.example/run/index.html", warn });

    expect(result).toEqual({ status: "skipped", reason: "incomplete note scan" });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("incomplete note scan"));
  });

  it("skips cross-project merge requests before network I/O", async () => {
    const warn = vi.fn();
    mockEnv(mergeRequestEnv({ CI_MERGE_REQUEST_PROJECT_ID: "2" }));
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));

    const result = await upsertGitlabJobNote({ summary, reportUrl: "https://reports.example/run/index.html", warn });

    expect(result).toEqual({ status: "skipped", reason: "cross-project merge request" });
    expect(calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cross-project merge request"));
  });

  it.each([
    ["missing merge request", { CI_MERGE_REQUEST_IID: "" }, "missing merge request"],
    ["missing credentials", { GITLAB_TOKEN: "" }, "gitlab unavailable"],
  ])("skips before note writes for %s", async (_name, overrides, reason) => {
    const warn = vi.fn();
    mockEnv(mergeRequestEnv(overrides));
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));

    const result = await upsertGitlabJobNote({ summary, reportUrl: "https://reports.example/run/index.html", warn });

    expect(result).toEqual({ status: "skipped", reason });
    expect(calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed note payloads without writing", async () => {
    const warn = vi.fn();
    mockEnv(mergeRequestEnv());
    const { calls } = stubFetch((call) =>
      call.method === "GET" ? notesResponse([{ id: 1, body: 2 }]) : jsonResponse({ ok: true }),
    );

    const result = await upsertGitlabJobNote({ summary, reportUrl: "https://reports.example/run/index.html", warn });

    expect(result).toEqual({ status: "skipped", reason: "invalid notes response" });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid notes response"));
  });

  it.each([
    ["lookup", "GET", "note lookup failed"],
    ["create", "POST", "note write failed"],
    ["update", "PUT", "note write failed"],
  ])("treats %s HTTP failures as best effort", async (_name, failingMethod, reason) => {
    const warn = vi.fn();
    mockEnv(mergeRequestEnv());
    const { calls } = stubFetch((call) => {
      if (call.method === failingMethod) {
        return new Response("fail", { status: 500 });
      }

      if (call.method === "GET") {
        return notesResponse(failingMethod === "PUT" ? [{ id: 9, body: noteBody("99", "990") }] : []);
      }

      return jsonResponse({ ok: true });
    });

    const result = await upsertGitlabJobNote({ summary, reportUrl: "https://reports.example/run/index.html", warn });

    expect(result).toEqual({ status: "skipped", reason });
    expect(calls.some((call) => call.method === failingMethod)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(reason));
  });

  it("skips oversized comments before scanning notes", async () => {
    const warn = vi.fn();
    mockEnv(mergeRequestEnv());
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));

    const result = await upsertGitlabJobNote({
      summary: { ...summary, name: "x".repeat(60_001) },
      reportUrl: "https://reports.example/run/index.html",
      warn,
    });

    expect(result).toEqual({ status: "skipped", reason: "comment too large" });
    expect(calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("comment too large"));
  });
});
