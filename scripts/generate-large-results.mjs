import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const count = Number.parseInt(process.argv[2] ?? "20000", 10);
const output = resolve(process.argv[3] ?? "bench/allure-results-20000");
const scenario = process.argv[4] ?? "single-branch";
const statusProfile = process.argv[5] ?? "mixed";
const supportedScenarios = new Set(["single-branch", "deep-5", "wide-100", "deep-5-wide-100"]);
const supportedStatusProfiles = new Set(["mixed", "all-passed"]);

if (!Number.isSafeInteger(count) || count < 1) {
  throw new Error(`Expected a positive test count, received: ${process.argv[2]}`);
}

if (!supportedScenarios.has(scenario)) {
  throw new Error(`Unknown tree scenario: ${scenario}. Expected one of: ${[...supportedScenarios].join(", ")}`);
}

if (!supportedStatusProfiles.has(statusProfile)) {
  throw new Error(
    `Unknown status profile: ${statusProfile}. Expected one of: ${[...supportedStatusProfiles].join(", ")}`,
  );
}

await mkdir(output, { recursive: true });

if ((await readdir(output)).length > 0) {
  throw new Error(`Refusing to write into non-empty directory: ${output}`);
}

const hash = (value) => createHash("md5").update(value).digest("hex");
const baseTime = Date.UTC(2026, 8, 17, 8, 0, 0);
const batchSize = 500;
const siblingCount = 100;

const treeLabels = (index) => {
  const sibling = String((index % siblingCount) + 1).padStart(3, "0");

  if (scenario === "deep-5") {
    return [
      { name: "level1", value: "Performance benchmark" },
      { name: "level2", value: "Layer 2" },
      { name: "level3", value: "Layer 3" },
      { name: "level4", value: "Layer 4" },
      { name: "level5", value: "Layer 5" },
    ];
  }

  if (scenario === "wide-100") {
    return [
      { name: "parentSuite", value: "100-folder performance benchmark" },
      { name: "suite", value: `Sibling ${sibling}` },
    ];
  }

  if (scenario === "deep-5-wide-100") {
    return [
      { name: "level1", value: "Performance benchmark" },
      { name: "level2", value: "Layer 2" },
      { name: "level3", value: `Sibling ${sibling}` },
      { name: "level4", value: `Sibling ${sibling} / Layer 4` },
      { name: "level5", value: `Sibling ${sibling} / Layer 5` },
    ];
  }

  return [
    { name: "parentSuite", value: "20k performance benchmark" },
    { name: "suite", value: "Large result set" },
    { name: "subSuite", value: "All synthetic tests" },
  ];
};

const makeResult = (index) => {
  const sequence = String(index + 1).padStart(String(count).length, "0");
  const uuid = `large-report-${sequence}`;
  const fullName = `performance.${scenario}.checkout-${sequence}`;
  const start = baseTime + index * 10;
  const duration = 25 + (index % 197);
  const forceSiblingOpen = scenario.includes("wide-100") && index < siblingCount;
  const status =
    statusProfile === "all-passed"
      ? "passed"
      : forceSiblingOpen
        ? "failed"
        : index % 101 === 0
          ? "failed"
          : index % 211 === 0
            ? "broken"
            : index % 43 === 0
              ? "skipped"
              : "passed";

  return {
    uuid,
    historyId: hash(fullName),
    testCaseId: hash(fullName),
    name: `Checkout flow ${sequence}`,
    fullName,
    status,
    statusDetails:
      status === "failed" || status === "broken"
        ? { message: `Synthetic ${status} result ${sequence}`, trace: `benchmark:${sequence}` }
        : {},
    stage: "finished",
    start,
    stop: start + duration,
    labels: [
      ...treeLabels(index),
      { name: "framework", value: "benchmark" },
      { name: "language", value: "javascript" },
      { name: "tag", value: index % 2 === 0 ? "regression" : "smoke" },
    ],
    links: [],
    parameters: [{ name: "case", value: sequence }],
    steps: [],
    attachments: [],
  };
};

for (let offset = 0; offset < count; offset += batchSize) {
  const end = Math.min(offset + batchSize, count);
  const writes = [];

  for (let index = offset; index < end; index += 1) {
    const result = makeResult(index);
    writes.push(writeFile(resolve(output, `${result.uuid}-result.json`), JSON.stringify(result)));
  }

  await Promise.all(writes);
}

console.log(`Generated ${count.toLocaleString("en-US")} ${scenario} (${statusProfile}) test results in ${output}`);
