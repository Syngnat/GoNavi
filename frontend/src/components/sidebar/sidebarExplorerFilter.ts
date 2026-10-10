/**
 * The sidebar explorer's object-kind filter: which dimension the tree is narrowed
 * to, and how a tree is narrowed to it.
 *
 * Extracted from `sidebarV2Utils`, which is well past the repo's file-size limit
 * and must not absorb new branches (AGENTS.md §1.1). Everything here is pure, so
 * the narrowing rules are unit-testable without mounting the sidebar.
 *
 * Two kinds of filter live side by side:
 *
 * - the relational object kinds (`tables`, `views`, …), which match on an
 *   `object-group`'s `dataRef.groupKey` and on the object node types below it;
 * - the Nacos workbench kinds (`nacos-services`, `nacos-configs`), which select
 *   one of a namespace's two explorer branches.
 *
 * They share one union on purpose. `useSidebarSearchModel` and the sidebar tree
 * already route every filter through a single `v2ExplorerFilter` value, so
 * extending the union costs the wiring nothing, while a parallel Nacos-only filter
 * axis would have had to be threaded through all of it.
 */

import type { SidebarTreeNode } from '../sidebarV2Utils';
import { t } from '../../i18n';
import { t as catalogTranslate } from '../../i18n/catalog';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';

export type SidebarExplorerFilterTranslate = (key: string) => string;

/** V2 资源管理器过滤维度（含 Nacos 工作台的两个分支）。 */
export type V2ExplorerFilter =
  | 'all'
  | 'tables'
  | 'views'
  | 'sequences'
  | 'routines'
  | 'packages'
  | 'events'
  | 'nacos-services'
  | 'nacos-configs';

const translateCurrent: SidebarExplorerFilterTranslate = (key) => t(key);
const translateZhCN: SidebarExplorerFilterTranslate = (key) => catalogTranslate('zh-CN', key);

export const V2_EXPLORER_FILTER_LABEL_KEYS: Record<V2ExplorerFilter, string> = {
  all: 'sidebar.command_search.object_kind.all',
  tables: 'sidebar.command_search.object_kind.tables',
  views: 'sidebar.command_search.object_kind.views',
  sequences: 'sidebar.command_search.object_kind.sequences',
  routines: 'sidebar.command_search.object_kind.routines',
  packages: 'sidebar.command_search.object_kind.packages',
  events: 'sidebar.command_search.object_kind.events',
  'nacos-services': 'sidebar.command_search.object_kind.nacos_services',
  'nacos-configs': 'sidebar.command_search.object_kind.nacos_configs',
};

/**
 * Which filters each connection family offers. A filter is only ever applied to a
 * tree of the family it was written for, which is what {@link resolveExplorerFilterFamily}
 * enforces.
 */
export const V2_EXPLORER_FILTER_ORDER: Record<ExplorerFilterFamily, V2ExplorerFilter[]> = {
  relational: ['all', 'tables', 'views', 'sequences', 'routines', 'packages', 'events'],
  nacos: ['all', 'nacos-services', 'nacos-configs'],
};

export type ExplorerFilterFamily = 'relational' | 'nacos';

/**
 * Which family's filters the active connection can honour.
 *
 * This is the single source of truth for two things that must not disagree:
 * which buttons the slot shows, and whether the current filter still fits the
 * tree. Both used to be answered separately — the buttons from the data-source
 * capabilities, the reset from a boolean derived from those same capabilities —
 * which left a hole once Nacos gained filters of its own: switching from a Nacos
 * host to a database (or the reverse) kept the previous family's filter, and
 * `filterV2ExplorerTreeByKind` then correctly emptied a tree whose nodes belong
 * to the other family. The sidebar appeared to lose all of its content.
 *
 * Returns null when the connection offers no filters at all (Redis, MQ, or no
 * active host): the slot then carries the workbench's own summary, or nothing.
 */
export const resolveExplorerFilterFamily = (
  connection: { config?: any } | null | undefined,
): ExplorerFilterFamily | null => {
  if (isNacosConnection(connection)) return 'nacos';
  if (!connection) return null;
  return getDataSourceCapabilities(connection.config).supportsRelationalObjectKindFilter
    ? 'relational'
    : null;
};

/** The object-group keys each relational filter keeps. */
const V2_EXPLORER_FILTER_GROUP_KEYS: Record<string, string[]> = {
  tables: ['tables'],
  views: ['views', 'materializedViews'],
  sequences: ['sequences'],
  routines: ['routines'],
  packages: ['packages'],
  events: ['events'],
};

/**
 * Every node type a Nacos namespace can contain, i.e. the rows a Nacos filter is
 * allowed to keep. A Nacos namespace row is a plain container: it survives only
 * while at least one of these branches survives under it.
 */
const NACOS_NODE_TYPES = new Set<string>([
  'nacos-namespace',
  'nacos-config-entry',
  'nacos-config-group',
  'nacos-config',
  'nacos-services-entry',
  'nacos-service-group',
]);

const isNacosFilter = (filter: V2ExplorerFilter): boolean => (
  filter === 'nacos-services' || filter === 'nacos-configs'
);

export const isNacosConnection = (
  connection: { config?: { type?: unknown } } | null | undefined,
): boolean => String(connection?.config?.type || '') === 'nacos';

/**
 * Narrow a tree to one dimension.
 *
 * Two invariants, both learned the hard way:
 *
 * 1. A filter must never widen the tree. Anything this function does not
 *    positively recognise as belonging to the dimension is dropped, so a filtered
 *    tree is always a subset of the unfiltered one.
 *
 * 2. A filter must never be silently extended by a filter key it does not know.
 *    `filter` reaches here from persisted UI state and from the active connection,
 *    so a tree of one family can legitimately meet a filter of another — an MQ tree
 *    under `tables`, or a Nacos tree under `views`. Every branch therefore falls
 *    through to "drop this node" rather than assuming its inputs.
 */
export const filterV2ExplorerTreeByKind = (
  nodes: SidebarTreeNode[],
  filter: V2ExplorerFilter,
): SidebarTreeNode[] => {
  if (filter === 'all') return nodes;
  // The `|| []` only matters if the union grows a filter with no table entry: the
  // lookup would yield `undefined`, and while `new Set(undefined)` is legal (an
  // empty set), it would silently drop the entire tree. The table's completeness is
  // asserted in the sibling test file.
  const allowedGroupKeys = new Set(V2_EXPLORER_FILTER_GROUP_KEYS[filter] || []);
  const nacosFilter = isNacosFilter(filter);
  const objectTypeMatches = (node: SidebarTreeNode): boolean => {
    if (filter === 'tables') return node.type === 'table';
    if (filter === 'views') return node.type === 'view' || node.type === 'materialized-view';
    if (filter === 'sequences') return node.type === 'sequence';
    if (filter === 'routines') return node.type === 'routine';
    if (filter === 'packages') return node.type === 'package';
    if (filter === 'events') return node.type === 'db-event';
    return false;
  };

  const visit = (node: SidebarTreeNode): SidebarTreeNode | null => {
    if (node.type === 'external-sql-root') {
      return null;
    }
    // Relational filters have no semantic equivalent for a broker. Keep the
    // complete MQ namespace visible instead of making the explorer look empty
    // when the user switches from a database connection with a filter active.
    if (node.type === 'message-namespace') {
      return node;
    }
    if (nacosFilter) {
      if (!NACOS_NODE_TYPES.has(String(node.type))) return null;
      // A namespace is a container: keep it only while it still has a branch.
      if (node.type === 'nacos-namespace') {
        const kept = (node.children || []).map(visit).filter(Boolean) as SidebarTreeNode[];
        return kept.length > 0 ? { ...node, children: kept, isLeaf: false } : null;
      }
      // Each filter keeps its own branch whole. The rows inside one are a single
      // tree the backend already laid out, so pruning further would only invent
      // rules the branch does not have.
      if (filter === 'nacos-services' && node.type === 'nacos-config-entry') return null;
      if (filter === 'nacos-configs' && node.type === 'nacos-services-entry') return null;
      return node;
    }
    const groupKey = String(node?.dataRef?.groupKey || '');
    if (node.type === 'object-group') {
      if (allowedGroupKeys.has(groupKey)) {
        return node;
      }
      if (groupKey === 'schema') {
        if (node.dataRef?.schemaLazy && !node.dataRef?.schemaLoaded) return node;
        const schemaChildren = (node.children || []).map(visit).filter(Boolean) as SidebarTreeNode[];
        return schemaChildren.length > 0 ? { ...node, children: schemaChildren, isLeaf: false } : null;
      }
      return null;
    }
    if (objectTypeMatches(node)) {
      return node;
    }
    if (node.type === 'database') {
      if (!node.children) return node;
      const filteredChildren = (node.children || []).map(visit).filter(Boolean) as SidebarTreeNode[];
      return filteredChildren.length > 0 ? { ...node, children: filteredChildren, isLeaf: false } : null;
    }
    return null;
  };

  return nodes.map(visit).filter(Boolean) as SidebarTreeNode[];
};

/**
 * Decide what the active filter should become for a given family, or null to leave
 * it alone.
 *
 * The filter outlives the connection it was set on, so it has to be reconciled
 * whenever the active host changes family. Leaving a stale one in place is not a
 * cosmetic problem: {@link filterV2ExplorerTreeByKind} narrows a tree to the
 * dimensions it recognises, so a relational filter meeting a Nacos tree — or the
 * reverse — empties the sidebar completely, with no button left to clear it.
 *
 * Note what this asks: "is the current filter one of *this* family's?", not "does
 * this family have filters at all?". Data-source capabilities can answer the
 * latter, but they cannot tell `tables` from `nacos-services`, which is precisely
 * the distinction that decides whether the tree survives.
 */
export const resolveExplorerFilterReset = (
  family: ExplorerFilterFamily | null,
  activeFilter: V2ExplorerFilter,
): V2ExplorerFilter | null => {
  // No family at all (Redis, MQ, or no active host): nothing survives.
  if (!family) return activeFilter === 'all' ? null : 'all';
  return V2_EXPLORER_FILTER_ORDER[family].includes(activeFilter) ? null : 'all';
};

export const buildV2ExplorerFilterOptions = (
  translate: SidebarExplorerFilterTranslate = translateCurrent,
  filterOrder: V2ExplorerFilter[] = V2_EXPLORER_FILTER_ORDER.relational,
): Array<{ key: V2ExplorerFilter; label: string }> => (
  filterOrder.map((key) => ({ key, label: translate(V2_EXPLORER_FILTER_LABEL_KEYS[key]) }))
);

export const V2_EXPLORER_FILTER_OPTIONS: Array<{ key: V2ExplorerFilter; label: string }> = (
  buildV2ExplorerFilterOptions(translateZhCN)
);
