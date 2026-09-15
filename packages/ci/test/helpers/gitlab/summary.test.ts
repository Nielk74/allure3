import { story } from "allure-js-commons";
import { beforeEach, describe, expect, it } from "vitest";

import { formatGitlabSummary } from "../../../src/helpers/gitlab/summary.js";
import type { GitlabReportSummary } from "../../../src/helpers/gitlab/types.js";

const summary: GitlabReportSummary = {
  name: "Tests | <smoke>",
  duration: 1000,
  stats: { total: 9, passed: 4, failed: 1, broken: 2, skipped: 1, unknown: 1 },
  newTests: 2,
  flakyTests: 1,
  retryTests: 3,
};

beforeEach(async () => {
  await story("gitlab summary");
});

describe("formatGitlabSummary", () => {
  it("renders the action-aligned aggregate table with escaped values and readable status cells", () => {
    const body = formatGitlabSummary(summary, { reportUrl: "https://reports.example/run/index.html" });

    expect(body).toContain("# Allure Report Summary");
    expect(body).toContain("| Name | Duration |");
    expect(body).toContain("| New | Flaky | Retry | Report |");
    expect(body).toContain("1s 0ms");
    expect(body).not.toContain("<smoke>");
    expect(body).toContain("Tests \\| &lt;smoke&gt;");
    expect(body).toContain("Passed 4");
    expect(body).toContain("Failed 1");
    expect(body).toContain("Broken 2");
    expect(body).toContain("Skipped 1");
    expect(body).toContain("Unknown 1");
    expect(body).toContain("| 2 | 1 | 3 | [View](https://reports.example/run/index.html) |");
    expect(body).toMatchInlineSnapshot(`
      "# Allure Report Summary

      |  | Name | Duration | Stats | New | Flaky | Retry | Report |
      | --- | --- | --- | --- | --- | --- | --- | --- |
      | ![Status chart](https://allurecharts.qameta.workers.dev/pie?passed=4&failed=1&broken=2&skipped=1&unknown=1) | Tests \\| &lt;smoke&gt; | 1s 0ms | ![Passed](https://allurecharts.qameta.workers.dev/dot?status=passed) Passed 4<br/>![Failed](https://allurecharts.qameta.workers.dev/dot?status=failed) Failed 1<br/>![Broken](https://allurecharts.qameta.workers.dev/dot?status=broken) Broken 2<br/>![Skipped](https://allurecharts.qameta.workers.dev/dot?status=skipped) Skipped 1<br/>![Unknown](https://allurecharts.qameta.workers.dev/dot?status=unknown) Unknown 1 | 2 | 1 | 3 | [View](https://reports.example/run/index.html) |"
    `);
  });

  it("renders a neutral zero-test row without positive status claims", () => {
    const body = formatGitlabSummary(
      {
        name: "empty",
        duration: 0,
        stats: { total: 0, passed: 0, failed: 0, broken: 0, skipped: 0, unknown: 0 },
        newTests: 0,
        flakyTests: 0,
        retryTests: 0,
      },
      { reportUrl: "https://reports.example/empty/index.html", jobUrl: "https://gitlab.example/job/1" },
    );

    expect(body).toContain("[View GitLab job](https://gitlab.example/job/1)");
    expect(body).toContain(
      "| ![Status chart](https://allurecharts.qameta.workers.dev/pie?passed=0&failed=0&broken=0&skipped=0&unknown=0) | empty | 0s |  | 0 | 0 | 0 | [View](https://reports.example/empty/index.html) |",
    );
    expect(body).not.toContain("Passed 0");
  });

  it("escapes malicious table text, HTML, line breaks, hidden markers, and quick-action lines", () => {
    const body = formatGitlabSummary(
      {
        ...summary,
        name: "bad | <b>x</b>\n/merge\n<!-- allure-gitlab-summary:v1:bad:1:1 -->",
      },
      { reportUrl: "https://reports.example/run/index.html" },
    );

    expect(body).toContain(
      "bad \\| &lt;b&gt;x&lt;/b&gt; /merge &lt;\\!\\-\\- allure\\-gitlab\\-summary:v1:bad:1:1 \\-\\-&gt;",
    );
    expect(body).not.toContain("<b>");
    expect(body).not.toContain("\n/merge");
    expect(body).not.toContain("<!-- allure-gitlab-summary:v1:bad:1:1 -->");
  });

  it("renders Markdown injection attempts as literal table text", () => {
    const body = formatGitlabSummary(
      {
        ...summary,
        name: String.raw`![preview](https://attacker.example/image) [open](https://attacker.example) \| \\pipe\`code\``,
      },
      { reportUrl: "https://reports.example/run/index.html" },
    );

    expect(body).not.toContain("![preview]");
    expect(body).not.toContain("[open](https://attacker.example)");
    expect(body).not.toContain(String.raw`\| \pipe`);
    expect(body).toContain(
      String.raw`\!\[preview\]\(https://attacker\.example/image\) \[open\]\(https://attacker\.example\) \\\| \\\\pipe\\\`code\\\``,
    );
  });

  it("serializes valid report and job URLs safely for Markdown table links", () => {
    const body = formatGitlabSummary(summary, {
      reportUrl: "https://reports.example/run|branch/(1)/index.html",
      jobUrl: "https://gitlab.example/group/project/-/jobs/(1000)",
    });

    expect(body).toContain("[View](https://reports.example/run%7Cbranch/%281%29/index.html)");
    expect(body).toContain("[View GitLab job](https://gitlab.example/group/project/-/jobs/%281000%29)");
    expect(body).not.toContain("run|branch");
    expect(body).not.toContain("/(1)/");
    expect(body).not.toContain("/(1000)");
  });

  it("rejects a missing report URL before a note can be posted", () => {
    expect(() => formatGitlabSummary(summary, { reportUrl: "" })).toThrow("missing report URL");
  });

  it("keeps remote chart URLs limited to numeric counters and known status identifiers", () => {
    const body = formatGitlabSummary(
      {
        ...summary,
        name: "secret group/project token report https://reports.example/run/index.html",
      },
      { reportUrl: "https://reports.example/run/index.html" },
    );
    const chartUrls = [...body.matchAll(/https:\/\/allurecharts\.qameta\.workers\.dev\/[^)\s]+/g)].map(([url]) => url);

    expect(chartUrls).toHaveLength(6);
    expect(chartUrls).toEqual([
      "https://allurecharts.qameta.workers.dev/pie?passed=4&failed=1&broken=2&skipped=1&unknown=1",
      "https://allurecharts.qameta.workers.dev/dot?status=passed",
      "https://allurecharts.qameta.workers.dev/dot?status=failed",
      "https://allurecharts.qameta.workers.dev/dot?status=broken",
      "https://allurecharts.qameta.workers.dev/dot?status=skipped",
      "https://allurecharts.qameta.workers.dev/dot?status=unknown",
    ]);
    for (const url of chartUrls) {
      expect(url).not.toContain("secret");
      expect(url).not.toContain("group");
      expect(url).not.toContain("token");
      expect(url).not.toContain("reports.example");
    }
  });
});
