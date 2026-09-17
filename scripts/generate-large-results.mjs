import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const count = Number.parseInt(process.argv[2] ?? "20000", 10);
const output = resolve(process.argv[3] ?? "bench/allure-results-20000");

if (!Number.isSafeInteger(count) || count < 1) {
  throw new Error(`Expected a positive test count, received: ${process.argv[2]}`);
}

await mkdir(output, { recursive: true });

if ((await readdir(output)).length > 0) {
  throw new Error(`Refusing to write into non-empty directory: ${output}`);
}

const hash = (value) => createHash("md5").update(value).digest("hex");
const baseTime = Date.UTC(2026, 8, 17, 8, 0, 0);
const batchSize = 500;

const makeResult = (index) => {
  const sequence = String(index + 1).padStart(String(count).length, "0");
  const uuid = `large-report-${sequence}`;
  const fullName = `performance.large-suite.checkout-${sequence}`;
  const start = baseTime + index * 10;
  const duration = 25 + (index % 197);
  const status = index % 101 === 0 ? "failed" : index % 211 === 0 ? "broken" : index % 43 === 0 ? "skipped" : "passed";

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
      { name: "parentSuite", value: "20k performance benchmark" },
      { name: "suite", value: "Large result set" },
      { name: "subSuite", value: "All synthetic tests" },
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

console.log(`Generated ${count.toLocaleString("en-US")} test results in ${output}`);
