export {
  dedupeSidebarTreeNodesByKey,
  replaceSidebarTreeNodeChildren,
  resolveSidebarTreeVirtualHeight,
  resolveSidebarTreeRowHeight,
  hasSidebarLazyChildren,
  shouldLoadSidebarNodeOnExpand,
} from './sidebar/sidebarV2TreeNodes';
export type { SidebarConnectionState, SidebarTreeNode } from './sidebar/sidebarV2TreeNodes';
export {
  resolveNacosNamespaceDiscoveryModeFromTreeNode,
  buildNacosServicesTabData,
  resolveNacosServicesDoubleClickAction,
} from './sidebar/sidebarV2NacosServices';
export type {
  NacosNamespaceDiscoveryMode,
  NacosServicesDoubleClickAction,
} from './sidebar/sidebarV2NacosServices';
export {
  resolveSidebarTableNameForCopy,
  isSidebarTablePinned,
  buildV2SidebarDatabaseSectionedChildren,
  sortSidebarTableEntries,
  buildV2SidebarTableSectionedChildren,
  buildSidebarTableChildrenForUi,
  formatSidebarRowCount,
} from './sidebar/sidebarV2TableSections';
export {
  isConnectionTagDescendant,
  buildSidebarConnectionTagTree,
  flattenSidebarConnectionTagTree,
  buildV2RailConnectionGroups,
  resolveV2ConnectionGroup,
  getV2RailConnectionGroupBadgeText,
} from './sidebar/sidebarV2ConnectionGroups';
export type {
  V2RailConnectionGroup,
  SidebarConnectionTagTreeItem,
} from './sidebar/sidebarV2ConnectionGroups';
export {
  V2_TREE_HORIZONTAL_SCROLL_BOTTOM_RESERVE,
  parseV2CommandSearchQuery,
  V2_COMMAND_SEARCH_INITIAL_TREE_LIMIT,
  V2_COMMAND_SEARCH_MAX_TREE_RESULTS,
  buildV2CommandSearchTreeIndex,
  filterV2CommandSearchTreeItems,
  shouldRunV2CommandSearchEnter,
  shouldCloseV2CommandSearchOnGlobalKey,
} from './sidebar/sidebarV2CommandSearch';
export type {
  V2CommandSearchItem,
  V2CommandSearchTreeIndexEntry,
  V2CommandSearchMode,
  V2CommandSearchQuery,
  V2CommandSearchEnterState,
  V2CommandSearchGlobalKeyState,
} from './sidebar/sidebarV2CommandSearch';
export {
  resolveSidebarConnectionIdFromKey,
  resolveSidebarConnectionRefreshKeys,
  resolveSidebarNodeConnectionId,
  normalizeSidebarTreeRelativeDropPosition,
  resolveSidebarDropInsertBefore,
  resolveSidebarTreeDropPlacement,
  resolveSidebarHostGroupDropDestination,
  resolveSidebarDropDomHit,
  resolveSidebarDropNodeFromDomEvent,
  resolveSidebarDropTargetMetricsFromDomEvent,
  resolveSidebarTagDropInsertBefore,
  shouldSkipSidebarSelectWhileDragging,
  shouldSkipSidebarLoadOnExpandWhileDragging,
} from './sidebar/sidebarV2TreeDrop';
export type {
  SidebarTreeDropPlacement,
  SidebarHostGroupDropDestination,
  SidebarDropDomHit,
} from './sidebar/sidebarV2TreeDrop';
export {
  collectSidebarSubtreeKeys,
  shouldClearSidebarNodeChildrenOnCollapse,
  resolveSidebarSingleDatabaseExpandedKeys,
  resolveV2ActiveConnectionId,
  resolveV2SelectedDatabaseName,
  resolveSidebarDatabaseTreePruneKeys,
} from './sidebar/sidebarV2TreeExpansion';

export type { SidebarTreeNodeType } from './sidebar/sidebarTreeNodeTypes';

export { isSidebarDatabasePinned, applySidebarDatabasePinning } from './sidebar/sidebarDatabasePinning';

// The filter dimension, its button ordering and the tree-narrowing rules now live
// in `./sidebar/sidebarExplorerFilter`, which this file is too large to keep
// hosting (AGENTS.md §1.1). Re-exported here so existing importers are untouched.
export type { V2ExplorerFilter } from './sidebar/sidebarExplorerFilter';
export {
  buildV2ExplorerFilterOptions,
  V2_EXPLORER_FILTER_OPTIONS,
  V2_EXPLORER_FILTER_LABEL_KEYS,
  filterV2ExplorerTreeByKind,
} from './sidebar/sidebarExplorerFilter';
