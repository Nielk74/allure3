import type { Statistic } from "@allurereport/core-api";
import {
  applySubtreeToggleState,
  collectExpandableSubtreeNodes,
  getSubtreeToggleIcon,
  getTreeGroupDefaultOpenedState,
  hasExpandableTreeChildren,
  resolveNextSubtreeToggleState,
  type SubtreeNodeState,
  type SubtreeToggleState,
} from "@allurereport/web-commons";
import cx from "clsx";
import type { ComponentChild, FunctionalComponent } from "preact";
import { useState } from "preact/hooks";

import { IconButton } from "@/components/Button";
import { allureIcons } from "@/components/SvgIcon";
import { TreeItem } from "@/components/Tree/TreeItem";

import type { RecursiveTree, Status, TreeLeaf } from "../../../global";
import { TreeHeader } from "./TreeHeader";
import { VirtualizedTreeRows } from "./VirtualizedTreeRows";

import styles from "./styles.scss";

interface TreeProps {
  statistic?: Statistic;
  reportStatistic?: Statistic;
  tree: RecursiveTree;
  name?: string;
  root?: boolean;
  statusFilter?: Status;
  collapsedTrees: Set<string>;
  toggleTree: (id: string, openedByDefault?: boolean) => void;
  navigateTo: (id: string) => void;
  routeId?: string;
  focusedId?: string;
  /** Prefix for keyboard-focus ids when the same nodeId appears in multiple trees (e.g. environments). */
  focusIdPrefix?: string;
  /** When set, must match keyboard navigation open state (e.g. awesome `isTreeOpened`). */
  isGroupOpened?: (scopedNodeId: string, openedByDefault: boolean) => boolean;
}

export type TreeGroupRow = {
  kind: "group";
  tree: RecursiveTree;
  depth: number;
  scopedId: string;
  openedByDefault: boolean;
  isOpened: boolean;
};

export type TreeLeafRow = {
  kind: "leaf";
  leaf: TreeLeaf;
  depth: number;
  scopedId: string;
};

export type TreeRow = TreeGroupRow | TreeLeafRow;

type FlattenVisibleTreeRowsOptions = {
  tree: RecursiveTree;
  initialDepth?: number;
  toScopedId: (nodeId: string) => string;
  isOpened: (scopedId: string, openedByDefault: boolean) => boolean;
};

const isNodeOpened = (nodeId: string, collapsedTrees: Set<string>, defaultOpened: boolean) =>
  collapsedTrees.has(nodeId) ? !defaultOpened : defaultOpened;

const hasTreeChildren = (tree: RecursiveTree) => hasExpandableTreeChildren(tree);

const hasTreeOnlyLeafResults = (tree: RecursiveTree) => hasTreeChildren(tree) && tree.trees.length === 0;
const VIRTUALIZATION_THRESHOLD = 100;
const subtreeToggleIconByState = {
  "single-down": allureIcons.lineArrowsChevronDown,
  "single-up": allureIcons.lineArrowsChevronUp,
  "double-down": allureIcons.lineArrowsChevronDownDouble,
  "double-up": allureIcons.lineArrowsChevronUpDouble,
} as const;

/**
 * Flattens only the currently visible part of the tree. Closed branches are skipped, so a normal render never walks
 * their descendants. The complete subtree is inspected only when the explicit subtree toggle is activated.
 */
export const flattenVisibleTreeRows = ({
  tree,
  initialDepth = 0,
  toScopedId,
  isOpened,
}: FlattenVisibleTreeRowsOptions): TreeRow[] => {
  const rows: TreeRow[] = [];
  const stack: Array<
    { kind: "tree"; tree: RecursiveTree; depth: number } | { kind: "leaf"; leaf: TreeLeaf; depth: number }
  > = [];

  for (let index = tree.leaves.length - 1; index >= 0; index -= 1) {
    stack.push({ kind: "leaf", leaf: tree.leaves[index]!, depth: initialDepth });
  }
  for (let index = tree.trees.length - 1; index >= 0; index -= 1) {
    stack.push({ kind: "tree", tree: tree.trees[index]!, depth: initialDepth });
  }

  while (stack.length > 0) {
    const current = stack.pop();

    if (!current) {
      continue;
    }

    if (current.kind === "leaf") {
      rows.push({
        kind: "leaf",
        leaf: current.leaf,
        depth: current.depth,
        scopedId: toScopedId(current.leaf.nodeId),
      });
      continue;
    }

    const openedByDefault = getTreeGroupDefaultOpenedState();
    const scopedId = toScopedId(current.tree.nodeId);
    const treeIsOpened = isOpened(scopedId, openedByDefault);

    rows.push({
      kind: "group",
      tree: current.tree,
      depth: current.depth,
      scopedId,
      openedByDefault,
      isOpened: treeIsOpened,
    });

    if (!treeIsOpened) {
      continue;
    }

    const childDepth = current.depth + 1;

    for (let index = current.tree.leaves.length - 1; index >= 0; index -= 1) {
      stack.push({ kind: "leaf", leaf: current.tree.leaves[index]!, depth: childDepth });
    }
    for (let index = current.tree.trees.length - 1; index >= 0; index -= 1) {
      stack.push({ kind: "tree", tree: current.tree.trees[index]!, depth: childDepth });
    }
  }

  return rows;
};

const normalizeSubtreeRoot = (
  nodes: SubtreeNodeState[],
  rootId: string,
  openedByDefault: boolean,
): SubtreeNodeState[] => nodes.map((node) => (node.id === rootId ? { ...node, openedByDefault } : node));

export const Tree: FunctionalComponent<TreeProps> = ({
  tree,
  statusFilter,
  root,
  name,
  statistic,
  reportStatistic,
  collapsedTrees,
  toggleTree,
  routeId,
  focusedId,
  focusIdPrefix,
  isGroupOpened,
  navigateTo,
}) => {
  const rootNodeId = tree.nodeId as string;
  const toScopedId = (nodeId: string) => (focusIdPrefix ? `${focusIdPrefix}${nodeId}` : nodeId);
  const defaultOpened = getTreeGroupDefaultOpenedState(Boolean(root));
  const resolveIsOpened = (scopedId: string, openedByDefault: boolean) =>
    isGroupOpened ? isGroupOpened(scopedId, openedByDefault) : isNodeOpened(scopedId, collapsedTrees, openedByDefault);
  const rootScopedId = toScopedId(rootNodeId);
  const isOpened = resolveIsOpened(rootScopedId, defaultOpened);
  const hasChildren = hasTreeChildren(tree);
  const [lastSubtreeToggleById, setLastSubtreeToggleById] = useState<Record<string, SubtreeToggleState | null>>({});
  const [appliedSubtreeStateById, setAppliedSubtreeStateById] = useState<Record<string, SubtreeToggleState>>({});
  const canRenderHeader = Boolean(name);
  const hasRenderableChildren = tree.trees.length > 0 || tree.leaves.length > 0;

  if (!hasRenderableChildren) {
    return null;
  }

  const rows = isOpened
    ? flattenVisibleTreeRows({
        tree,
        initialDepth: root ? 0 : 1,
        toScopedId,
        isOpened: resolveIsOpened,
      })
    : [];
  const visibleLeafCount = rows.reduce((count, row) => count + (row.kind === "leaf" ? 1 : 0), 0);

  const clearSubtreeToggleState = (scopedId: string) => {
    setLastSubtreeToggleById((current) => {
      if (!(scopedId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[scopedId];
      return next;
    });
    setAppliedSubtreeStateById((current) => {
      if (!(scopedId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[scopedId];
      return next;
    });
  };

  const toggleGroup = (row: Pick<TreeGroupRow, "scopedId" | "openedByDefault">) => {
    toggleTree(row.scopedId, row.openedByDefault);
    clearSubtreeToggleState(row.scopedId);
  };

  const toggleSubtree = (row: TreeGroupRow, event: MouseEvent) => {
    event.stopPropagation();

    const subtreeNodes = normalizeSubtreeRoot(
      collectExpandableSubtreeNodes(row.tree),
      row.tree.nodeId,
      row.openedByDefault,
    );
    const lastSubtreeToggle = lastSubtreeToggleById[row.scopedId] ?? null;
    const { nextState, nextLastToggle } = resolveNextSubtreeToggleState(
      subtreeNodes,
      (id, openedByDefault) => resolveIsOpened(toScopedId(id), openedByDefault),
      lastSubtreeToggle,
    );

    applySubtreeToggleState(subtreeNodes, nextState, {
      toScopedId,
      isOpened: resolveIsOpened,
      setOpened: (scopedId, shouldOpen, openedByDefault) => {
        if (resolveIsOpened(scopedId, openedByDefault) !== shouldOpen) {
          toggleTree(scopedId, openedByDefault);
        }
      },
    });

    setLastSubtreeToggleById((current) => ({ ...current, [row.scopedId]: nextLastToggle }));
    setAppliedSubtreeStateById((current) => ({ ...current, [row.scopedId]: nextState }));
  };

  const getSubtreeToggleIconForRow = (row: TreeGroupRow) => {
    const hasOnlyLeafResults = hasTreeOnlyLeafResults(row.tree);
    const appliedState = appliedSubtreeStateById[row.scopedId];
    const isSubtreeCollapsedAll = !row.isOpened;
    const isSubtreeFirstLevelOnly = appliedState === "first";

    return subtreeToggleIconByState[
      getSubtreeToggleIcon({
        hasOnlyLeafResults,
        isSubtreeCollapsedAll,
        isSubtreeFirstLevelOnly,
      })
    ];
  };

  const renderHeaderActions = (row: TreeGroupRow): ComponentChild =>
    hasTreeChildren(row.tree) ? (
      <IconButton
        size="xs"
        style="ghost"
        icon={getSubtreeToggleIconForRow(row)}
        onClick={(event) => toggleSubtree(row, event)}
        className={styles["tree-subtree-toggle"]}
        data-testid="tree-subtree-toggle"
      />
    ) : undefined;

  const renderRow = (row: TreeRow) => {
    const rowStyle = { paddingLeft: `${row.depth * 24}px` };

    if (row.kind === "group") {
      return (
        <div key={`group:${row.scopedId}`} className={styles["tree-row"]} style={rowStyle}>
          <TreeHeader
            statusFilter={statusFilter}
            categoryTitle={row.tree.name}
            isOpened={row.isOpened}
            toggleTree={() => toggleGroup(row)}
            statistic={row.tree.statistic}
            reportStatistic={reportStatistic}
            actions={renderHeaderActions(row)}
            focused={row.scopedId === focusedId}
            nodeId={row.scopedId}
          />
          {row.isOpened ? <div data-testid="tree-content" className={styles["tree-content-marker"]} /> : null}
        </div>
      );
    }

    const { leaf } = row;

    return (
      <div key={`leaf:${row.scopedId}`} className={styles["tree-row"]} style={rowStyle}>
        <TreeItem
          data-testid="tree-leaf"
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
          focused={row.scopedId === focusedId}
          focusNodeId={row.scopedId}
          navigateTo={navigateTo}
        />
      </div>
    );
  };

  const rootRow: TreeGroupRow = {
    kind: "group",
    tree,
    depth: 0,
    scopedId: rootScopedId,
    openedByDefault: defaultOpened,
    isOpened,
  };
  const headerActions = hasChildren ? renderHeaderActions(rootRow) : undefined;
  const activeIndex = rows.findIndex((row) => {
    if (focusedId) {
      return row.scopedId === focusedId;
    }

    return row.kind === "leaf" && row.leaf.nodeId === routeId;
  });
  const activePosition = activeIndex >= 0 ? `${focusedId ?? routeId}:${activeIndex}` : undefined;
  const treeRows =
    rows.length > VIRTUALIZATION_THRESHOLD ? (
      <VirtualizedTreeRows
        rows={rows}
        activeIndex={activeIndex}
        activePosition={activePosition}
        leafCount={visibleLeafCount}
        renderRow={renderRow}
      />
    ) : (
      rows.map(renderRow)
    );

  return (
    <div className={styles.tree}>
      {canRenderHeader ? (
        <TreeHeader
          statusFilter={statusFilter}
          categoryTitle={name}
          isOpened={isOpened}
          toggleTree={() => toggleGroup(rootRow)}
          statistic={statistic}
          reportStatistic={reportStatistic}
          actions={headerActions}
          focused={rootScopedId === focusedId}
          nodeId={rootScopedId}
        />
      ) : null}
      {isOpened ? (
        <div data-testid="tree-content" className={cx(styles["tree-content"], root && styles.root)}>
          {treeRows}
        </div>
      ) : null}
    </div>
  );
};
