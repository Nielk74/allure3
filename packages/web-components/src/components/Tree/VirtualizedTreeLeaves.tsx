import type { FunctionalComponent } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";

import type { TreeLeaf } from "../../../global";
import { TreeItem } from "./TreeItem";

const ROW_HEIGHT = 32;
const OVERSCAN_ROWS = 12;
const INITIAL_VIEWPORT_HEIGHT = 800;

type VirtualRange = {
  start: number;
  end: number;
};

type VirtualWindow = VirtualRange & {
  activePosition?: string;
};

type CalculateVirtualRangeOptions = {
  itemCount: number;
  listOffset: number;
  scrollTop: number;
  viewportHeight: number;
  activeIndex?: number;
};

export const calculateVirtualRange = ({
  itemCount,
  listOffset,
  scrollTop,
  viewportHeight,
  activeIndex = -1,
}: CalculateVirtualRangeOptions): VirtualRange => {
  const relativeScrollTop = Math.max(0, scrollTop - listOffset);
  const visibleStart = Math.floor(relativeScrollTop / ROW_HEIGHT);
  const visibleEnd = Math.ceil((relativeScrollTop + Math.max(viewportHeight, ROW_HEIGHT)) / ROW_HEIGHT);
  let start = Math.min(itemCount, Math.max(0, visibleStart - OVERSCAN_ROWS));
  let end = Math.min(itemCount, visibleEnd + OVERSCAN_ROWS);

  end = Math.max(start, end);

  if (activeIndex >= 0 && (activeIndex < start || activeIndex >= end)) {
    start = Math.max(0, activeIndex - OVERSCAN_ROWS);
    end = Math.min(itemCount, activeIndex + OVERSCAN_ROWS + 1);
  }

  return { start, end };
};

type VirtualizedTreeLeavesProps = {
  leaves: TreeLeaf[];
  routeId?: string;
  focusedId?: string;
  toScopedId: (nodeId: string) => string;
  navigateTo: (id: string) => void;
};

export const VirtualizedTreeLeaves: FunctionalComponent<VirtualizedTreeLeavesProps> = ({
  leaves,
  routeId,
  focusedId,
  toScopedId,
  navigateTo,
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const activeId = focusedId ?? routeId;
  const activeIndex = leaves.findIndex((leaf) => {
    return focusedId ? toScopedId(leaf.nodeId) === focusedId : leaf.nodeId === routeId;
  });
  const activePosition = activeIndex >= 0 ? `${activeId}:${activeIndex}` : undefined;
  const [virtualWindow, setVirtualWindow] = useState<VirtualWindow>(() => ({
    ...calculateVirtualRange({
      itemCount: leaves.length,
      listOffset: 0,
      scrollTop: 0,
      viewportHeight: INITIAL_VIEWPORT_HEIGHT,
      activeIndex,
    }),
    activePosition,
  }));
  const shouldRevealActive = activeIndex >= 0 && activePosition !== virtualWindow.activePosition;
  const renderRange =
    shouldRevealActive && (activeIndex < virtualWindow.start || activeIndex >= virtualWindow.end)
      ? calculateVirtualRange({
          itemCount: leaves.length,
          listOffset: activeIndex * ROW_HEIGHT,
          scrollTop: activeIndex * ROW_HEIGHT,
          viewportHeight: ROW_HEIGHT,
          activeIndex,
        })
      : virtualWindow;

  useLayoutEffect(() => {
    const list = listRef.current;
    const scrollContainer = list?.closest<HTMLElement>("[data-tree-scroll-container]");

    if (!list || !scrollContainer) {
      return;
    }

    let animationFrame: number | undefined;
    const updateRange = (revealActive = false) => {
      const listRect = list.getBoundingClientRect();
      const scrollRect = scrollContainer.getBoundingClientRect();
      const listOffset = scrollContainer.scrollTop + listRect.top - scrollRect.top;

      setVirtualWindow((current) => {
        const activeIndexToReveal = revealActive && current.activePosition !== activePosition ? activeIndex : -1;
        const nextRange = calculateVirtualRange({
          itemCount: leaves.length,
          listOffset,
          scrollTop: scrollContainer.scrollTop,
          viewportHeight: scrollContainer.clientHeight || INITIAL_VIEWPORT_HEIGHT,
          activeIndex: activeIndexToReveal,
        });

        return current.start === nextRange.start &&
          current.end === nextRange.end &&
          current.activePosition === activePosition
          ? current
          : { ...nextRange, activePosition };
      });
    };
    const scheduleUpdate = () => {
      if (animationFrame !== undefined) {
        cancelAnimationFrame(animationFrame);
      }

      animationFrame = requestAnimationFrame(() => updateRange());
    };

    updateRange(true);
    scrollContainer.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate, { passive: true });

    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(scrollContainer);

    return () => {
      if (animationFrame !== undefined) {
        cancelAnimationFrame(animationFrame);
      }

      resizeObserver?.disconnect();
      scrollContainer.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [activeIndex, activePosition, leaves.length]);

  const visibleLeaves = leaves.slice(renderRange.start, renderRange.end);

  return (
    <div ref={listRef} data-testid="tree-virtual-list" data-item-count={leaves.length}>
      <div aria-hidden="true" style={{ height: `${renderRange.start * ROW_HEIGHT}px` }} />
      {visibleLeaves.map((leaf) => (
        <TreeItem
          data-testid="tree-leaf"
          key={leaf.nodeId}
          id={leaf.nodeId}
          name={leaf.name}
          status={leaf.status}
          groupOrder={leaf.groupOrder as number}
          duration={leaf.duration}
          retriesCount={leaf.retriesCount}
          resolution={leaf.resolution}
          transition={leaf.transition}
          transitionTooltip={leaf.transitionTooltip}
          tooltips={leaf.tooltips}
          flaky={leaf.flaky}
          marked={leaf.nodeId === routeId}
          focused={toScopedId(leaf.nodeId) === focusedId}
          focusNodeId={toScopedId(leaf.nodeId)}
          navigateTo={navigateTo}
        />
      ))}
      <div aria-hidden="true" style={{ height: `${(leaves.length - renderRange.end) * ROW_HEIGHT}px` }} />
    </div>
  );
};
