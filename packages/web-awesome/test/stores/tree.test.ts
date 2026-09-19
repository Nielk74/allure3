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
  it("keeps positive expansion state only for the current page session", async () => {
    localStorage.setItem("expandedTrees", JSON.stringify(["persisted-suite"]));

    const firstSession = await import("../../src/stores/tree.js");

    expect(firstSession.expandedTrees.value).toEqual(new Set());
    expect(localStorage.getItem("expandedTrees")).toBeNull();

    firstSession.toggleTree("current-suite", false);

    expect(firstSession.expandedTrees.value).toEqual(new Set(["current-suite"]));
    expect(localStorage.getItem("expandedTrees")).toBeNull();

    vi.resetModules();
    const reloadedSession = await import("../../src/stores/tree.js");

    expect(reloadedSession.expandedTrees.value).toEqual(new Set());
    expect(reloadedSession.isTreeOpened("current-suite", false)).toBe(false);
  });
});
