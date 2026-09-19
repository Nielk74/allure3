import { buildFilterPredicate, errorMessageFromUnknown, fetchReportJsonData } from "@allurereport/web-commons";
import type { RecursiveTree } from "@allurereport/web-components/global";
import { computed, effect, signal } from "@preact/signals";
import type { ReportTree, ReportTreeGroup } from "types";

import type { StoreSignalState } from "@/stores/types";
import { loadFromLocalStorage } from "@/utils/loadFromLocalStorage";
import { createRecursiveTree, isRecursiveTreeEmpty } from "@/utils/treeFilters";

import { currentEnvironment } from "./env";
import { fetchEnvSearchIndexes, searchIndexesStore, searchNodeIds } from "./search";
import { treeNonQueryFilters, treeQueryFilterValue } from "./treeFilters/store";
import { sortBy } from "./treeSort";

export const treeStore = signal<StoreSignalState<Record<string, ReportTree>>>({
  loading: true,
  error: undefined,
  data: undefined,
});

export const noTests = computed(() => {
  return Object.values(treeStore?.value?.data ?? {}).every(
    ({ leavesById }) => !leavesById || !Object.keys(leavesById).length,
  );
});

export const collapsedTrees = signal(new Set(loadFromLocalStorage<string[]>("collapsedTrees", [])));
export const expandedTrees = signal(new Set<string>());

// Expansion is working context for the current report, not a durable preference. Remove values written by older
// versions so a previously opened large suite cannot make a later report expensive to load.
try {
  localStorage.removeItem("expandedTrees");
} catch {
  // Storage can be unavailable in restricted browser contexts. The in-memory state still works in that case.
}

effect(() => {
  localStorage.setItem("collapsedTrees", JSON.stringify([...collapsedTrees.value]));
});

export const isTreeOpened = (id: string, openedByDefault = true): boolean => {
  if (openedByDefault) {
    return !collapsedTrees.value.has(id);
  }

  return expandedTrees.value.has(id);
};

const setTreeStoredState = (id: string, shouldBeOpened: boolean, openedByDefault: boolean) => {
  if (openedByDefault) {
    const nextCollapsedTrees = new Set(collapsedTrees.value);
    if (shouldBeOpened) {
      nextCollapsedTrees.delete(id);
    } else {
      nextCollapsedTrees.add(id);
    }
    collapsedTrees.value = nextCollapsedTrees;
    return;
  }

  const nextExpandedTrees = new Set(expandedTrees.value);
  if (shouldBeOpened) {
    nextExpandedTrees.add(id);
  } else {
    nextExpandedTrees.delete(id);
  }
  expandedTrees.value = nextExpandedTrees;
};

export const toggleTree = (id: string, openedByDefault = true) => {
  setTreeStoredState(id, !isTreeOpened(id, openedByDefault), openedByDefault);
};

export const setTreeOpened = (id: string, shouldBeOpened: boolean, openedByDefault = true) => {
  setTreeStoredState(id, shouldBeOpened, openedByDefault);
};

export const fetchEnvTreesData = async (envs: string[]) => {
  const envsToFetch = envs.filter((env) => !treeStore.peek().data?.[env]);

  // all envs have already been fetched
  if (envsToFetch.length === 0) {
    return;
  }

  treeStore.value = {
    ...treeStore.peek(),
    loading: true,
    error: undefined,
  };

  try {
    const data = await Promise.all(
      envsToFetch.map((env) => fetchReportJsonData<ReportTree>(`widgets/${env}/tree.json`, { bustCache: true })),
    );

    const previous = treeStore.peek().data;
    treeStore.value = {
      data: envsToFetch.reduce(
        (acc, env, index) => {
          return {
            ...acc,
            [env]: data[index],
          };
        },
        { ...previous },
      ),
      loading: false,
      error: undefined,
    };
  } catch (e) {
    treeStore.value = {
      ...treeStore.peek(),
      error: errorMessageFromUnknown(e),
      loading: false,
    };
  }
};

const treeEntries = computed(() => (treeStore.value.data ? Object.entries(treeStore.value.data) : []));

const alwaysTruePredicate = () => true;

const filterPredicate = computed(() => {
  if (treeNonQueryFilters.value.length === 0) {
    return alwaysTruePredicate;
  }

  return buildFilterPredicate(treeNonQueryFilters.value);
});

effect(() => {
  if (!treeQueryFilterValue.value?.trim()) {
    return;
  }

  const treeEnvIds = Object.keys(treeStore.value.data ?? {});
  const envsToFetch = currentEnvironment.value ? [currentEnvironment.value] : treeEnvIds;

  if (envsToFetch.length === 0) {
    return;
  }

  fetchEnvSearchIndexes(envsToFetch);
});

const searchFilterPredicate = (env: string) => {
  const query = treeQueryFilterValue.value?.trim();

  if (!query) {
    return alwaysTruePredicate;
  }

  const searchIndex = searchIndexesStore.value.data?.[env];

  if (!searchIndex) {
    fetchEnvSearchIndexes([env]);

    return alwaysTruePredicate;
  }

  const matchingNodeIds = searchNodeIds(searchIndex, query);

  return (leaf: { nodeId: string }) => matchingNodeIds.has(leaf.nodeId);
};

export const filteredTree = computed(() => {
  return treeEntries.value.reduce(
    (acc, [key, value]) => {
      if (!value) {
        return acc;
      }

      const { root, leavesById, groupsById } = value;
      const envSearchFilterPredicate = searchFilterPredicate(key);

      const tree = createRecursiveTree({
        group: root as ReportTreeGroup,
        leavesById,
        groupsById,
        filterPredicate: (leaf) => filterPredicate.value(leaf) && envSearchFilterPredicate(leaf),
        sortBy: sortBy.value,
      });

      return Object.assign(acc, {
        [key]: tree,
      });
    },
    {} as Record<string, RecursiveTree>,
  );
});

export const noTestsFound = computed(
  () => !Object.values(filteredTree.value).some((tree) => !isRecursiveTreeEmpty(tree)),
);
