import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TreeLeaf } from "../../../global";
import { calculateVirtualRange, VirtualizedTreeLeaves } from "./VirtualizedTreeLeaves";

afterEach(() => {
  cleanup();
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

describe("VirtualizedTreeLeaves", () => {
  const leaves: TreeLeaf[] = Array.from({ length: 500 }, (_, index) => ({
    id: `result-${index}`,
    nodeId: `result-${index}`,
    name: `Case ${index}`,
    groupOrder: index + 1,
    status: "passed",
  }));

  it("keeps the DOM bounded and renders an offscreen focused result", () => {
    const { rerender } = render(
      <div data-tree-scroll-container>
        <VirtualizedTreeLeaves leaves={leaves} toScopedId={(id) => id} navigateTo={vi.fn()} focusedId="result-0" />
      </div>,
    );

    expect(screen.getAllByTestId("tree-leaf").length).toBeLessThan(100);

    rerender(
      <div data-tree-scroll-container>
        <VirtualizedTreeLeaves leaves={leaves} toScopedId={(id) => id} navigateTo={vi.fn()} focusedId="result-499" />
      </div>,
    );

    expect(screen.getByTitle("Case 499").getAttribute("data-tree-node-id")).toBe("result-499");
    expect(screen.getAllByTestId("tree-leaf").length).toBeLessThan(100);
  });
});
