import { story } from "allure-js-commons";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGitlabClient } from "../../../src/helpers/gitlab/client.js";
import { gitlabEnv, jsonResponse, mockEnv, stubFetch } from "./test-utils.js";

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
    { status: 200, headers: { "content-type": "application/json" } },
  );

  return { response, fail };
};

beforeEach(async () => {
  await story("gitlab client");
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createGitlabClient", () => {
  it("uses an explicit token before GITLAB_TOKEN without serializing it into CI metadata", async () => {
    mockEnv(gitlabEnv({ GITLAB_TOKEN: "env-secret" }));
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));

    const client = createGitlabClient({ token: "explicit-secret" })!;
    const result = await client.requestJson("GET", "/projects/1");

    expect(result.data).toEqual({ ok: true });
    expect(calls[0].headers["private-token"]).toBe("explicit-secret");
    expect(JSON.stringify(client.ci)).not.toContain("explicit-secret");
    expect(JSON.stringify(client.ci)).not.toContain("env-secret");
  });

  it("reads GITLAB_TOKEN at client creation time when the explicit token is blank", async () => {
    mockEnv(gitlabEnv({ GITLAB_TOKEN: " env-secret " }));
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));

    const client = createGitlabClient({ token: " " });
    expect(client).toBeDefined();
    await client!.requestJson("GET", "/projects/1");
    mockEnv(gitlabEnv({ GITLAB_TOKEN: "new-secret" }));
    await createGitlabClient()!.requestJson("GET", "/projects/1");

    expect(calls.map((call) => call.headers["private-token"])).toEqual(["env-secret", "new-secret"]);
  });

  it("does not use the former custom token variables", () => {
    mockEnv(gitlabEnv({ GITLAB_TOKEN: "", ALLURE_GITLAB_TOKEN: "old-token", GITLAB_AUTH_TOKEN: "old-fallback" }));
    const warn = vi.fn();
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));

    expect(createGitlabClient({ warn })).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("missing token"));
  });

  it("strips private-token when an artifact redirect crosses origins", async () => {
    mockEnv(gitlabEnv());
    const { calls } = stubFetch((call) => {
      if (call.url === "https://gitlab.example.com/api/v4/projects/1/jobs/99/artifacts/history.jsonl") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.net/object/history.jsonl" },
        });
      }

      return new Response("history\n", { status: 200 });
    });

    const client = createGitlabClient()!;
    const bytes = await client.downloadArtifact("99", "history.jsonl");

    expect(new TextDecoder().decode(bytes)).toBe("history\n");
    expect(calls).toHaveLength(2);
    expect(calls[0].headers["private-token"]).toBe("env-token");
    expect(calls[1].url).toBe("https://cdn.example.net/object/history.jsonl");
    expect(calls[1].headers["private-token"]).toBeUndefined();
  });

  it("bounds artifact redirects", async () => {
    mockEnv(gitlabEnv());
    const { calls } = stubFetch(() => {
      const next = calls.length + 1;

      return new Response(null, {
        status: 302,
        headers: { location: `https://gitlab.example.com/api/v4/redirect-${next}` },
      });
    });

    const client = createGitlabClient()!;

    await expect(client.downloadArtifact("99", "history.jsonl")).rejects.toThrow("too many redirects");
    expect(calls).toHaveLength(6);
  });

  it("keeps the request timeout active while reading a prompt GraphQL JSON response body", async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(10));
    mockEnv(gitlabEnv());
    let stalled: ReturnType<typeof createStalledResponse> | undefined;
    const { calls } = stubFetch((call) => {
      stalled = createStalledResponse(call.signal);

      return stalled.response;
    });
    const client = createGitlabClient()!;
    const query = client.query("query Timeout { project { id } }", {});
    try {
      await expect(query).rejects.toThrow("GitLab response was not valid JSON");
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(calls).toHaveLength(1);
      expect(calls[0].signal?.aborted).toBe(true);
    } finally {
      stalled?.fail(new Error("test cleanup"));
      await query.catch(() => undefined);
    }
  });

  it("rejects non-decimal GitLab identity strings before network I/O", () => {
    const warn = vi.fn();
    mockEnv(gitlabEnv({ CI_PROJECT_ID: "project-1" }));
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));

    const client = createGitlabClient({ warn });

    expect(client).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid numeric metadata"));
  });

  it("rejects malformed REST API roots before network I/O", () => {
    const warn = vi.fn();
    mockEnv(gitlabEnv({ CI_API_V4_URL: "https://gitlab.example.com/custom" }));
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));

    const client = createGitlabClient({ warn });

    expect(client).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid API endpoint"));
  });

  it("rejects mismatched REST and GraphQL API origins before network I/O", () => {
    const warn = vi.fn();
    mockEnv(
      gitlabEnv({
        CI_API_V4_URL: "https://gitlab.example.com/api/v4",
        CI_API_GRAPHQL_URL: "https://evil.example.com/api/graphql",
      }),
    );
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));

    const client = createGitlabClient({ warn });

    expect(client).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("GitLab integration skipped"));
  });
});
