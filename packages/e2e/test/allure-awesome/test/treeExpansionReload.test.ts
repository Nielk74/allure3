import { expect, test } from "@playwright/test";
import { epic, feature, label, Stage, Status, story } from "allure-js-commons";

import { type ReportBootstrap, bootstrapReport } from "../utils/index.js";

const externalReportUrl = process.env.ALLURE_RELOAD_REPORT_URL;
const groupLabels = ["level1", "level2", "level3", "level4", "level5"];
const groupValues = [
  "Performance benchmark",
  "Layer 2",
  "Sibling 001",
  "Sibling 001 / Layer 4",
  "Sibling 001 / Layer 5",
];

let bootstrap: ReportBootstrap | undefined;

test.beforeAll(async () => {
  if (externalReportUrl) {
    return;
  }

  bootstrap = await bootstrapReport(
    {
      reportConfig: {
        name: "Tree expansion reload",
        appendHistory: false,
        knownIssuesPath: undefined,
      },
      testResults: [
        {
          name: "failed result",
          fullName: "reload.test.js#failed result",
          status: Status.FAILED,
          stage: Stage.FINISHED,
          labels: groupLabels.map((name, index) => ({ name, value: groupValues[index]! })),
        },
        {
          name: "broken result",
          fullName: "reload.test.js#broken result",
          status: Status.BROKEN,
          stage: Stage.FINISHED,
          labels: groupLabels.map((name, index) => ({ name, value: groupValues[index]! })),
        },
      ],
    },
    { groupBy: groupLabels },
  );
});

test.afterAll(async () => {
  await bootstrap?.shutdown?.();
});

test("expanded failed and broken folder paths collapse after reload", async ({ browserName, page }) => {
  await label("env", browserName);
  await epic("coverage");
  await feature("ui-state");
  await story("treeExpansion");
  await label("coverage", "ui-state");

  await page.goto(externalReportUrl ?? bootstrap!.url);

  const sectionTitles = page.getByTestId("tree-section-title");
  const leaves = page.getByTestId("tree-leaf");

  await expect(sectionTitles).toHaveCount(1);
  await expect(sectionTitles).toHaveText(groupValues[0]!);
  await expect(leaves).toHaveCount(0);

  for (const title of groupValues) {
    await page.getByTestId("tree-section-title").filter({ hasText: title }).first().click();
  }

  await expect(leaves.first()).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("expandedTrees"))).toBeNull();

  await page.reload();

  await expect(sectionTitles).toHaveCount(1);
  await expect(sectionTitles).toHaveText(groupValues[0]!);
  await expect(leaves).toHaveCount(0);
});
