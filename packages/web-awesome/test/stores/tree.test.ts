import { epic, feature, label, story } from "allure-js-commons";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(async () => {
  await epic("coverage");
  await feature("ui-state");
  await story("treeExpansion");
  await label("coverage", "ui-state");

  vi.resetModules();
  localStorage.clear();
});

describe("stores > tree", () => {
  it("keeps positive expansion state in memory and clears legacy persisted state", async () => {
    localStorage.setItem("expandedTrees", JSON.stringify(["persisted-suite"]));

    const { expandedTrees, toggleTree } = await import("../../src/stores/tree.js");

    expect(expandedTrees.value).toEqual(new Set());
    expect(localStorage.getItem("expandedTrees")).toBeNull();

    toggleTree("current-suite", false);

    expect(expandedTrees.value).toEqual(new Set(["current-suite"]));
    expect(localStorage.getItem("expandedTrees")).toBeNull();
  });
});
