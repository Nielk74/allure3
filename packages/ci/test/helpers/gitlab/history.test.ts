import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { story } from "allure-js-commons";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { restoreGitlabHistory } from "../../../src/helpers/gitlab/history.js";
import { gitlabEnv, jsonResponse, mockEnv, removeDir, stubFetch, tempGitlabDir } from "./test-utils.js";

vi.mock("../../../src/utils.js", () => ({
  getEnv: vi.fn(),
}));

const createStalledResponse = (signal?: AbortSignal | null) => {
  let fail!: (error: unknown) => void;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        fail = (error) => controller.error(error);
        signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      },
    }),
    { status: 200 },
  );

  return { response, fail };
};

const previousGitlabJobQuery = `query PreviousGitlabJob($path: ID!, $ref: String!, $source: String!, $job: String!) {
  project(fullPath: $path) {
    pipelines(ref: $ref, source: $source, first: 100) {
      nodes { id source job(name: $job) { id name status retried } }
    }
  }
}`;

const pipelines = [
  { id: "gid://gitlab/Ci::Pipeline/102", source: "push", job: null },
  { id: "gid://gitlab/Ci::Pipeline/100", source: "push", job: null },
  { id: "gid://gitlab/Ci::Pipeline/99", source: "push", job: null },
  {
    id: "gid://gitlab/Ci::Pipeline/98",
    source: "push",
    job: { id: "gid://gitlab/Ci::Build/980", name: "tests", status: "FAILED", retried: false },
  },
  {
    id: "gid://gitlab/Ci::Pipeline/97",
    source: "push",
    job: { id: "gid://gitlab/Ci::Build/970", name: "tests", status: "SUCCESS", retried: false },
  },
];

let tempDir: string | undefined;

beforeEach(async () => {
  await story("gitlab history");
  vi.restoreAllMocks();
  tempDir = await tempGitlabDir();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (tempDir) {
    await removeDir(tempDir);
  }
});

describe("restoreGitlabHistory", () => {
  it("downloads opaque history bytes from the first eligible older job in one GraphQL window", async () => {
    const historyPath = join(tempDir!, "history.jsonl");
    mockEnv(gitlabEnv({ CI_PROJECT_DIR: tempDir! }));
    const { calls } = stubFetch((call) => {
      if (call.method === "POST" && call.url === "https://gitlab.example.com/api/graphql") {
        return jsonResponse({ data: { project: { pipelines: { nodes: pipelines } } } });
      }

      if (
        call.method === "GET" &&
        call.url === "https://gitlab.example.com/api/v4/projects/1/jobs/980/artifacts/history.jsonl"
      ) {
        return new Response("not-json\n", { status: 200 });
      }

      return new Response("unexpected", { status: 500 });
    });

    const result = await restoreGitlabHistory({ historyPath });

    expect(result).toEqual({ status: "ok" });
    expect(await readFile(historyPath, "utf8")).toBe("not-json\n");
    const graphqlCalls = calls.filter((call) => call.method === "POST");
    expect(graphqlCalls).toHaveLength(1);
    expect(JSON.parse(graphqlCalls[0].body!)).toEqual({
      query: previousGitlabJobQuery,
      variables: { path: "group/project", ref: "feature/a", source: "push", job: "tests" },
    });
    expect(graphqlCalls[0].body).not.toContain("after");
    const artifactCalls = calls.filter((call) => call.method === "GET");
    expect(artifactCalls.map((call) => call.url)).toEqual([
      "https://gitlab.example.com/api/v4/projects/1/jobs/980/artifacts/history.jsonl",
    ]);
  });

  it("aborts a prompt selected artifact response whose body stalls without trying fallback artifacts", async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(10));
    const historyPath = join(tempDir!, "history.jsonl");
    await writeFile(historyPath, "existing\n");
    mockEnv(gitlabEnv({ CI_PROJECT_DIR: tempDir! }));
    let stalled: ReturnType<typeof createStalledResponse> | undefined;
    const { calls } = stubFetch((call) => {
      if (call.method === "POST") {
        return jsonResponse({ data: { project: { pipelines: { nodes: pipelines } } } });
      }

      if (call.url.endsWith("/jobs/980/artifacts/history.jsonl")) {
        stalled = createStalledResponse(call.signal);

        return stalled.response;
      }

      return new Response("fallback must not be requested", { status: 500 });
    });
    const restore = restoreGitlabHistory({ historyPath });
    try {
      await expect(restore).resolves.toEqual({ status: "skipped", reason: "artifact download failed" });
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(await readFile(historyPath, "utf8")).toBe("existing\n");
      expect(calls.filter((call) => call.method === "GET").map((call) => call.url)).toEqual([
        "https://gitlab.example.com/api/v4/projects/1/jobs/980/artifacts/history.jsonl",
      ]);
      expect(calls.find((call) => call.method === "GET")?.signal?.aborted).toBe(true);
      expect(calls.some((call) => call.url.includes("/jobs/970/"))).toBe(false);
    } finally {
      stalled?.fail(new Error("test cleanup"));
      await restore.catch(() => undefined);
    }
  });

  it.each([
    ["404", new Response("missing", { status: 404 }), "artifact download failed"],
    ["zero-byte body", new Response(new Uint8Array(), { status: 200 }), "empty history artifact"],
  ])("leaves existing bytes untouched when the selected artifact has %s", async (_name, response, reason) => {
    const historyPath = join(tempDir!, "history.jsonl");
    await writeFile(historyPath, "existing\n");
    mockEnv(gitlabEnv({ CI_PROJECT_DIR: tempDir! }));
    const { calls } = stubFetch((call) => {
      if (call.method === "POST") {
        return jsonResponse({ data: { project: { pipelines: { nodes: pipelines } } } });
      }

      if (call.url.endsWith("/jobs/980/artifacts/history.jsonl")) {
        return response;
      }

      return new Response("fallback must not be requested", { status: 500 });
    });

    const result = await restoreGitlabHistory({ historyPath });

    expect(result).toEqual({ status: "skipped", reason });
    expect(await readFile(historyPath, "utf8")).toBe("existing\n");
    expect(calls.filter((call) => call.method === "GET").map((call) => call.url)).toEqual([
      "https://gitlab.example.com/api/v4/projects/1/jobs/980/artifacts/history.jsonl",
    ]);
    expect(calls.some((call) => call.url.includes("/jobs/970/"))).toBe(false);
  });

  it("rejects HTTPS-to-HTTP artifact redirects without fetching the downgraded destination or fallback artifacts", async () => {
    const historyPath = join(tempDir!, "history.jsonl");
    await writeFile(historyPath, "existing\n");
    const warn = vi.fn();
    mockEnv(gitlabEnv({ CI_PROJECT_DIR: tempDir! }));
    const { calls } = stubFetch((call) => {
      if (call.method === "POST") {
        return jsonResponse({ data: { project: { pipelines: { nodes: pipelines } } } });
      }

      if (call.url.endsWith("/jobs/980/artifacts/history.jsonl")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://storage.example.test/history.jsonl" },
        });
      }

      return new Response("downgraded history must not be requested\n", { status: 200 });
    });

    const result = await restoreGitlabHistory({ historyPath, warn });

    expect(result).toEqual({ status: "skipped", reason: "artifact download failed" });
    expect(await readFile(historyPath, "utf8")).toBe("existing\n");
    expect(calls.filter((call) => call.method === "GET").map((call) => call.url)).toEqual([
      "https://gitlab.example.com/api/v4/projects/1/jobs/980/artifacts/history.jsonl",
    ]);
    expect(calls.some((call) => call.url.includes("/jobs/970/"))).toBe(false);
    expect(warn).toHaveBeenCalledWith("GitLab history restore skipped: artifact download failed");
  });

  it.each([
    [
      "source mismatch",
      [{ id: "gid://gitlab/Ci::Pipeline/99", source: "web", job: null }],
      "invalid discovery response",
    ],
    [
      "running job status",
      [
        {
          id: "gid://gitlab/Ci::Pipeline/99",
          source: "push",
          job: { id: "gid://gitlab/Ci::Build/990", name: "tests", status: "RUNNING", retried: false },
        },
      ],
      "no matching prior job in returned pipeline window",
    ],
    [
      "retried job",
      [
        {
          id: "gid://gitlab/Ci::Pipeline/99",
          source: "push",
          job: { id: "gid://gitlab/Ci::Build/990", name: "tests", status: "SUCCESS", retried: true },
        },
      ],
      "no matching prior job in returned pipeline window",
    ],
    [
      "wrong job name",
      [
        {
          id: "gid://gitlab/Ci::Pipeline/99",
          source: "push",
          job: { id: "gid://gitlab/Ci::Build/990", name: "lint", status: "SUCCESS", retried: false },
        },
      ],
      "no matching prior job in returned pipeline window",
    ],
    [
      "all current or newer",
      [
        {
          id: "gid://gitlab/Ci::Pipeline/101",
          source: "push",
          job: { id: "gid://gitlab/Ci::Build/1010", name: "tests", status: "SUCCESS", retried: false },
        },
        {
          id: "gid://gitlab/Ci::Pipeline/100",
          source: "push",
          job: { id: "gid://gitlab/Ci::Build/1000", name: "tests", status: "SUCCESS", retried: false },
        },
      ],
      "no matching prior job in returned pipeline window",
    ],
    [
      "job absent throughout window",
      [{ id: "gid://gitlab/Ci::Pipeline/99", source: "push", job: null }],
      "no matching prior job in returned pipeline window",
    ],
    [
      "ascending pipeline IDs",
      [
        { id: "gid://gitlab/Ci::Pipeline/98", source: "push", job: null },
        { id: "gid://gitlab/Ci::Pipeline/99", source: "push", job: null },
      ],
      "invalid discovery response",
    ],
  ])("skips without an artifact request for %s", async (_name, nodes, reason) => {
    const historyPath = join(tempDir!, "history.jsonl");
    mockEnv(gitlabEnv({ CI_PROJECT_DIR: tempDir! }));
    const { calls } = stubFetch((call) => {
      if (call.method === "POST") {
        return jsonResponse({ data: { project: { pipelines: { nodes } } } });
      }

      return new Response("must not request artifacts", { status: 500 });
    });

    const result = await restoreGitlabHistory({ historyPath });

    expect(result).toEqual({ status: "skipped", reason });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["null project", { data: { project: null } }],
    ["GraphQL errors", { errors: [{ message: "nope" }], data: { project: { pipelines: { nodes: [] } } } }],
  ])("skips ambiguous discovery response with %s", async (_name, body) => {
    const historyPath = join(tempDir!, "history.jsonl");
    mockEnv(gitlabEnv({ CI_PROJECT_DIR: tempDir! }));
    const { calls } = stubFetch((call) =>
      call.method === "POST" ? jsonResponse(body) : new Response("", { status: 500 }),
    );

    const result = await restoreGitlabHistory({ historyPath });

    expect(result.status).toBe("skipped");
    expect(calls).toHaveLength(1);
  });

  it("uses BigInt-safe typed IDs and preserves descending ordering", async () => {
    const historyPath = join(tempDir!, "history.jsonl");
    mockEnv(
      gitlabEnv({
        CI_PROJECT_DIR: tempDir!,
        CI_PIPELINE_ID: "9007199254740993",
      }),
    );
    const { calls } = stubFetch((call) => {
      if (call.method === "POST") {
        return jsonResponse({
          data: {
            project: {
              pipelines: {
                nodes: [
                  {
                    id: "gid://gitlab/Ci::Pipeline/9007199254740994",
                    source: "push",
                    job: {
                      id: "gid://gitlab/Ci::Build/90071992547409940",
                      name: "tests",
                      status: "SUCCESS",
                      retried: false,
                    },
                  },
                  {
                    id: "gid://gitlab/Ci::Pipeline/9007199254740992",
                    source: "push",
                    job: {
                      id: "gid://gitlab/Ci::Build/90071992547409920",
                      name: "tests",
                      status: "SUCCESS",
                      retried: null,
                    },
                  },
                ],
              },
            },
          },
        });
      }

      return new Response("large-id\n", { status: 200 });
    });

    const result = await restoreGitlabHistory({ historyPath });

    expect(result).toEqual({ status: "ok" });
    expect(calls.filter((call) => call.method === "GET").map((call) => call.url)).toEqual([
      "https://gitlab.example.com/api/v4/projects/1/jobs/90071992547409920/artifacts/history.jsonl",
    ]);
  });

  it("encodes endpoint prefixes and project-relative artifact path segments", async () => {
    const historyPath = join(tempDir!, "out", "history files", "history #1.jsonl");
    await mkdir(join(tempDir!, "out", "history files"), { recursive: true });
    mockEnv(
      gitlabEnv({
        CI_PROJECT_DIR: tempDir!,
        CI_SERVER_URL: "https://gitlab.example.com/gitlab",
      }),
    );
    const { calls } = stubFetch((call) => {
      if (call.method === "POST") {
        return jsonResponse({ data: { project: { pipelines: { nodes: pipelines } } } });
      }

      return new Response("prefixed\n", { status: 200 });
    });

    const result = await restoreGitlabHistory({ historyPath });

    expect(result).toEqual({ status: "ok" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://gitlab.example.com/gitlab/api/graphql",
      "https://gitlab.example.com/gitlab/api/v4/projects/1/jobs/980/artifacts/out/history%20files/history%20%231.jsonl",
    ]);
  });

  it.each([
    ["missing token", { GITLAB_TOKEN: "" }],
    ["outside GitLab CI", { GITLAB_CI: "", GITLAB_TOKEN: "env-token" }],
  ])("skips before network I/O for %s", async (_name, overrides) => {
    const warn = vi.fn();
    mockEnv(gitlabEnv({ CI_PROJECT_DIR: tempDir!, ...overrides }));
    const { calls } = stubFetch(() => new Response("must not fetch", { status: 500 }));

    const result = await restoreGitlabHistory({ historyPath: join(tempDir!, "history.jsonl"), warn });

    expect(result.status).toBe("skipped");
    expect(calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).not.toContain("env-token");
  });
});
