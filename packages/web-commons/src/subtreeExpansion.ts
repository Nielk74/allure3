import type { Statistic } from "@allurereport/core-api";

import type { SubtreeNodeState, SubtreeToggleState } from "./treeSubtreeToggle.js";

export type ExpandableTreeNode = {
  nodeId: string;
  statistic?: Statistic;
  trees: ExpandableTreeNode[];
  leaves: unknown[];
};

/** Report hierarchy groups start closed. Only the invisible root container is open so first-level folders render. */
export const getTreeGroupDefaultOpenedState = (root = false) => root;

export const hasExpandableTreeChildren = (tree: ExpandableTreeNode) => tree.trees.length > 0 || tree.leaves.length > 0;

/** All group nodes in a subtree (root first), with default open state — matches report tree header toggle. */
export const collectExpandableSubtreeNodes = (tree: ExpandableTreeNode): SubtreeNodeState[] => {
  const nodes: SubtreeNodeState[] = [];
  const stack: { tree: ExpandableTreeNode; isRoot: boolean }[] = [{ tree, isRoot: true }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    nodes.push({
      id: current.tree.nodeId,
      openedByDefault: getTreeGroupDefaultOpenedState(),
      isRoot: current.isRoot,
    });
    current.tree.trees.forEach((nestedSubtree) => stack.push({ tree: nestedSubtree, isRoot: false }));
  }

  return nodes;
};

export const applySubtreeToggleState = (
  expandableSubtreeNodes: SubtreeNodeState[],
  state: SubtreeToggleState,
  options: {
    toScopedId: (nodeId: string) => string;
    isOpened: (scopedId: string, openedByDefault: boolean) => boolean;
    setOpened: (scopedId: string, shouldOpen: boolean, openedByDefault: boolean) => void;
  },
): void => {
  expandableSubtreeNodes.forEach((node) => {
    const shouldOpenSubtree = state === "all" ? true : state === "first" ? node.isRoot : false;
    const scopedId = options.toScopedId(node.id);
    const currentlyOpened = options.isOpened(scopedId, node.openedByDefault);

    if (currentlyOpened !== shouldOpenSubtree) {
      options.setOpened(scopedId, shouldOpenSubtree, node.openedByDefault);
    }
  });
};
