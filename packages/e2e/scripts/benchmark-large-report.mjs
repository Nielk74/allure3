import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { chromium } from "@playwright/test";

const url = process.argv[2] ?? "http://127.0.0.1:4173";
const expectedResults = Number.parseInt(process.argv[3] ?? "20000", 10);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const client = await page.context().newCDPSession(page);

await client.send("Performance.enable");

const treeReady = (count) => {
  const virtualList = document.querySelector('[data-testid="tree-virtual-list"]');

  return (
    virtualList?.getAttribute("data-item-count") === String(count) ||
    document.querySelectorAll('[data-testid="tree-leaf"]').length === count
  );
};

const startedAt = performance.now();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
await page.waitForFunction(treeReady, expectedResults, { timeout: 120_000 });
const interactiveMs = performance.now() - startedAt;
console.error(`Initial tree rendered in ${Math.round(interactiveMs)} ms`);

const snapshot = async () => {
  const [{ metrics }, dom] = await Promise.all([
    client.send("Performance.getMetrics"),
    page.evaluate(() => {
      const virtualList = document.querySelector('[data-testid="tree-virtual-list"]');
      const treeLeaves = document.querySelectorAll('[data-testid="tree-leaf"]').length;

      return {
        domNodes: document.getElementsByTagName("*").length,
        treeLeaves,
        logicalTreeLeaves: Number(virtualList?.getAttribute("data-item-count") ?? treeLeaves),
      };
    }),
  ]);
  const metric = (name) => metrics.find((entry) => entry.name === name)?.value ?? 0;

  return {
    ...dom,
    heapUsedMb: Number((metric("JSHeapUsedSize") / 1024 / 1024).toFixed(1)),
    layoutCount: metric("LayoutCount"),
    recalcStyleCount: metric("RecalcStyleCount"),
  };
};

const beforeSearch = await snapshot();
const subtreeToggle = page.getByTestId("tree-subtree-toggle").first();
const collapseStartedAt = performance.now();
await subtreeToggle.evaluate((element) => element.click());
await page.waitForFunction(() => document.querySelectorAll('[data-testid="tree-leaf"]').length === 0, undefined, {
  timeout: 120_000,
});
const collapseMs = performance.now() - collapseStartedAt;
console.error(`Full tree collapsed in ${Math.round(collapseMs)} ms`);

const expandStartedAt = performance.now();
await subtreeToggle.evaluate((element) => element.click());
await page.waitForFunction(treeReady, expectedResults, { timeout: 120_000 });
const expandMs = performance.now() - expandStartedAt;
console.error(`Full tree expanded in ${Math.round(expandMs)} ms`);

const sequence = String(1).padStart(String(expectedResults).length, "0");
const fullName = `performance.large-suite.checkout-${sequence}`;
const uniqueSearchTerm = createHash("md5").update(fullName).digest("hex");
const searchStartedAt = performance.now();
await page.getByTestId("search-input").fill(uniqueSearchTerm);
await page.waitForFunction(
  (count) => {
    const virtualList = document.querySelector('[data-testid="tree-virtual-list"]');

    return virtualList
      ? Number(virtualList.getAttribute("data-item-count")) < count
      : document.querySelectorAll('[data-testid="tree-leaf"]').length < count;
  },
  expectedResults,
  {
    timeout: 120_000,
  },
);
const searchMs = performance.now() - searchStartedAt;
console.error(`Search applied in ${Math.round(searchMs)} ms`);
const afterSearch = await snapshot();

const clearStartedAt = performance.now();
await page.getByTestId("clear-button").click();
await page.waitForFunction(treeReady, expectedResults, { timeout: 120_000 });
const clearSearchMs = performance.now() - clearStartedAt;
console.error(`Full tree restored in ${Math.round(clearSearchMs)} ms`);
const afterClear = await snapshot();

const scrollStartedAt = performance.now();
const scrollResult = await page.evaluate(() => {
  const virtualList = document.querySelector('[data-testid="tree-virtual-list"]');
  const scrollContainer = virtualList?.closest("[data-tree-scroll-container]");
  const firstLeaf = virtualList?.querySelector('[data-testid="tree-leaf"]');

  if (!(virtualList instanceof HTMLElement) || !(scrollContainer instanceof HTMLElement)) {
    return undefined;
  }

  const firstNodeId = firstLeaf?.getAttribute("data-tree-node-id");
  scrollContainer.scrollTop = scrollContainer.scrollHeight;

  return { firstNodeId };
});

let scrollMs;
let afterScroll;

if (scrollResult) {
  await page.waitForFunction(
    (firstNodeId) =>
      document
        .querySelector('[data-testid="tree-virtual-list"] [data-testid="tree-leaf"]')
        ?.getAttribute("data-tree-node-id") !== firstNodeId,
    scrollResult.firstNodeId,
    { timeout: 120_000 },
  );
  scrollMs = Math.round(performance.now() - scrollStartedAt);
  afterScroll = await snapshot();
  console.error(`Virtual tree scrolled to a new window in ${scrollMs} ms`);
}

console.log(
  JSON.stringify(
    {
      url,
      expectedResults,
      interactiveMs: Math.round(interactiveMs),
      collapseMs: Math.round(collapseMs),
      expandMs: Math.round(expandMs),
      searchMs: Math.round(searchMs),
      clearSearchMs: Math.round(clearSearchMs),
      beforeSearch,
      afterSearch,
      afterClear,
      scrollMs,
      afterScroll,
    },
    null,
    2,
  ),
);

await browser.close();
