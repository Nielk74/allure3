import { emptyStatistic } from "@allurereport/core-api";
import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecursiveTree, TreeLeaf } from "../../../global";
import { flattenVisibleTreeRows, Tree } from "./Tree";
import { calculateVirtualRange } from "./VirtualizedTreeRows";

afterEach(() => {
  cleanup();
});

const makeLeaf = (index: number): TreeLeaf => ({
  id: `result-${index}`,
  nodeId: `result-${index}`,
  name: `Case ${index}`,
  groupOrder: index + 1,
  status: "passed",
});

const makeGroup = (index: number): RecursiveTree => ({
  nodeId: `group-${index}`,
  name: `Group ${index}`,
  statistic: { ...emptyStatistic(), passed: 1, total: 1 },
  leaves: [makeLeaf(index)],
  trees: [],
});

const makeTree = (groupCount: number): RecursiveTree => ({
  nodeId: "root",
  name: "Root",
  statistic: { ...emptyStatistic(), passed: groupCount, total: groupCount },
  leaves: [],
  trees: Array.from({ length: groupCount }, (_, index) => makeGroup(index)),
});

describe("calculateVirtualRange", () => {
  it("renders only the visible slice with overscan", () => {
    expect(
      calculateVirtualRange({
        itemCount: 20_000,
        listOffset: 200,
        scrollTop: 10_000,
        viewportHeight: 800,
      }),
    ).toEqual({ start: 294, end: 344 });
  });

  it("includes an active item outside the viewport so focus can scroll to it", () => {
    expect(
      calculateVirtualRange({
        itemCount: 20_000,
        listOffset: 0,
        scrollTop: 0,
        viewportHeight: 800,
        activeIndex: 19_999,
      }),
    ).toEqual({ start: 19_987, end: 20_000 });
  });

  it("clamps the range when the list is above the viewport", () => {
    expect(
      calculateVirtualRange({
        itemCount: 100,
        listOffset: 0,
        scrollTop: 100_000,
        viewportHeight: 800,
      }),
    ).toEqual({ start: 100, end: 100 });
  });
});

describe("flattenVisibleTreeRows", () => {
  it("includes groups and leaves in display order while skipping closed descendants", () => {
    const tree = makeTree(2);
    const rows = flattenVisibleTreeRows({
      tree,
      toScopedId: (id) => `env:${id}`,
      isOpened: (id) => id === "env:group-0",
    });

    expect(
      rows.map((row) => ({
        kind: row.kind,
        id: row.scopedId,
        depth: row.depth,
      })),
    ).toEqual([
      { kind: "group", id: "env:group-0", depth: 0 },
      { kind: "leaf", id: "env:result-0", depth: 1 },
      { kind: "group", id: "env:group-1", depth: 0 },
    ]);
  });

  it.each(["failed", "broken"] as const)("keeps %s groups collapsed until the user opens them", (status) => {
    const tree = makeTree(1);
    tree.trees[0]!.statistic = { ...emptyStatistic(), [status]: 1, total: 1 };
    const observedDefaults: boolean[] = [];
    const rows = flattenVisibleTreeRows({
      tree,
      toScopedId: (id) => id,
      isOpened: (_id, openedByDefault) => {
        observedDefaults.push(openedByDefault);
        return openedByDefault;
      },
    });

    expect(observedDefaults).toEqual([false]);
    expect(rows.map((row) => row.scopedId)).toEqual(["group-0"]);
  });
});

describe("Tree row virtualization", () => {
  it("bounds mixed group and leaf DOM while keeping an offscreen focused result renderable", () => {
    const tree = makeTree(500);
    const isGroupOpened = () => true;
    const { rerender } = render(
      <div data-tree-scroll-container>
        <Tree
          tree={tree}
          statistic={tree.statistic}
          reportStatistic={tree.statistic}
          collapsedTrees={new Set()}
          toggleTree={vi.fn()}
          isGroupOpened={isGroupOpened}
          navigateTo={vi.fn()}
          focusedId="result-0"
          root
        />
      </div>,
    );

    expect(screen.getByTestId("tree-virtual-list").getAttribute("data-item-count")).toBe("1000");
    expect(screen.getAllByTestId("tree-section").length + screen.getAllByTestId("tree-leaf").length).toBeLessThan(100);

    rerender(
      <div data-tree-scroll-container>
        <Tree
          tree={tree}
          statistic={tree.statistic}
          reportStatistic={tree.statistic}
          collapsedTrees={new Set()}
          toggleTree={vi.fn()}
          isGroupOpened={isGroupOpened}
          navigateTo={vi.fn()}
          focusedId="result-499"
          root
        />
      </div>,
    );

    expect(screen.getByTitle("Case 499").getAttribute("data-tree-node-id")).toBe("result-499");
    expect(screen.getAllByTestId("tree-section").length + screen.getAllByTestId("tree-leaf").length).toBeLessThan(100);
  });
});
