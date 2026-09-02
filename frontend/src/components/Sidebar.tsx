import SidebarConnectionRail from './sidebar/SidebarConnectionRail';
import Modal from './common/ResizableDraggableModal';
import TitleBarQuickActions, { type TitleBarQuickAction } from './TitleBarQuickActions';
import { type DataSyncEntryMode } from './dataSyncEntryMode';
import type { DatabaseCharsetOption, DatabaseCollationOption } from '../utils/databaseCharset';
import SidebarSearchPanel, { type SidebarSearchPanelProps } from './sidebar/SidebarSearchPanel';
import { buildSidebarLegacyNodeMenuItems } from './sidebar/sidebarLegacyNodeMenu';
import {
  getMetadataDialect,
  loadSchemas,
  shouldHideSchemaPrefix,
  splitQualifiedName,
} from './sidebar/sidebarMetadataLoaders';
import {
  useSidebarBatchExport,
} from './sidebar/useSidebarBatchExport';
import { SidebarEntityModals } from './sidebar/SidebarEntityModals';
import { SavedQueryGroupModal } from './sidebar/SavedQueryGroupModal';
import DatabaseSchemaVisibilityModal from './sidebar/DatabaseSchemaVisibilityModal';
import type { DatabaseSchemaVisibilityDraft } from './sidebar/databaseSchemaVisibility';
import { renderSidebarV2TreeTitle } from './sidebar/SidebarTreeTitle';
import {
  useSidebarV2ContextMenu,
} from './sidebar/useSidebarV2ContextMenu';
import {
  useSidebarObjectActions,
  type SidebarMessagePublishTarget,
} from './sidebar/useSidebarObjectActions';
import { useSidebarSearchModel } from './sidebar/useSidebarSearchModel';
import { useSidebarFilterPersistence } from './sidebar/useSidebarFilterPersistence';
import { useSidebarV2ActionHandlers } from './sidebar/useSidebarV2ActionHandlers';
import { useSidebarCommandSearchRunner } from './sidebar/useSidebarCommandSearchRunner';
import { useSidebarTitleRender } from './sidebar/useSidebarTitleRender';
import {
  normalizeDriverType,
  useSidebarTreeLoaders,
} from './sidebar/useSidebarTreeLoaders';
export { formatSidebarDriverAgentUpdateWarning } from './sidebar/useSidebarTreeLoaders';
import {
  ExternalSQLBindingModal,
  ExternalSQLFileModal,
  useSidebarExternalSqlWorkflow,
} from './sidebar/SidebarExternalSqlWorkflow';
export {
  buildSQLFileExecutionFooter,
  SQLFileExecutionProgressContent,
} from './sidebar/SidebarExternalSqlWorkflow';
export type {
  SQLFileExecutionProgressState,
  SQLFileExecutionStatus,
} from './sidebar/SidebarExternalSqlWorkflow';
import {
  V2_RAIL_UNGROUPED_CONNECTION_GROUP_ID,
  formatSidebarRowCount,
  hasSidebarLazyChildren,
  shouldClearSidebarActiveContextOnEmptySelect,
  shouldLoadSidebarNodeOnExpand,
  getV2RailConnectionGroupBadgeText,
  resolveSidebarTitlebarObjectName,
  clearSidebarHostConnectionState,
  shouldDeferSidebarTitlebarSelection,
  type V2ExplorerFilter,
} from './sidebar/sidebarHelpers';
// 重新导出，保持外部测试文件的 `from './Sidebar'` 兼容
export {
  V2_RAIL_UNGROUPED_CONNECTION_GROUP_ID,
  formatSidebarRowCount,
  hasSidebarLazyChildren,
  shouldClearSidebarActiveContextOnEmptySelect,
  shouldLoadSidebarNodeOnExpand,
  getV2RailConnectionGroupBadgeText,
  isV2SidebarObjectNode,
  resolveV2ObjectGroupTitle,
  clearSidebarHostConnectionState,
  shouldDeferSidebarTitlebarSelection,
  resolveSidebarTableNameForCopy,
  resolveSidebarDatabaseNameForCopy,
  parseV2CommandSearchQuery,
} from './sidebar/sidebarHelpers';
import React, { useEffect, useLayoutEffect, useState, useMemo, useRef, useCallback, useDeferredValue } from 'react';
import { createPortal } from 'react-dom';
import { Tree, message, Dropdown, MenuProps, Input, Button, Form, Popover, Radio, Select, Tooltip } from 'antd';
import { APP_POPUP_Z_INDEX } from '../utils/overlayZIndex';
import { createSidebarResizeAwareFrameScheduler } from '../utils/sidebarResizeLifecycle';
	import {
	  AppstoreOutlined,
	  AuditOutlined,
	  CaretDownFilled,
	  CloudOutlined,
	  CloudDownloadOutlined,
	  CodeOutlined,
	  DatabaseOutlined,
	  DownloadOutlined,
	  GlobalOutlined,
	  HistoryOutlined,
	  InfoCircleOutlined,
	  TableOutlined,
	  ToolOutlined,
	  SwitcherOutlined,
	  UploadOutlined,
	  ConsoleSqlOutlined,
  HddOutlined,
  FolderOutlined,
  FolderOpenOutlined,
  FileTextOutlined,
  CopyOutlined,
  ExportOutlined,
  FolderAddOutlined,
  SaveOutlined,
  EditOutlined,
  SearchOutlined,
  KeyOutlined,
  ThunderboltOutlined,
  UnorderedListOutlined,
  FunctionOutlined,
  LinkOutlined,
  FileAddOutlined,
  ImportOutlined,
  ReloadOutlined,
  SendOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  CheckSquareOutlined,
  FilterOutlined,
  DashboardOutlined,
  WarningOutlined,
  AimOutlined,
  MoreOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  VerticalAlignTopOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  SkinOutlined,
	} from '@ant-design/icons';
import {
    buildSidebarRootConnectionToken,
    buildSidebarRootTagToken,
    useStore,
} from '../store';
import { buildOverlayWorkbenchTheme } from '../utils/overlayWorkbenchTheme';
import {
    selectRecentSidebarSqlLogs,
    selectSidebarCommandSearchSqlLogs,
} from './sidebar/sidebarSqlLogSelector';
		import { SavedConnection, SavedQuery, SavedQueryGroup, ExternalSQLDirectory, ExternalSQLTreeEntry } from '../types';
import { getDbIcon } from './DatabaseIcons';
		import { ListSQLDirectory } from '../../wailsjs/go/app/App';
import { supportsTableTruncateAction } from './tableDataDangerActions';
  import { EventsOn } from '../../wailsjs/runtime/runtime';
  import { isMacLikePlatform, normalizeOpacityForPlatform, resolveAppearanceValues } from '../utils/appearance';
import { useAutoFetchVisibility } from '../utils/autoFetchVisibility';
import { useWorkbenchTabs } from '../hooks/useWorkbenchTabs';
import FindInDatabaseModal from './FindInDatabaseModal';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { buildSqlAnalysisWorkbenchTab } from '../utils/sqlAnalysisTab';
import { buildSqlAuditWorkbenchTab } from '../utils/sqlAuditTab';
import {
    normalizeSidebarDatabaseListRefreshRequest,
    normalizeSidebarDatabaseRefreshRequest,
    SIDEBAR_DATABASE_LIST_REFRESH_EVENT,
    SIDEBAR_DATABASE_REFRESH_EVENT,
} from '../utils/sidebarDatabaseRefresh';
import { getDataSourceCapabilities, resolveDataSourceType } from '../utils/dataSourceCapabilities';
import { isConnectionStructureEditRestricted } from '../utils/connectionReadOnly';
import { noAutoCapInputProps } from '../utils/inputAutoCap';
import {
  resolveSidebarRuntimeDatabase,
} from '../utils/sidebarMetadata';
import {
  findSidebarNodePathByKey,
  findSidebarNodePathForLocate,
  SIDEBAR_LOCATE_CONNECTION_EVENT,
  normalizeSidebarLocateConnectionRequest,
  normalizeSidebarLocateObjectRequest,
  normalizeSidebarLocateObjectRequestFromTab,
  resolveSidebarLocateTarget,
  type SidebarLocateTreeNodeLike,
} from '../utils/sidebarLocate';
import { resolveConnectionAccentColor, resolveConnectionIconType } from '../utils/connectionVisual';
import {
  getSavedQueryGroupIdFromToken,
  getSavedQueryGroupOwnerIds,
  getSavedQueryIdFromGroupToken,
  isSavedQueryGroupQueryToken,
  isSavedQueryGroupToken,
  normalizeSavedQueryGroups,
  resolveSavedQueryGroupChildOrder,
} from '../utils/savedQueryGroups';
import {
  moveSchemaVisibilityEntry,
  moveSchemaVisibilityRule,
  removeSchemaVisibilityEntry,
  updateSchemaVisibilityRule,
} from '../utils/schemaVisibility';
import {
  moveExactDatabaseVisibilityEntry,
  removeExactDatabaseVisibilityEntry,
} from '../utils/databaseVisibility';
import { buildJVMTabTitle } from '../utils/jvmRuntimePresentation';
import { buildJVMDiagnosticActionDescriptor, buildJVMMonitoringActionDescriptors } from '../utils/jvmSidebarActions';
import {
  DATA_IMPORT_WORKBENCH_TAB_ID,
  resolveDataImportWorkbenchLaunchTab,
  type BuildDataImportWorkbenchTabInput,
} from '../utils/dataImportTab';
import { useExportProgressDialog } from './ExportProgressModal';
import { getShortcutPlatform } from '../utils/shortcuts';
import { buildExternalSQLRootNode, type ExternalSQLTreeNode } from '../utils/externalSqlTree';
import { resolveSidebarTableMetadataFields } from '../utils/sidebarTableMetadata';
import { filterSidebarTreeByHiddenObjectGroups } from '../utils/sidebarObjectVisibility';
import {
  mergeTitlebarSidebarSnapshot,
  type TitlebarSelectionContext,
  type TitlebarSidebarSnapshot,
} from '../utils/titlebarContext';
import { t } from '../i18n';
import MessagePublishModal from './MessagePublishModal';
import {
  SIDEBAR_CONTEXT_MENU_FALLBACK_HEIGHT,
  SIDEBAR_CONTEXT_MENU_FALLBACK_WIDTH,
  resolveSidebarContextMenuPosition,
  type SearchScope,
} from './sidebarCoreUtils';
export { resolveSidebarContextMenuPosition } from './sidebarCoreUtils';
export type { ExternalSQLFileModalMode, SearchScope } from './sidebarCoreUtils';

// Keep the titlebar snapshot synchronous in the browser without emitting an
// SSR warning when the Sidebar is rendered to HTML in tests or web tooling.
const useSidebarLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
import {
  applySidebarDatabasePinning,
  buildSidebarTableChildrenForUi,
  buildSidebarConnectionTagTree,
  buildV2RailConnectionGroups,
  buildV2SidebarDatabaseSectionedChildren,
  buildV2SidebarTableSectionedChildren,
  collectSidebarSubtreeKeys,
  estimateV2TreeHorizontalScrollWidth,
  filterV2CommandSearchTreeItems,
  filterV2ExplorerTreeByKind,
  isSidebarDatabasePinned,
  isSidebarTablePinned,
  isConnectionTagDescendant,
  normalizeSidebarTreeRelativeDropPosition,
  resolveSidebarConnectionIdFromKey,
  resolveSidebarConnectionRefreshKeys,
  resolveSidebarDropDomHit,
  resolveSidebarHostGroupDropDestination,
  resolveSidebarDropInsertBefore,
  resolveSidebarDropNodeFromDomEvent,
  resolveSidebarDropTargetMetricsFromDomEvent,
  resolveSidebarTreeDropPlacement,
  resolveSidebarDatabaseTreePruneKeys,
  resolveSidebarNodeConnectionId,
  resolveSidebarSingleDatabaseExpandedKeys,
  resolveV2ConnectionGroup,
  resolveV2ActiveConnectionId,
  resolveNacosNamespaceDiscoveryModeFromTreeNode,
  resolveNacosServicesDoubleClickAction,
  replaceSidebarTreeNodeChildren,
  shouldClearSidebarNodeChildrenOnCollapse,
  shouldSkipSidebarLoadOnExpandWhileDragging,
  shouldSkipSidebarSelectWhileDragging,
  shouldCloseV2CommandSearchOnGlobalKey,
  shouldRunV2CommandSearchEnter,
  sortSidebarTableEntries,
  type SidebarConnectionState,
  type SidebarTreeDropPlacement,
  type SidebarTreeNode as TreeNode,
  type V2CommandSearchItem,
} from './sidebarV2Utils';

export {
  applySidebarDatabasePinning,
  buildSidebarTableChildrenForUi,
  buildSidebarConnectionTagTree,
  buildV2RailConnectionGroups,
  buildV2SidebarDatabaseSectionedChildren,
  buildV2SidebarTableSectionedChildren,
  collectSidebarSubtreeKeys,
  estimateV2TreeHorizontalScrollWidth,
  filterV2CommandSearchTreeItems,
  filterV2ExplorerTreeByKind,
  isSidebarDatabasePinned,
  isSidebarTablePinned,
  isConnectionTagDescendant,
  normalizeSidebarTreeRelativeDropPosition,
  resolveSidebarConnectionIdFromKey,
  resolveSidebarConnectionRefreshKeys,
  resolveSidebarDropDomHit,
  resolveSidebarHostGroupDropDestination,
  resolveSidebarDropInsertBefore,
  resolveSidebarDropNodeFromDomEvent,
  resolveSidebarDropTargetMetricsFromDomEvent,
  resolveSidebarTreeDropPlacement,
  resolveSidebarDatabaseTreePruneKeys,
  resolveSidebarNodeConnectionId,
  resolveV2ActiveConnectionId,
  shouldClearSidebarNodeChildrenOnCollapse,
  shouldSkipSidebarLoadOnExpandWhileDragging,
  shouldSkipSidebarSelectWhileDragging,
  shouldCloseV2CommandSearchOnGlobalKey,
  shouldRunV2CommandSearchEnter,
  sortSidebarTableEntries,
};
export { resolveSidebarTagDropInsertBefore } from './sidebarV2Utils';
export type { SidebarDropDomHit, SidebarTreeDropPlacement, V2CommandSearchItem, V2RailConnectionGroup } from './sidebarV2Utils';

type SidebarTreeSwitcherNodeLike = {
  key?: React.Key;
  data?: TreeNode;
  isLeaf?: boolean;
  loading?: boolean;
};

export const resolveSidebarSwitcherLoadKey = (node: SidebarTreeSwitcherNodeLike | null | undefined): string | null => {
  const treeNode = node?.data;
  const dataRef = treeNode?.dataRef;
  if (!treeNode) {
    return null;
  }

  if (treeNode.type === 'connection') {
    const connectionId = String(dataRef?.id || treeNode.key || node?.key || '').trim();
    return connectionId ? `dbs-${connectionId}` : null;
  }

  if (treeNode.type === 'database' || treeNode.type === 'message-namespace') {
    const connectionId = String(dataRef?.id || '').trim();
    const dbName = String(dataRef?.dbName || '').trim();
    return connectionId && dbName ? `tables-${connectionId}-${dbName}` : null;
  }

  if (treeNode.type === 'jvm-mode' || treeNode.type === 'jvm-resource') {
    const connectionId = String(dataRef?.id || '').trim();
    const providerMode = String(dataRef?.providerMode || '').trim().toLowerCase();
    const parentPath = treeNode.type === 'jvm-resource' ? String(dataRef?.resourcePath || '').trim() : '';
    return connectionId && providerMode ? `jvm-resources-${connectionId}-${providerMode}-${parentPath}` : null;
  }

  return null;
};

export const shouldKeepSidebarSwitcherCollapsedWhileLoading = (
  node: SidebarTreeSwitcherNodeLike | null | undefined,
  loadingKeys: ReadonlySet<string>,
): boolean => {
  if (!node || node.isLeaf) {
    return false;
  }
  if (node.loading) {
    return true;
  }
  const loadKey = resolveSidebarSwitcherLoadKey(node);
  return !!loadKey && loadingKeys.has(loadKey);
};

const { Search } = Input;
const SIDEBAR_LOCATE_LOAD_WAIT_INTERVAL_MS = 50;
const SIDEBAR_LOCATE_LOAD_WAIT_ATTEMPTS = 160;
const SIDEBAR_CACHED_DATABASE_TREE_LIMIT = 12;
const NACOS_SERVICES_CHANGED_EVENT = 'gonavi:nacos-services-changed';
const SIDEBAR_GROUP_HOVER_EXPAND_DELAY_MS = 500;
const SIDEBAR_TREE_SCROLL_IDLE_DELAY_MS = 2000;

const buildOptionalSchemaContext = (value: unknown): { schemaName?: string } => {
  const schemaName = String(value ?? '').trim();
  return schemaName ? { schemaName } : {};
};

type SidebarTreeDragEventLike = {
  dataTransfer?: DataTransfer | null;
  target?: EventTarget | null;
};

const createSidebarTreeDragPreview = (
  event: SidebarTreeDragEventLike,
  node: Pick<TreeNode, 'title' | 'type'>,
): HTMLElement | null => {
  if (typeof document === 'undefined' || !document.body || !event.dataTransfer) return null;

  const preview = document.createElement('div');
  preview.className = 'gn-v2-sidebar-tree-drag-preview';
  preview.setAttribute('aria-hidden', 'true');
  preview.setAttribute('data-node-type', String(node.type || ''));

  const sourceRow = event.target && typeof (event.target as Element).closest === 'function'
    ? (event.target as Element).closest('.ant-tree-treenode')
    : null;
  const sourceIcon = sourceRow?.querySelector('.ant-tree-iconEle > *');
  const icon = document.createElement('span');
  icon.className = 'gn-v2-sidebar-tree-drag-preview-icon';
  if (sourceIcon) {
    icon.appendChild(sourceIcon.cloneNode(true));
  }
  preview.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'gn-v2-sidebar-tree-drag-preview-label';
  label.textContent = String(node.title || '');
  preview.appendChild(label);
  document.body.appendChild(preview);

  try {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setDragImage(preview, 18, 15);
  } catch {
    preview.remove();
    return null;
  }
  return preview;
};

type NacosServiceRefreshTreeNode = {
  key: React.Key;
  children?: NacosServiceRefreshTreeNode[];
};

export const resolveNacosServiceGroupsRefreshTarget = (
  detail: unknown,
  treeData: readonly NacosServiceRefreshTreeNode[],
  expandedKeys: readonly React.Key[],
): { key: string; node: NacosServiceRefreshTreeNode; shouldReload: boolean } | null => {
  if (!detail || typeof detail !== 'object') return null;
  const eventDetail = detail as Record<string, unknown>;
  const connectionId = String(eventDetail.connectionId || '').trim();
  if (!connectionId) return null;
  const namespaceId = String(eventDetail.namespaceId ?? '').trim();
  const key = `${connectionId}-nacos-ns-${namespaceId || 'public'}-services`;

  const findNode = (nodes: readonly NacosServiceRefreshTreeNode[]): NacosServiceRefreshTreeNode | null => {
    for (const node of nodes) {
      if (String(node.key) === key) return node;
      const child = node.children?.length ? findNode(node.children) : null;
      if (child) return child;
    }
    return null;
  };

  const node = findNode(treeData);
  if (!node) return null;
  return {
    key,
    node,
    shouldReload: expandedKeys.some((expandedKey) => String(expandedKey) === key),
  };
};

// resolveV2ObjectGroupTitle 已迁移到 ./sidebar/sidebarHelpers

// shouldLoadSidebarNodeOnExpand 已迁移到 ./sidebar/sidebarHelpers

// resolveSidebarTableNameForCopy 已迁移到 ./sidebar/sidebarHelpers

const buildConnectionRootQueryTabTitle = () => t('query.new');

const buildConnectionRootRedisCommandTabTitle = (redisDbLabel = 'db0') =>
  t('sidebar.tab.redis_command', { database: redisDbLabel });

const buildConnectionRootRedisMonitorTabTitle = (redisDbLabel = 'db0') =>
  t('sidebar.tab.redis_monitor', { database: redisDbLabel });

const V2_EXPLORER_FILTER_OPTIONS: Array<{ key: V2ExplorerFilter; labelKey: string }> = [
  { key: 'all', labelKey: 'sidebar.command_search.object_kind.all' },
  { key: 'tables', labelKey: 'sidebar.command_search.object_kind.tables' },
  { key: 'views', labelKey: 'sidebar.command_search.object_kind.views' },
  { key: 'sequences', labelKey: 'sidebar.command_search.object_kind.sequences' },
  { key: 'routines', labelKey: 'sidebar.command_search.object_kind.routines' },
  { key: 'packages', labelKey: 'sidebar.command_search.object_kind.packages' },
  { key: 'events', labelKey: 'sidebar.command_search.object_kind.events' },
];

const buildConnectionReloadSignature = (conn?: SavedConnection | null): string => {
  if (!conn) return '';
  return JSON.stringify({
    config: conn.config || {},
    includeDatabases: conn.includeDatabases || [],
    includeDatabasePatterns: conn.includeDatabasePatterns || [],
    excludeDatabasePatterns: conn.excludeDatabasePatterns || [],
    includeRedisDatabases: conn.includeRedisDatabases || [],
    schemaVisibilityByDatabase: conn.schemaVisibilityByDatabase || {},
  });
};

const isConnectionTreeKey = (key: React.Key, connectionId: string): boolean => {
  const text = String(key);
  return text === connectionId || text.startsWith(`${connectionId}-`);
};

const isPostgresSchemaDialect = (dialect: string): boolean => (
  ['postgres', 'kingbase', 'highgo', 'vastbase', 'opengauss'].includes(normalizeDriverType(dialect))
);

const isSavedQueryUnmatchedForConnectionIds = (query: SavedQuery, connectionIds: Set<string>): boolean => (
  query.bindingStatus === 'orphan' || !connectionIds.has(query.connectionId)
);

export const buildAllSavedQueriesTreeNode = (
  savedQueries: SavedQuery[],
  connections: SavedConnection[],
  savedQueryGroups: SavedQueryGroup[] = [],
): TreeNode | null => {
  const normalizedGroups = normalizeSavedQueryGroups(
    savedQueryGroups,
    savedQueries.map((query) => query.id),
  );
  if (savedQueries.length === 0 && normalizedGroups.length === 0) {
      return null;
  }

  const createQueryNode = (query: SavedQuery): TreeNode => ({
      title: query.name || t('sidebar.tree.untitled_query'),
      key: `all-saved-query-${query.id}`,
      icon: <FileTextOutlined />,
      type: 'saved-query',
      dataRef: query,
      isLeaf: true,
  });
  const buildDatabaseGroups = (queries: SavedQuery[], keyPrefix: string): TreeNode[] => {
      const groupedByDatabase = new Map<string, SavedQuery[]>();
      queries.forEach((query) => {
          const dbName = String(query.dbName || '').trim() || t('sidebar.tree.default_database');
          groupedByDatabase.set(dbName, [...(groupedByDatabase.get(dbName) || []), query]);
      });
      return Array.from(groupedByDatabase.entries()).map(([dbName, items]) => ({
          title: dbName,
          key: `${keyPrefix}-db-${encodeURIComponent(dbName)}`,
          icon: <DatabaseOutlined />,
          type: 'saved-query-group',
          selectable: false,
          isLeaf: false,
          children: items.map(createQueryNode),
      }));
  };

  const buildAutomaticChildren = (queries: SavedQuery[]): TreeNode[] => {
      const connectionIds = new Set(connections.map((conn) => conn.id));
      const unmatchedSavedQueries = queries.filter((query) => isSavedQueryUnmatchedForConnectionIds(query, connectionIds));
      const unmatchedIds = new Set(unmatchedSavedQueries.map((query) => query.id));
      const groupedByConnection = new Map<string, SavedQuery[]>();
      queries.forEach((query) => {
          if (unmatchedIds.has(query.id)) return;
          groupedByConnection.set(query.connectionId, [
              ...(groupedByConnection.get(query.connectionId) || []),
              query,
          ]);
      });

      const automaticChildren: TreeNode[] = [];
      connections.forEach((conn) => {
          const connectionQueries = groupedByConnection.get(conn.id);
          if (!connectionQueries || connectionQueries.length === 0) return;
          const iconType = resolveConnectionIconType(conn);
          const iconColor = resolveConnectionAccentColor(conn);
          automaticChildren.push({
              title: conn.name || conn.id,
              key: `all-saved-queries-connection-${conn.id}`,
              icon: getDbIcon(iconType, iconColor, 22),
              type: 'saved-query-group',
              selectable: false,
              isLeaf: false,
              children: buildDatabaseGroups(connectionQueries, `all-saved-queries-connection-${conn.id}`),
          });
      });

      if (unmatchedSavedQueries.length > 0) {
          const groupedByOriginalConnection = new Map<string, SavedQuery[]>();
          unmatchedSavedQueries.forEach((query) => {
              const originalConnectionId = String(query.originalConnectionId || query.connectionId || t('sidebar.tree.unknown_connection')).trim() || t('sidebar.tree.unknown_connection');
              groupedByOriginalConnection.set(originalConnectionId, [
                  ...(groupedByOriginalConnection.get(originalConnectionId) || []),
                  query,
              ]);
          });
          automaticChildren.push({
              title: t('sidebar.tree.unmatched_saved_queries'),
              key: 'all-saved-queries-unmatched',
              icon: <WarningOutlined />,
              type: 'saved-query-group',
              selectable: false,
              isLeaf: false,
              children: Array.from(groupedByOriginalConnection.entries()).map(([connectionLabel, items]) => ({
                  title: connectionLabel,
                  key: `all-saved-queries-unmatched-${encodeURIComponent(connectionLabel)}`,
                  icon: <FolderOpenOutlined />,
                  type: 'saved-query-group',
                  selectable: false,
                  isLeaf: false,
                  children: buildDatabaseGroups(items, `all-saved-queries-unmatched-${encodeURIComponent(connectionLabel)}`),
              })),
          });
      }
      return automaticChildren;
  };

  const queryById = new Map(savedQueries.map((query) => [query.id, query]));
  const groupById = new Map(normalizedGroups.map((group) => [group.id, group]));
  const groupOwners = getSavedQueryGroupOwnerIds(normalizedGroups);
  const buildManualGroupNode = (group: SavedQueryGroup, ancestors = new Set<string>()): TreeNode => {
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(group.id);
      const children = resolveSavedQueryGroupChildOrder(group.id, normalizedGroups).flatMap((token): TreeNode[] => {
          if (isSavedQueryGroupQueryToken(token)) {
              const query = queryById.get(getSavedQueryIdFromGroupToken(token));
              return query ? [createQueryNode(query)] : [];
          }
          if (isSavedQueryGroupToken(token)) {
              const childGroupId = getSavedQueryGroupIdFromToken(token);
              const childGroup = groupById.get(childGroupId);
              if (!childGroup || childGroup.parentGroupId !== group.id || nextAncestors.has(childGroup.id)) return [];
              return [buildManualGroupNode(childGroup, nextAncestors)];
          }
          return [];
      });
      return {
          title: group.name || t('sidebar.saved_query_group.untitled'),
          key: `saved-query-manual-group-${group.id}`,
          icon: <FolderOutlined />,
          type: 'saved-query-manual-group',
          dataRef: group,
          selectable: false,
          isLeaf: false,
          children,
      };
  };

  const automaticChildren = buildAutomaticChildren(
      savedQueries.filter((query) => !groupOwners.has(query.id)),
  );
  const children: TreeNode[] = normalizedGroups
      .filter((group) => !group.parentGroupId)
      .map((group) => buildManualGroupNode(group));

  if (normalizedGroups.length === 0) {
      children.push(...automaticChildren);
  } else if (automaticChildren.length > 0) {
      children.push({
          title: t('sidebar.tree.ungrouped_saved_queries'),
          key: 'all-saved-queries-ungrouped',
          icon: <FolderOpenOutlined />,
          type: 'saved-query-group',
          selectable: false,
          isLeaf: false,
          children: automaticChildren,
      });
  }

  return {
      title: t('sidebar.tree.all_saved_queries'),
      key: 'all-saved-queries',
      icon: <FolderOpenOutlined />,
      type: 'all-saved-queries',
      isLeaf: false,
      selectable: false,
      children,
  };
};

export type V2ExplorerContext = {
  active: boolean;
  connectionName: string;
  databaseName: string;
  objectName: string;
  tooltip: string;
};

export const V2ExplorerContextSummary: React.FC<{ context: V2ExplorerContext }> = ({ context }) => (
  <Tooltip
    title={(
      <div
        className="gn-v2-explorer-context-tooltip"
        data-sidebar-active-context-tooltip="true"
      >
        <strong
          className="gn-v2-explorer-context-tooltip-line is-connection"
          data-sidebar-active-context-tooltip-field="connection"
        >
          {context.connectionName}
        </strong>
        <span
          className="gn-v2-explorer-context-tooltip-line is-database"
          data-sidebar-active-context-tooltip-field="database"
        >
          {context.databaseName}
        </span>
        <span
          className="gn-v2-explorer-context-tooltip-line is-object"
          data-sidebar-active-context-tooltip-field="object"
        >
          {context.objectName}
        </span>
      </div>
    )}
    placement="bottomLeft"
    mouseEnterDelay={0.35}
    rootClassName="gn-v2-explorer-context-tooltip-popup"
  >
    <div
      className="gn-v2-explorer-context"
      data-sidebar-active-context-summary="true"
      data-sidebar-active-context={context.active ? 'true' : 'false'}
      data-sidebar-active-context-depth={context.objectName ? 'object' : context.databaseName ? 'database' : 'connection'}
      aria-label={context.tooltip}
    >
      <span className="gn-v2-explorer-context-copy">
        <strong
          className="gn-v2-explorer-context-line is-connection"
          data-sidebar-active-context-field="connection"
        >
          {context.connectionName}
        </strong>
        <span
          className="gn-v2-explorer-context-line is-database"
          data-sidebar-active-context-field="database"
        >
          {context.databaseName}
        </span>
        <span
          className="gn-v2-explorer-context-line is-object"
          data-sidebar-active-context-field="object"
        >
          {context.objectName}
        </span>
      </span>
    </div>
  </Tooltip>
);

export type V2ExplorerToolbarActionLabels = {
  objectActions: string;
  locateCurrentTable: string;
  locateCurrentTableUnavailable: string;
  scrollToTop: string;
  connectionActions: string;
  systemActions: string;
  aiAssistant: string;
  settings: string;
};

export type V2ExplorerToolbarToggleAction = {
  label: string;
  onClick: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  placement: 'explorer-toolbar' | 'collapsed-titlebar';
  expanded: boolean;
};

export const V2ExplorerToolbarActions: React.FC<{
  labels: V2ExplorerToolbarActionLabels;
  canLocateActiveTab: boolean;
  hasActiveConnection: boolean;
  aiActive: boolean;
  onLocateCurrentTable: () => void;
  onScrollToTop: () => void;
  onOpenConnectionActions: (event: React.MouseEvent<HTMLElement>) => void;
  onToggleAI?: () => void;
  onOpenSettings?: () => void;
  toggleAction?: V2ExplorerToolbarToggleAction;
}> = ({
  labels,
  canLocateActiveTab,
  hasActiveConnection,
  aiActive,
  onLocateCurrentTable,
  onScrollToTop,
  onOpenConnectionActions,
  onToggleAI,
  onOpenSettings,
  toggleAction,
}) => (
  <>
    <div className="gn-v2-explorer-action-group is-navigation" role="group" aria-label={labels.objectActions}>
      <Tooltip
        title={canLocateActiveTab ? labels.locateCurrentTable : labels.locateCurrentTableUnavailable}
        placement="bottom"
        mouseEnterDelay={0.35}
      >
        <span
          className="gn-v2-explorer-action-wrap"
          tabIndex={canLocateActiveTab ? undefined : 0}
          aria-label={canLocateActiveTab ? undefined : labels.locateCurrentTableUnavailable}
        >
          <Button
            size="small"
            type="text"
            className="gn-v2-explorer-tool"
            icon={<AimOutlined />}
            aria-label={labels.locateCurrentTable}
            data-sidebar-locate-current-tab-action="true"
            disabled={!canLocateActiveTab}
            onClick={onLocateCurrentTable}
          />
        </span>
      </Tooltip>
      <Tooltip title={labels.scrollToTop} placement="bottom" mouseEnterDelay={0.35}>
        <Button
          size="small"
          type="text"
          className="gn-v2-explorer-tool"
          icon={<VerticalAlignTopOutlined />}
          aria-label={labels.scrollToTop}
          data-sidebar-scroll-to-top-action="true"
          onClick={onScrollToTop}
        />
      </Tooltip>
    </div>
    <div className="gn-v2-explorer-action-group is-connection" role="group" aria-label={labels.connectionActions}>
      <Tooltip title={labels.connectionActions} placement="bottom" mouseEnterDelay={0.35}>
        <span
          className="gn-v2-explorer-action-wrap"
          tabIndex={hasActiveConnection ? undefined : 0}
          aria-label={hasActiveConnection ? undefined : labels.connectionActions}
        >
          <Button
            size="small"
            type="text"
            className="gn-v2-explorer-tool"
            icon={<MoreOutlined />}
            aria-label={labels.connectionActions}
            aria-haspopup="menu"
            data-sidebar-active-connection-actions="true"
            disabled={!hasActiveConnection}
            onClick={onOpenConnectionActions}
          />
        </span>
      </Tooltip>
    </div>
    <div className="gn-v2-explorer-action-group is-system" role="group" aria-label={labels.systemActions}>
      <Tooltip title={labels.aiAssistant} placement="bottom" mouseEnterDelay={0.35}>
        <Button
          size="small"
          type="text"
          className={`gn-v2-explorer-tool${aiActive ? ' is-active' : ''}`}
          icon={<RobotOutlined />}
          aria-label={labels.aiAssistant}
          aria-pressed={aiActive}
          data-gonavi-ai-entry-action="true"
          onClick={onToggleAI}
        />
      </Tooltip>
      <Tooltip title={labels.settings} placement="bottom" mouseEnterDelay={0.35}>
        <Button
          size="small"
          type="text"
          className="gn-v2-explorer-tool"
          icon={<SettingOutlined />}
          aria-label={labels.settings}
          data-sidebar-settings-action="true"
          onClick={onOpenSettings}
        />
      </Tooltip>
    </div>
    {toggleAction && (
      <Tooltip title={toggleAction.label} placement="bottom" mouseEnterDelay={0.35}>
        <Button
          ref={toggleAction.buttonRef}
          size="small"
          type="text"
          className="gonavi-sidebar-collapse-trigger gn-v2-explorer-tool"
          data-sidebar-collapse-trigger="true"
          data-sidebar-toggle-placement={toggleAction.placement}
          aria-label={toggleAction.label}
          aria-controls="gonavi-sidebar-tree-panel"
          aria-expanded={toggleAction.expanded}
          icon={toggleAction.expanded ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
          onClick={toggleAction.onClick}
        />
      </Tooltip>
    )}
  </>
);

const Sidebar: React.FC<{
  onCreateConnection?: () => void;
  onCreateConnectionInGroup?: (targetTagId: string) => void;
  onEditConnection?: (conn: SavedConnection) => void;
  onOpenSettings?: () => void;
  /**
   * Open a settings-center group/pane, tool-center entry, or run a settings action
   * (import/export connections, data-sync, sql audit). Mirrors 设置 left-nav groups.
   */
  onOpenSettingsNavigation?: (spec: {
    group: 'preferences' | 'services' | 'config' | 'workflow' | 'workspace' | 'about';
    pane?: string;
    action?: 'import-connections' | 'export-connections' | 'schema-compare' | 'data-compare' | 'sync' | 'sql-audit';
  }) => void;
  /** Whether web-only settings entries (e.g. browser auth) should appear. */
  isWebRuntime?: boolean;
  onOpenDataSyncWorkbench?: (entryMode: DataSyncEntryMode) => void;
  onToggleAI?: () => void;
  onToggleLogPanel?: () => void;
  uiVersion?: 'legacy' | 'v2';
  v2ExplorerContext?: V2ExplorerContext;
  collapsedSidebarActionsTarget?: HTMLElement | null;
  onTitlebarSnapshotChange?: (snapshot: React.SetStateAction<TitlebarSidebarSnapshot>) => void;
  onFocusCommandSearch?: () => void;
  onCollapseSidebar?: () => void;
  onExpandSidebar?: () => void;
  /** Expands a collapsed explorer before a locate request changes its selection. */
  onEnsureSidebarExpanded?: () => void;
  collapseSidebarLabel?: string;
  collapseSidebarButtonRef?: React.Ref<HTMLButtonElement>;
  expandSidebarLabel?: string;
  expandSidebarButtonRef?: React.Ref<HTMLButtonElement>;
}> = React.memo(({
  onCreateConnection,
  onCreateConnectionInGroup,
  onEditConnection,
  onOpenSettings,
  onOpenSettingsNavigation,
  isWebRuntime = false,
  onOpenDataSyncWorkbench,
  onToggleAI,
  onToggleLogPanel,
  uiVersion,
  v2ExplorerContext,
  collapsedSidebarActionsTarget,
  onTitlebarSnapshotChange,
  onFocusCommandSearch,
  onCollapseSidebar,
  onExpandSidebar,
  onEnsureSidebarExpanded,
  collapseSidebarLabel,
  collapseSidebarButtonRef,
  expandSidebarLabel,
  expandSidebarButtonRef,
}) => {
  const connections = useStore(state => state.connections);
  const savedQueries = useStore(state => state.savedQueries);
  const savedQueryGroups = useStore(state => state.savedQueryGroups);
  const externalSQLDirectories = useStore(state => state.externalSQLDirectories);
  const saveQuery = useStore(state => state.saveQuery);
  const deleteQuery = useStore(state => state.deleteQuery);
  const saveSavedQueryGroup = useStore(state => state.saveSavedQueryGroup);
  const deleteSavedQueryGroup = useStore(state => state.deleteSavedQueryGroup);
  const moveSavedQueryToGroup = useStore(state => state.moveSavedQueryToGroup);
  const reloadSavedQueryGroups = useStore(state => state.reloadSavedQueryGroups);
  const saveExternalSQLDirectory = useStore(state => state.saveExternalSQLDirectory);
  const deleteExternalSQLDirectory = useStore(state => state.deleteExternalSQLDirectory);
  const updateRecentSQLFilePath = useStore(state => state.updateRecentSQLFilePath);
  const removeRecentSQLFilesByPath = useStore(state => state.removeRecentSQLFilesByPath);
  const moveRecentSQLFilesByDirectory = useStore(state => state.moveRecentSQLFilesByDirectory);
  const removeRecentSQLFilesByDirectory = useStore(state => state.removeRecentSQLFilesByDirectory);
  const addConnection = useStore(state => state.addConnection);
  const updateConnection = useStore(state => state.updateConnection);
  const addTab = useStore(state => state.addTab);
  const updateQueryTabDraft = useStore(state => state.updateQueryTabDraft);
  const tabs = useWorkbenchTabs();
  const activeTabId = useStore(state => state.activeTabId);
  const setActiveContext = useStore(state => state.setActiveContext);
  const removeConnection = useStore(state => state.removeConnection);
  const connectionTags = useStore(state => state.connectionTags);
  const sidebarRootOrder = useStore(state => state.sidebarRootOrder);
  const rootSortMode = useStore(state => state.rootSortMode);
  const rootConnectionSortMode = useStore(state => state.rootConnectionSortMode);
  const addConnectionTag = useStore(state => state.addConnectionTag);
  const updateConnectionTag = useStore(state => state.updateConnectionTag);
  const removeConnectionTag = useStore(state => state.removeConnectionTag);
  const moveConnectionToTag = useStore(state => state.moveConnectionToTag);
  const moveConnectionTag = useStore(state => state.moveConnectionTag);
  const closeTabsByConnection = useStore(state => state.closeTabsByConnection);
  const closeTabsByDatabase = useStore(state => state.closeTabsByDatabase);
  const theme = useStore(state => state.theme);
  const appearance = useStore(state => state.appearance);
  const activeContext = useStore(state => state.activeContext);
  const tableAccessCount = useStore(state => state.tableAccessCount);
  const tableSortPreference = useStore(state => state.tableSortPreference);
  const pinnedSidebarTables = useStore(state => state.pinnedSidebarTables);
  const pinnedSidebarDatabases = useStore(state => state.pinnedSidebarDatabases);
  const recordTableAccess = useStore(state => state.recordTableAccess);
  const setTableSortPreference = useStore(state => state.setTableSortPreference);
  const setSidebarTablePinned = useStore(state => state.setSidebarTablePinned);
  const setSidebarDatabasePinned = useStore(state => state.setSidebarDatabasePinned);
  const queryOptions = useStore(state => state.queryOptions);
  const setQueryOptions = useStore(state => state.setQueryOptions);
  const addSqlLog = useStore(state => state.addSqlLog);
  const hideSqlLogFromRecent = useStore(state => state.hideSqlLogFromRecent);
  const clearRecentSqlLogs = useStore(state => state.clearRecentSqlLogs);
  const shortcutOptions = useStore(state => state.shortcutOptions);
  const languagePreference = useStore(state => state.languagePreference);
  const setAppearance = useStore(state => state.setAppearance);
  const aiPanelVisible = useStore(state => state.aiPanelVisible);
  const setAIPanelVisible = useStore(state => state.setAIPanelVisible);
  const addAIContext = useStore(state => state.addAIContext);
  void languagePreference;
  const darkMode = theme === 'dark';
  const resolvedAppearance = resolveAppearanceValues(appearance);
  const opacity = normalizeOpacityForPlatform(resolvedAppearance.opacity);
  const sidebarTableMetadataFields = useMemo(
      () => resolveSidebarTableMetadataFields(
          queryOptions?.sidebarTableMetadataFields,
          queryOptions?.showSidebarTableComment === true,
          queryOptions?.sidebarTableMetadataFieldOrder,
      ),
      [queryOptions?.showSidebarTableComment, queryOptions?.sidebarTableMetadataFieldOrder, queryOptions?.sidebarTableMetadataFields],
  );
  const { exportProgressModal, runExportWithProgress } = useExportProgressDialog();
  const disableLocalBackdropFilter = isMacLikePlatform();
  const autoFetchVisible = useAutoFetchVisibility();
  const activeShortcutPlatform = getShortcutPlatform(isMacLikePlatform());
  const isV2Ui = (uiVersion ?? appearance.uiVersion) === 'v2';
  const [treeData, setTreeData] = useState<TreeNode[]>([]);
  const activeTab = useMemo(() => tabs.find(tab => tab.id === activeTabId) || null, [tabs, activeTabId]);
  const activeTabHasConnection = useMemo(
    () => Boolean(
      activeTab?.connectionId
      && connections.some((connection) => connection.id === activeTab.connectionId),
    ),
    [activeTab?.connectionId, connections],
  );
  const activeTabLocateRequest = useMemo(() => normalizeSidebarLocateObjectRequestFromTab(activeTab), [activeTab]);
  const canLocateActiveTab = !!activeTabLocateRequest;

  // Background Helper (Duplicate logic for now, ideally shared)
  const getBg = (darkHex: string) => {
      if (!darkMode) return `rgba(255, 255, 255, ${opacity})`;
      const hex = darkHex.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  };
  const bgMain = getBg('#141414');
  const overlayTheme = useMemo(
      () => buildOverlayWorkbenchTheme(darkMode, {
          disableBackdropFilter: disableLocalBackdropFilter,
          uiVersion: isV2Ui ? 'v2' : 'legacy',
      }),
      [darkMode, disableLocalBackdropFilter, isV2Ui],
  );
  const modalPanelStyle = useMemo(() => ({
      background: overlayTheme.shellBg,
      border: overlayTheme.shellBorder,
      boxShadow: overlayTheme.shellShadow,
      backdropFilter: overlayTheme.shellBackdropFilter,
  }), [overlayTheme]);
  const modalSectionStyle = useMemo(() => ({
      padding: 14,
      borderRadius: 14,
      border: overlayTheme.sectionBorder,
      background: overlayTheme.sectionBg,
  }), [overlayTheme]);
  const modalScrollSectionStyle = useMemo(() => ({
      maxHeight: 400,
      overflow: 'auto' as const,
      border: overlayTheme.sectionBorder,
      borderRadius: 14,
      padding: 12,
      background: overlayTheme.sectionBg,
  }), [overlayTheme]);
  const modalHintTextStyle = useMemo(() => ({
      color: overlayTheme.mutedText,
      fontSize: 12,
      lineHeight: 1.6,
  }), [overlayTheme]);
  const renderSidebarModalTitle = (icon: React.ReactNode, title: string, description: string) => (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ width: 34, height: 34, borderRadius: 12, display: 'grid', placeItems: 'center', background: overlayTheme.iconBg, color: overlayTheme.iconColor, flexShrink: 0 }}>
              {icon}
          </div>
          <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: overlayTheme.titleText }}>{title}</div>
              <div style={{ marginTop: 4, color: overlayTheme.mutedText, fontSize: 12, lineHeight: 1.6 }}>{description}</div>
          </div>
      </div>
  );
  const v2SidebarSearchMode = appearance.v2SidebarSearchMode ?? 'command';
  const v2UseLegacySidebarFilter = isV2Ui && v2SidebarSearchMode === 'filter';
  const v2PersistedSidebarFilter = appearance.v2SidebarPersistedFilter ?? '';
  const tableDoubleClickAction = appearance.tableDoubleClickAction === 'open-design' ? 'open-design' : 'open-data';
  const sidebarSingleDatabaseExpansion = appearance.sidebarSingleDatabaseExpansion === true;
  const [searchValue, setSearchValue] = useState(
      v2UseLegacySidebarFilter ? v2PersistedSidebarFilter : '',
  );
  const deferredSearchValue = useDeferredValue(searchValue);
  const [searchScopes, setSearchScopes] = useState<SearchScope[]>(['smart']);
  const [v2ExplorerFilter, setV2ExplorerFilter] = useState<V2ExplorerFilter>('all');
  const [isSearchScopePopoverOpen, setIsSearchScopePopoverOpen] = useState(false);
  const searchInputRef = useRef<any>(null);
  const commandSearchInputRef = useRef<any>(null);
  const [isV2CommandSearchOpen, setIsV2CommandSearchOpen] = useState(false);
  const commandSearchSqlLogs = useStore(
      state => selectSidebarCommandSearchSqlLogs(state, isV2Ui && isV2CommandSearchOpen),
  );
  const recentSqlLogs = useMemo(
      () => selectRecentSidebarSqlLogs(commandSearchSqlLogs),
      [commandSearchSqlLogs],
  );
  const [v2CommandSearchValue, setV2CommandSearchValue] = useState('');
  const deferredV2CommandSearchValue = useDeferredValue(v2CommandSearchValue);
  const [v2CommandActiveIndex, setV2CommandActiveIndex] = useState(0);
  const [expandedKeys, setExpandedKeysState] = useState<React.Key[]>([]);
  const expandedKeysRef = useRef<React.Key[]>([]);
  const [autoExpandParent, setAutoExpandParent] = useState(true);
  const [loadedKeys, setLoadedKeys] = useState<React.Key[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const selectedSidebarKeyRef = useRef('');
  const setSidebarSelectedKeys = useCallback((
      action: React.SetStateAction<React.Key[]>,
  ) => {
      if (typeof action === 'function') {
          setSelectedKeys((previous) => {
              const next = action(previous);
              selectedSidebarKeyRef.current = String(next[0] ?? '').trim();
              return next;
          });
          return;
      }
      selectedSidebarKeyRef.current = String(action[0] ?? '').trim();
      setSelectedKeys(action);
  }, []);
  const selectedNodesRef = useRef<any[]>([]);
  const loadingNodesRef = useRef<Set<string>>(new Set());
  const databaseTreeTouchedAtRef = useRef<Record<string, number>>({});
  const pruneLoadedDatabaseTreesRef = useRef<() => void>(() => {});
  const refreshConnectionResourcesRef = useRef<(node: any) => Promise<void>>(async () => {});
  const loadNacosServiceGroupsRef = useRef<(
      node: any,
      options?: { force?: boolean },
  ) => Promise<boolean>>(async () => false);
  const replaceTreeNodeChildrenRef = useRef<(
      key: React.Key,
      children: TreeNode[] | undefined,
      dataRef?: unknown,
  ) => TreeNode[]>(() => []);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const treeDragSelectSuppressUntilRef = useRef(0);
  const treeDragSelectionSnapshotRef = useRef<{
      selectedKeys: React.Key[];
      selectedNodes: any[];
      activeContext: { connectionId: string; dbName: string; schemaName?: string; tableName?: string } | null;
  }>({
      selectedKeys: [],
      selectedNodes: [],
      activeContext: null,
  });
  const connectionReloadSignaturesRef = useRef<Record<string, string>>({});
  const invalidateConnectionLoadsRef = useRef<(connectionId: string) => void>(() => {});
  expandedKeysRef.current = expandedKeys;
  const connectionIds = useMemo(() => connections.map((conn) => conn.id), [connections]);
  const queryCapableConnectionIds = useMemo(
      () => new Set(
          connections
              .filter((conn) => getDataSourceCapabilities(conn.config).supportsQueryEditor)
              .map((conn) => conn.id),
      ),
      [connections],
  );
  const connectionIdSet = useMemo(() => new Set(connectionIds), [connectionIds]);
  const unmatchedSavedQueries = useMemo(
      () => savedQueries.filter((query) => isSavedQueryUnmatchedForConnectionIds(query, connectionIdSet)),
      [connectionIdSet, savedQueries],
  );
  const allSavedQueriesNode = useMemo<TreeNode | null>(() => {
      return buildAllSavedQueriesTreeNode(savedQueries, connections, savedQueryGroups);
  }, [connections, savedQueries, savedQueryGroups]);
  const sidebarHiddenObjectGroups = appearance.sidebarHiddenObjectGroups;
  const visibleSidebarTreeData = useMemo(
      () => filterSidebarTreeByHiddenObjectGroups(treeData, sidebarHiddenObjectGroups),
      [sidebarHiddenObjectGroups, treeData],
  );
  const sidebarObjectVisibilitySignature = sidebarHiddenObjectGroups.join('|') || 'all';
  const snapshotTreeSelectionBeforeDrag = useCallback(() => {
      treeDragSelectionSnapshotRef.current = {
          selectedKeys: [...selectedKeys],
          selectedNodes: [...selectedNodesRef.current],
          activeContext: activeContext ? { ...activeContext } : null,
      };
  }, [activeContext, selectedKeys]);

  const restoreTreeSelectionAfterDrag = useCallback(() => {
      const snapshot = treeDragSelectionSnapshotRef.current;
      treeDragSelectSuppressUntilRef.current = Date.now() + 1000;
      setSidebarSelectedKeys(snapshot.selectedKeys);
      selectedNodesRef.current = snapshot.selectedNodes;
      setActiveContext(snapshot.activeContext);
  }, [setActiveContext, setSidebarSelectedKeys]);

  const openV2CommandSearch = useCallback(() => {
      pruneLoadedDatabaseTreesRef.current();
      setIsV2CommandSearchOpen(true);
      setV2CommandActiveIndex(0);
  }, []);

  const closeV2CommandSearch = useCallback(() => {
      setIsV2CommandSearchOpen(false);
      setV2CommandSearchValue('');
      setV2CommandActiveIndex(0);
  }, []);

  useEffect(() => {
      setSearchValue(v2UseLegacySidebarFilter ? v2PersistedSidebarFilter : '');
  }, [v2PersistedSidebarFilter, v2UseLegacySidebarFilter]);

  const persistV2SidebarFilter = useCallback((nextFilter: string) => {
      setAppearance({ v2SidebarPersistedFilter: nextFilter });
  }, [setAppearance]);

  useSidebarFilterPersistence({
      enabled: v2UseLegacySidebarFilter,
      searchValue,
      persistedFilter: v2PersistedSidebarFilter,
      onPersist: persistV2SidebarFilter,
  });

  const handleV2CommandSearchValueChange = useCallback((value: string) => {
      setV2CommandSearchValue(value);
  }, []);

  const resetV2SidebarFilter = useCallback(() => {
      setSearchValue('');
      setAppearance({ v2SidebarPersistedFilter: '' });
      message.success(t('sidebar.message.sidebar_filter_reset'));
  }, [setAppearance]);
  
  // Virtual Scroll State
  const [treeHeight, setTreeHeight] = useState(500);
  const [treeViewportWidth, setTreeViewportWidth] = useState(0);
  const [isTreeScrolling, setIsTreeScrolling] = useState(false);
  const treeContainerRef = useRef<HTMLDivElement>(null);
  const treeScrollIdleTimerRef = useRef<number | null>(null);
  const treeRef = useRef<any>(null);
  const sidebarTreeScrollRequestIdRef = useRef(0);
  const [sidebarTreeScrollRequest, setSidebarTreeScrollRequest] = useState<{
      id: number;
      key: React.Key;
      scrollBlock: 'nearest' | 'center';
  } | null>(null);
  const treeDataRef = useRef<TreeNode[]>([]);
  const externalSQLDirectoryTreesRef = useRef<Record<string, ExternalSQLTreeEntry[]>>({});
  const findTreeNodeByKeyRef = useRef<(nodes: TreeNode[], targetKey: React.Key) => TreeNode | null>(() => null);
  const expandConnectionFromRailRef = useRef<(connectionId: string) => void>(() => {});
  const setExpandedKeys = useCallback<React.Dispatch<React.SetStateAction<React.Key[]>>>((update) => {
      setExpandedKeysState((previousExpandedKeys) => {
          const nextExpandedKeys = typeof update === 'function'
              ? update(previousExpandedKeys)
              : update;
          if (!sidebarSingleDatabaseExpansion) {
              return nextExpandedKeys;
          }
          return resolveSidebarSingleDatabaseExpandedKeys({
              previousExpandedKeys,
              nextExpandedKeys,
              treeData: treeDataRef.current,
          });
      });
  }, [sidebarSingleDatabaseExpansion]);
  useEffect(() => {
      treeDataRef.current = treeData;
  }, [treeData]);

  useEffect(() => {
      if (!sidebarSingleDatabaseExpansion) return;
      setExpandedKeysState((previousExpandedKeys) => resolveSidebarSingleDatabaseExpandedKeys({
          previousExpandedKeys,
          nextExpandedKeys: previousExpandedKeys,
          treeData: treeDataRef.current,
      }));
  }, [sidebarSingleDatabaseExpansion]);

  useEffect(() => {
      if (!treeContainerRef.current) return;
      const scheduler = createSidebarResizeAwareFrameScheduler(() => {
          const target = treeContainerRef.current;
          if (!target) return;
          const rect = target.getBoundingClientRect();
          setTreeHeight((current) => current === rect.height ? current : rect.height);
          setTreeViewportWidth((current) => current === rect.width ? current : rect.width);
      });
      const resizeObserver = new ResizeObserver(() => scheduler.schedule());
      resizeObserver.observe(treeContainerRef.current);
      scheduler.schedule();
      return () => {
          resizeObserver.disconnect();
          scheduler.dispose();
      };
  }, []);

  const markTreeScrollActivity = useCallback(() => {
      if (!isV2Ui) return;
      setIsTreeScrolling(true);
      if (treeScrollIdleTimerRef.current !== null) {
          window.clearTimeout(treeScrollIdleTimerRef.current);
      }
      treeScrollIdleTimerRef.current = window.setTimeout(() => {
          treeScrollIdleTimerRef.current = null;
          setIsTreeScrolling(false);
      }, SIDEBAR_TREE_SCROLL_IDLE_DELAY_MS);
  }, [isV2Ui]);

  const handleTreeWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
          markTreeScrollActivity();
      }
  }, [markTreeScrollActivity]);

  useEffect(() => () => {
      if (treeScrollIdleTimerRef.current !== null) {
          window.clearTimeout(treeScrollIdleTimerRef.current);
      }
  }, []);

  useEffect(() => {
      const handleFocusSidebarSearch = () => {
          if (isV2Ui && !v2UseLegacySidebarFilter) {
              openV2CommandSearch();
              return;
          }
          const inputEl = searchInputRef.current?.input as HTMLInputElement | undefined;
          if (!inputEl) {
              return;
          }
          inputEl.focus();
          inputEl.select();
      };
      window.addEventListener('gonavi:focus-sidebar-search', handleFocusSidebarSearch as EventListener);
      return () => {
          window.removeEventListener('gonavi:focus-sidebar-search', handleFocusSidebarSearch as EventListener);
      };
  }, [isV2Ui, openV2CommandSearch, v2UseLegacySidebarFilter]);

  useEffect(() => {
      if (!isV2CommandSearchOpen) return;
      const timer = window.setTimeout(() => {
          const inputEl = commandSearchInputRef.current?.input as HTMLInputElement | undefined;
          inputEl?.focus();
          inputEl?.select();
      }, 0);
      return () => window.clearTimeout(timer);
  }, [isV2CommandSearchOpen]);

  useEffect(() => {
      if (!isV2CommandSearchOpen) return;
      const handleV2CommandSearchGlobalKeyDown = (event: KeyboardEvent) => {
          if (!shouldCloseV2CommandSearchOnGlobalKey({ key: event.key, isOpen: isV2CommandSearchOpen })) {
              return;
          }
          event.preventDefault();
          event.stopPropagation();
          closeV2CommandSearch();
      };
      window.addEventListener('keydown', handleV2CommandSearchGlobalKeyDown, true);
      return () => window.removeEventListener('keydown', handleV2CommandSearchGlobalKeyDown, true);
  }, [closeV2CommandSearch, isV2CommandSearchOpen]);
  
  // Connection Status State: key -> 'loading' | 'success' | 'error'
  const [connectionStates, setConnectionStates] = useState<Record<string, SidebarConnectionState>>({});

  const [isTreeDragging, setIsTreeDragging] = useState(false);
  const [sidebarTreeDragNodeType, setSidebarTreeDragNodeType] = useState<string | null>(null);
  const [sidebarTreeDropPreview, setSidebarTreeDropPreview] = useState<{
      nodeKey: string;
      placement: SidebarTreeDropPlacement;
  } | null>(null);
  const sidebarTreeDragNodeRef = useRef<TreeNode | null>(null);
  const sidebarTreeDropPreviewRef = useRef<typeof sidebarTreeDropPreview>(null);
  const sidebarTreeDragPreviewElementRef = useRef<HTMLElement | null>(null);
  const sidebarGroupHoverExpandTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
      if (sidebarGroupHoverExpandTimerRef.current !== null) {
          window.clearTimeout(sidebarGroupHoverExpandTimerRef.current);
      }
      sidebarTreeDragPreviewElementRef.current?.remove();
  }, []);

  // Create Database Modal
  const [isCreateDbModalOpen, setIsCreateDbModalOpen] = useState(false);
  const [createDbForm] = Form.useForm();
  const [targetConnection, setTargetConnection] = useState<any>(null);
  const [createDbCharsets, setCreateDbCharsets] = useState<DatabaseCharsetOption[]>([]);
  const [createDbCollations, setCreateDbCollations] = useState<DatabaseCollationOption[]>([]);
  const [loadingCreateDbOptions, setLoadingCreateDbOptions] = useState(false);
  const [isCreateSchemaModalOpen, setIsCreateSchemaModalOpen] = useState(false);
  const [createSchemaForm] = Form.useForm();
  const [createSchemaTarget, setCreateSchemaTarget] = useState<any>(null);
  const [isRenameSchemaModalOpen, setIsRenameSchemaModalOpen] = useState(false);
  const [renameSchemaForm] = Form.useForm();
  const [renameSchemaTarget, setRenameSchemaTarget] = useState<any>(null);
  const [connectionVisibilityTarget, setConnectionVisibilityTarget] = useState<{
      connection: SavedConnection;
      initialDatabase?: string;
  } | null>(null);
  const [isSavingConnectionVisibility, setIsSavingConnectionVisibility] = useState(false);
  const [isRenameDbModalOpen, setIsRenameDbModalOpen] = useState(false);
  const [renameDbForm] = Form.useForm();
  const [renameDbTarget, setRenameDbTarget] = useState<any>(null);
  const [isRenameTableModalOpen, setIsRenameTableModalOpen] = useState(false);
  const [renameTableForm] = Form.useForm();
  const [renameTableTarget, setRenameTableTarget] = useState<any>(null);
  const [messagePublishTarget, setMessagePublishTarget] = useState<SidebarMessagePublishTarget | null>(null);
  const [isRenameViewModalOpen, setIsRenameViewModalOpen] = useState(false);
  const [renameViewForm] = Form.useForm();
  const [renameViewTarget, setRenameViewTarget] = useState<any>(null);
  const [isRenameSavedQueryModalOpen, setIsRenameSavedQueryModalOpen] = useState(false);
  const [renameSavedQueryForm] = Form.useForm();
  const [renameSavedQueryTarget, setRenameSavedQueryTarget] = useState<SavedQuery | null>(null);
  const [isSavedQueryGroupModalOpen, setIsSavedQueryGroupModalOpen] = useState(false);
  const [savedQueryGroupTargetId, setSavedQueryGroupTargetId] = useState<string | null>(null);
  const [savedQueryGroupInitialParentId, setSavedQueryGroupInitialParentId] = useState<string | null>(null);
  // Connection Tag Modals
  const [isCreateTagModalOpen, setIsCreateTagModalOpen] = useState(false);
  const [createTagForm] = Form.useForm();

  useEffect(() => {
    const openTagForm = (event: Event) => {
      const parentTagId = String((event as CustomEvent<{ parentTagId?: string }>).detail?.parentTagId || '').trim();
      setRenameViewTarget(null);
      createTagForm.resetFields();
      if (parentTagId) createTagForm.setFieldsValue({ parentTagId });
      setIsCreateTagModalOpen(true);
    };
    window.addEventListener('gonavi:open-connection-tag-form', openTagForm);
    return () => window.removeEventListener('gonavi:open-connection-tag-form', openTagForm);
  }, [createTagForm]);

  const {
      handleExportDatabaseSQL,
      handleExportSchemaSQL,
      openBatchTableWorkbench,
      openBatchDatabaseWorkbench,
  } = useSidebarBatchExport({
      connections,
      selectedNodesRef,
      addTab,
  });
  // Find in Database Modal
  const [findInDbContext, setFindInDbContext] = useState<{ open: boolean; connectionId: string; dbName: string }>({ open: false, connectionId: '', dbName: '' });

  useEffect(() => {
      if (!autoFetchVisible) {
          return;
      }

      expandedKeys.forEach(key => {
          const node = findTreeNodeByKey(treeData, key);
          if (node && (node.type === 'database' || node.type === 'message-namespace')) {
              loadTables(node, { ensureFresh: true });
          }
      });
  }, [autoFetchVisible, savedQueries]);

  useEffect(() => {
    const previousSignatures = connectionReloadSignaturesRef.current;
    const nextSignatures: Record<string, string> = {};
    const staleConnectionIds = new Set<string>();

    connections.forEach((conn) => {
      const signature = buildConnectionReloadSignature(conn);
      nextSignatures[conn.id] = signature;
      if (previousSignatures[conn.id] && previousSignatures[conn.id] !== signature) {
        staleConnectionIds.add(conn.id);
      }
    });
    connectionReloadSignaturesRef.current = nextSignatures;

    if (staleConnectionIds.size > 0) {
      const staleIds = Array.from(staleConnectionIds);
      setLoadedKeys((prev) =>
        prev.filter((key) => !staleIds.some((id) => isConnectionTreeKey(key, id))),
      );
      setExpandedKeys((prev) =>
        prev.filter((key) => !staleIds.some((id) => isConnectionTreeKey(key, id))),
      );
      setConnectionStates((prev) => {
        const next = { ...prev };
        staleIds.forEach((id) => {
          Object.keys(next).forEach((key) => {
            if (isConnectionTreeKey(key, id)) {
              delete next[key];
            }
          });
        });
        return next;
      });
      staleIds.forEach((id) => {
        invalidateConnectionLoadsRef.current(id);
        Array.from(loadingNodesRef.current).forEach((key) => {
          if (key === `dbs-${id}` || key.startsWith(`tables-${id}-`)) {
            loadingNodesRef.current.delete(key);
          }
        });
      });
    }

    setTreeData((prev) => {
      const prevMap = new Map<string, TreeNode>();

      // We need to recursively extract connections from old tag structures
      // so if a user expands a connection that was tagged, the state remains
      const recurseCollect = (nodes: TreeNode[]) => {
          nodes.forEach((node) => {
            if (node.type === 'tag') {
               if (node.children) recurseCollect(node.children);
            } else if (node.type === 'connection') {
               prevMap.set(String(node.key), node);
            }
          });
      };
      recurseCollect(prev);

      const buildConnectionNode = (conn: SavedConnection): TreeNode => {
        const existing = prevMap.get(conn.id);
        const iconType = resolveConnectionIconType(conn);
        const iconColor = resolveConnectionAccentColor(conn);
        const preserveChildren = existing && !staleConnectionIds.has(conn.id);
        const nacosNamespaceDiscoveryMode =
          preserveChildren && conn.config.type === 'nacos'
            ? resolveNacosNamespaceDiscoveryModeFromTreeNode(existing)
            : undefined;
        return {
          title: conn.name,
          key: conn.id,
          icon: getDbIcon(iconType, iconColor, 22),
          type: 'connection',
          'data-sidebar-node-key': conn.id,
          'data-sidebar-node-type': 'connection',
          dataRef: nacosNamespaceDiscoveryMode
            ? { ...conn, nacosNamespaceDiscoveryMode }
            : conn,
          isLeaf: false,
          children: preserveChildren ? existing.children : undefined,
        } as TreeNode;
      };

      const buildTreeNode = (item: ReturnType<typeof buildSidebarConnectionTagTree>[number]): TreeNode => {
        if (item.kind === 'connection') {
          return buildConnectionNode(item.connection);
        }
        return {
          title: item.tag.name,
          key: `tag-${item.tag.id}`,
          icon: (
            <span
              className="gn-v2-tree-folder-icon"
              data-sidebar-tree-folder-icon="true"
            >
              <FolderOutlined />
            </span>
          ),
          type: 'tag',
          'data-sidebar-node-key': `tag-${item.tag.id}`,
          'data-sidebar-node-type': 'tag',
          dataRef: item.tag,
          isLeaf: false,
          children: item.children.map(buildTreeNode),
        } as TreeNode;
      };

      const orderedNodes = buildSidebarConnectionTagTree(
        connections,
        connectionTags,
        sidebarRootOrder,
        rootSortMode,
        rootConnectionSortMode,
      ).map(buildTreeNode);
      if (allSavedQueriesNode) {
        orderedNodes.push(allSavedQueriesNode);
      }
      const externalSQLRootNode = prev.find((node) => node.type === 'external-sql-root');
      return externalSQLRootNode ? [...orderedNodes, externalSQLRootNode] : orderedNodes;
    });
  }, [connections, connectionTags, sidebarRootOrder, rootSortMode, rootConnectionSortMode, allSavedQueriesNode]);

  const handleDuplicateConnection = async (conn: SavedConnection) => {
    if (!conn?.id) return;

    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.DuplicateConnection !== 'function') {
      message.error(t('connection.sidebar.duplicate.backendUnavailable'));
      return;
    }

    try {
      const duplicatedConnection = await backendApp.DuplicateConnection(conn.id);
      if (!duplicatedConnection) {
        throw new Error(t('connection.sidebar.duplicate.noResult'));
      }
      addConnection(duplicatedConnection);
      message.success(t('connection.sidebar.duplicate.success', {
        name: duplicatedConnection.name,
      }));
    } catch (error: any) {
      message.error(error?.message || t('connection.sidebar.duplicate.failureFallback'));
    }
  };
  const findTreeNodeByKey = (nodes: TreeNode[], targetKey: React.Key): TreeNode | null => {
    for (const node of nodes) {
      if (node.key === targetKey) {
        return node;
      }
      if (node.children) {
        const child = findTreeNodeByKey(node.children, targetKey);
        if (child) {
          return child;
        }
      }
    }
    return null;
  };

  findTreeNodeByKeyRef.current = findTreeNodeByKey;

  const resolveSidebarSelectionContext = useCallback((node: any): TitlebarSelectionContext | null => {
      if (!node) return null;
      const type = String(node.type || '');
      const dataRef = node.dataRef || {};
      const connectionId = type === 'connection'
          ? String(node.key || dataRef.id || '').trim()
          : String(
              resolveSidebarNodeConnectionId(node, connectionIds)
              || dataRef.id
              || dataRef.connectionId
              || '',
          ).trim();
      if (!connectionId) return null;

      // The state map is keyed by the Host connection id. Keep this key
      // stable when a database/table row is selected so the title bar follows
      // the same Host marker as the tree instead of a child-row spinner.
      const sidebarStateKey = connectionId;

      if (type === 'connection') {
          return { connectionId, dbName: '', sidebarStateKey };
      }

      let dbName = String(dataRef.dbName || '').trim();
      if (type === 'redis-db') {
          dbName = `db${dataRef.redisDB}`;
      } else if (
          type === 'nacos-namespace'
          || type === 'nacos-config-entry'
          || type === 'nacos-config-group'
          || type === 'nacos-services-entry'
          || type === 'nacos-service-group'
      ) {
          dbName = String(
              dataRef.nacosNamespaceName
              || dataRef.nacosNamespaceId
              || 'public',
          ).trim();
      }

      const tableName = resolveSidebarTitlebarObjectName(node);
      return tableName
          ? { connectionId, dbName, tableName, sidebarStateKey }
          : { connectionId, dbName, sidebarStateKey };
  }, [connectionIds]);

  const titlebarSnapshotRevisionRef = useRef(0);
  const publishTitlebarSnapshotUpdate = useCallback((
      update: (snapshot: TitlebarSidebarSnapshot) => TitlebarSidebarSnapshot,
      expectedSelectedKey?: unknown,
  ) => {
      const revision = ++titlebarSnapshotRevisionRef.current;
      const expectedKey = expectedSelectedKey === undefined
          ? undefined
          : String(expectedSelectedKey ?? '').trim();
      onTitlebarSnapshotChange?.((current) => {
          // A queued effect can outlive the selection that produced it. Do
          // not let that older tree key repaint the title bar after the user
          // has already selected another row.
          if (
              expectedKey !== undefined
              && selectedSidebarKeyRef.current !== expectedKey
          ) {
              return current;
          }
          const next = update(current);
          return mergeTitlebarSidebarSnapshot(current, {
              ...next,
              revision,
          });
      });
  }, [onTitlebarSnapshotChange]);

  const publishTitlebarSelection = useCallback((
      selection: TitlebarSelectionContext | null,
      expectedSelectedKey?: unknown,
  ) => {
      // `sidebarStateKey` identifies the Host marker; the stale-update guard
      // must use the actual rc-tree row key (which may be a database/table).
      const expectedKey = expectedSelectedKey === undefined
          ? selectedSidebarKeyRef.current
          : expectedSelectedKey;
      publishTitlebarSnapshotUpdate((snapshot) => ({
          ...snapshot,
          selection,
      }), expectedKey);
  }, [publishTitlebarSnapshotUpdate]);

  const publishTitlebarSelectionForNode = useCallback((node: any) => {
      const selection = resolveSidebarSelectionContext(node);
      const selectedKey = String(node?.key ?? '').trim();
      if (selectedKey) {
          selectedSidebarKeyRef.current = selectedKey;
      }
      publishTitlebarSnapshotUpdate((snapshot) => ({
          ...snapshot,
          selection,
      }), selectedKey || selection?.sidebarStateKey || '');
  }, [publishTitlebarSnapshotUpdate, resolveSidebarSelectionContext]);

  // Keep the title bar tied to the row selected in this tree, even when a
  // different workbench tab is active.
  const lastPublishedSidebarSnapshotRef = useRef<{
      selectionSignature: string;
      connectionStates: Record<string, SidebarConnectionState>;
  } | null>(null);
  useSidebarLayoutEffect(() => {
      const selectedKey = selectedKeys[0];
      const selectedNode = selectedKey == null
          ? null
          : findTreeNodeByKey(treeData, selectedKey)
              || selectedNodesRef.current.find((node) => String(node?.key) === String(selectedKey));
      if (shouldDeferSidebarTitlebarSelection({
          selectedKey,
          selectedNode,
          connectionIds,
      })) {
          return;
      }
      const context = resolveSidebarSelectionContext(selectedNode);
      const selectionSignature = context
          ? [context.connectionId, context.dbName, context.tableName || '', context.sidebarStateKey || ''].join('\u0000')
          : '';
      const previous = lastPublishedSidebarSnapshotRef.current;
      if (
          previous
          && previous.selectionSignature === selectionSignature
          && previous.connectionStates === connectionStates
      ) {
          return;
      }
      lastPublishedSidebarSnapshotRef.current = {
          selectionSignature,
          connectionStates,
      };
      publishTitlebarSnapshotUpdate(() => ({
          selection: context,
          connectionStates,
      }), selectedKey == null ? '' : selectedKey);
  }, [connectionIds, connectionStates, publishTitlebarSnapshotUpdate, resolveSidebarSelectionContext, selectedKeys, treeData]);

  const replaceTreeNodeChildren = (
    key: React.Key,
    children: TreeNode[] | undefined,
    dataRef?: unknown,
  ): TreeNode[] => {
      const nextTreeData = replaceSidebarTreeNodeChildren(treeDataRef.current, key, children, dataRef);
      treeDataRef.current = nextTreeData;
      setTreeData(nextTreeData);
      return nextTreeData;
  };

  const clearTreeNodeChildrenByKeys = useCallback((keysToClear: string[]) => {
      const keysToClearSet = new Set(keysToClear.map((key) => String(key || '').trim()).filter(Boolean));
      if (keysToClearSet.size === 0) {
          return;
      }

      const clearChildren = (nodes: TreeNode[]): TreeNode[] => (
          nodes.map((node) => {
              const nodeKey = String(node.key || '').trim();
              if (keysToClearSet.has(nodeKey)) {
                  return { ...node, children: undefined };
              }
              if (node.children?.length) {
                  return { ...node, children: clearChildren(node.children) };
              }
              return node;
          })
      );

      setTreeData((prev) => {
          const nextTreeData = clearChildren(prev);
          treeDataRef.current = nextTreeData;
          return nextTreeData;
      });
      setLoadedKeys((prev) => prev.filter((key) => !keysToClearSet.has(String(key))));
      // Clearing a Host subtree also invalidates its transient load result;
      // otherwise a late metadata response can repaint the unloaded row green.
      const clearedConnectionIds = connectionIds.filter((connectionId) => keysToClearSet.has(connectionId));
      clearedConnectionIds.forEach((connectionId) => invalidateConnectionLoadsRef.current(connectionId));
      setConnectionStates((previous) => {
          let changed = false;
          const next = { ...previous };
          keysToClearSet.forEach((key) => {
              if (Object.prototype.hasOwnProperty.call(next, key)) {
                  delete next[key];
                  changed = true;
              }
          });
          return changed ? next : previous;
      });
      keysToClearSet.forEach((key) => {
          delete databaseTreeTouchedAtRef.current[key];
      });
  }, [connectionIds]);

  const pruneLoadedDatabaseTrees = useCallback(() => {
      const activeDatabaseKey = activeContext?.connectionId && activeContext?.dbName
          ? `${activeContext.connectionId}-${activeContext.dbName}`
          : '';
      const keysToClear = resolveSidebarDatabaseTreePruneKeys({
          treeData: treeDataRef.current,
          expandedKeys,
          selectedKeys,
          activeDatabaseKey,
          touchedAtByDatabaseKey: databaseTreeTouchedAtRef.current,
          maxLoadedDatabases: SIDEBAR_CACHED_DATABASE_TREE_LIMIT,
      });
      if (keysToClear.length === 0) {
          return;
      }
      clearTreeNodeChildrenByKeys(keysToClear);
  }, [activeContext?.connectionId, activeContext?.dbName, clearTreeNodeChildrenByKeys, expandedKeys, selectedKeys]);
  pruneLoadedDatabaseTreesRef.current = pruneLoadedDatabaseTrees;

  const mergeExpandedTreeKeys = useCallback((requiredKeys: React.Key[]) => {
      setExpandedKeys(prev => {
          const merged = [...prev];
          requiredKeys.forEach(key => {
              if (!merged.includes(key)) merged.push(key);
          });
          return merged;
      });
      setAutoExpandParent(true);
  }, []);

  const scrollSidebarTreeToKey = useCallback((
      key: React.Key,
      scrollBlock: 'nearest' | 'center' = 'nearest',
  ) => {
      const id = sidebarTreeScrollRequestIdRef.current + 1;
      sidebarTreeScrollRequestIdRef.current = id;
      setSidebarTreeScrollRequest({ id, key, scrollBlock });
  }, []);

  const decorateExternalSQLTreeNode = (node: ExternalSQLTreeNode): TreeNode => {
    const icon = (() => {
      switch (node.type) {
        case 'external-sql-root':
          return <FolderOpenOutlined />;
        case 'external-sql-directory':
          return node.dataRef.directoryStatus === 'missing' ? <WarningOutlined /> : <HddOutlined />;
        case 'external-sql-folder':
          return <FolderOutlined />;
        default:
          return <FileTextOutlined />;
      }
    })();

    return {
      ...node,
      icon,
      children: node.children?.map((child) => decorateExternalSQLTreeNode(child)),
    };
  };

  const buildExternalSQLRootTreeNode = useCallback((
      directories: ExternalSQLDirectory[] = externalSQLDirectories,
      directoryTrees: Record<string, ExternalSQLTreeEntry[]> = externalSQLDirectoryTreesRef.current,
      directoryStatuses: Record<string, 'missing'> = {},
  ): TreeNode => decorateExternalSQLTreeNode(buildExternalSQLRootNode({
      directories,
      directoryTrees,
      directoryStatuses,
      labels: {
          missingDirectory: t('sidebar.message.external_sql_directory_not_found'),
      },
  })), [externalSQLDirectories]);

  const refreshGlobalExternalSQLRootNode = useCallback(async (
      showSuccess = false,
      directoriesOverride?: ExternalSQLDirectory[],
  ) => {
      const targetDirectories = directoriesOverride || externalSQLDirectories;
      const directoryTrees: Record<string, ExternalSQLTreeEntry[]> = {};
      const directoryStatuses: Record<string, 'missing'> = {};
      await Promise.all(targetDirectories.map(async (directory) => {
          const directoryRes = await ListSQLDirectory(directory.path);
          if (!directoryRes.success) {
              const errorCode = String((directoryRes.data as Record<string, unknown> | undefined)?.errorCode || '').trim();
              if (errorCode === 'directory_not_found') {
                  directoryStatuses[directory.id] = 'missing';
              } else {
                  message.warning({
                      key: `external-sql-${directory.id}`,
                      content: t('sidebar.message.external_sql_directory_read_failed', {
                          name: directory.name,
                          error: directoryRes.message,
                      }),
                  });
              }
              directoryTrees[directory.id] = [];
              return;
          }
          directoryTrees[directory.id] = Array.isArray(directoryRes.data)
              ? directoryRes.data as ExternalSQLTreeEntry[]
              : [];
      }));
      externalSQLDirectoryTreesRef.current = directoryTrees;
      const rootNode = buildExternalSQLRootTreeNode(targetDirectories, directoryTrees, directoryStatuses);
      setTreeData((prev) => {
          const withoutExternalRoot = prev.filter((node) => node.type !== 'external-sql-root');
          const nextTreeData = [...withoutExternalRoot, rootNode];
          treeDataRef.current = nextTreeData;
          return nextTreeData;
      });
      if (showSuccess) {
          message.success(t('sidebar.message.external_sql_directory_refreshed'));
      }
  }, [buildExternalSQLRootTreeNode, externalSQLDirectories]);

  useEffect(() => {
      void refreshGlobalExternalSQLRootNode(false);
  }, [refreshGlobalExternalSQLRootNode]);

  const openDataImportWorkbench = useCallback((input: BuildDataImportWorkbenchTabInput) => {
    const existingImportTab = tabs.find((tab) => tab.id === DATA_IMPORT_WORKBENCH_TAB_ID);
    addTab(resolveDataImportWorkbenchLaunchTab(existingImportTab, input));
  }, [addTab, tabs]);

  const {
      handleRunSQLFile,
      handleOpenSQLFileFromToolbar,
      openExternalSQLFile,
      openExternalSQLBindingModal,
      openCreateExternalSQLFileModal,
      openRenameExternalSQLFileModal,
      openCreateExternalSQLDirectoryModal,
      openRenameExternalSQLDirectoryModal,
      handleDeleteExternalSQLFile,
      handleDeleteExternalSQLDirectory,
      handleAddExternalSQLDirectory,
      handleRemoveExternalSQLDirectory,
      handleRefreshExternalSQLDirectory,
      browserSQLFileInputProps,
      externalSQLFileModalProps,
      externalSQLBindingModalProps,
  } = useSidebarExternalSqlWorkflow({
      connections,
      externalSQLDirectories,
      activeTab,
      connectionIds,
      selectedNodesRef,
      addTab,
      openDataImportWorkbench,
      saveExternalSQLDirectory,
      deleteExternalSQLDirectory,
      updateRecentSQLFilePath,
      removeRecentSQLFilesByPath,
      moveRecentSQLFilesByDirectory,
      removeRecentSQLFilesByDirectory,
      refreshGlobalExternalSQLRootNode,
      setExpandedKeys,
      setAutoExpandParent,
      getActiveContext: () => useStore.getState().activeContext,
      isWebRuntime,
  });

  useEffect(() => {
    const handleWorkbenchAddExternalSQLDirectory = () => {
      void handleAddExternalSQLDirectory({ type: 'external-sql-root' });
    };
    window.addEventListener('gonavi:add-external-sql-directory', handleWorkbenchAddExternalSQLDirectory);
    return () => {
      window.removeEventListener('gonavi:add-external-sql-directory', handleWorkbenchAddExternalSQLDirectory);
    };
  }, [handleAddExternalSQLDirectory]);

  const getNodeDatabaseContext = (node: any): { connectionId: string; dbName: string; dbNodeKey: string } | null => {
    if (!node) return null;
    if (node.type === 'database' || node.type === 'message-namespace') {
      return {
        connectionId: String(node?.dataRef?.id || '').trim(),
        dbName: String(node?.dataRef?.dbName || '').trim(),
        dbNodeKey: String(node.key || '').trim(),
      };
    }

    if (
      node.type === 'external-sql-root'
      || node.type === 'external-sql-directory'
      || node.type === 'external-sql-folder'
      || node.type === 'external-sql-file'
    ) {
      return {
        connectionId: String(node?.dataRef?.connectionId || '').trim(),
        dbName: String(node?.dataRef?.dbName || '').trim(),
        dbNodeKey: String(node?.dataRef?.dbNodeKey || '').trim(),
      };
    }

    return null;
  };

  const locateObjectInSidebarRef = useRef<(detail: unknown) => Promise<void>>(async () => {});

  const waitForSidebarLoadKey = async (loadKey: string): Promise<boolean> => {
      for (let attempt = 0; attempt < SIDEBAR_LOCATE_LOAD_WAIT_ATTEMPTS && loadingNodesRef.current.has(loadKey); attempt += 1) {
          await new Promise(resolve => window.setTimeout(resolve, SIDEBAR_LOCATE_LOAD_WAIT_INTERVAL_MS));
      }
      return !loadingNodesRef.current.has(loadKey);
  };

  const locateObjectInSidebar = async (detail: unknown) => {
      const request = normalizeSidebarLocateObjectRequest(detail);
      if (!request) {
          message.warning(t('sidebar.message.locate_current_table_unavailable'));
          return;
      }

      onEnsureSidebarExpanded?.();

      if (request.objectGroup === 'externalSqlFiles') {
          await refreshGlobalExternalSQLRootNode(false);
          const target = resolveSidebarLocateTarget(request, { groupBySchema: false });
          const path = findSidebarNodePathForLocate(treeDataRef.current as SidebarLocateTreeNodeLike[], target);
          if (!path) {
              message.warning(t('sidebar.message.locate_external_sql_file_not_found', { path: request.filePath }));
              return;
          }
          const targetKey = path[path.length - 1];
          const targetNode = findTreeNodeByKey(treeDataRef.current, targetKey);
          setSearchValue('');
          setV2ExplorerFilter('all');
          mergeExpandedTreeKeys(path.slice(0, -1));
          setSidebarSelectedKeys([targetKey]);
          selectedNodesRef.current = targetNode ? [targetNode] : [];
          const connectionId = String(request.connectionId || activeContext?.connectionId || activeTab?.connectionId || '').trim();
          const dbName = String(request.dbName || activeContext?.dbName || activeTab?.dbName || '').trim();
          if (connectionId) {
              setActiveContext({ connectionId, dbName });
              publishTitlebarSelection(
                  resolveSidebarSelectionContext(targetNode)
                  || {
                      connectionId,
                      dbName,
                      sidebarStateKey: connectionId,
                  },
                  targetKey,
              );
          }
          scrollSidebarTreeToKey(targetKey, 'center');
          return;
      }

      if (request.objectGroup === 'savedQueries') {
          const target = resolveSidebarLocateTarget(request, { groupBySchema: false });
          const path = findSidebarNodePathForLocate(treeDataRef.current as SidebarLocateTreeNodeLike[], target);
          if (!path) {
              message.warning(t('sidebar.message.locate_saved_query_not_found', {
                  name: request.savedQueryName || request.savedQueryId,
              }));
              return;
          }
          const targetKey = path[path.length - 1];
          const targetNode = findTreeNodeByKey(treeDataRef.current, targetKey);
          setSearchValue('');
          setV2ExplorerFilter('all');
          mergeExpandedTreeKeys(path.slice(0, -1));
          setSidebarSelectedKeys([targetKey]);
          selectedNodesRef.current = targetNode ? [targetNode] : [];
          const connectionId = String(request.connectionId || activeContext?.connectionId || activeTab?.connectionId || '').trim();
          const dbName = String(request.dbName || activeContext?.dbName || activeTab?.dbName || '').trim();
          if (connectionId) {
              setActiveContext({ connectionId, dbName });
              publishTitlebarSelection(
                  resolveSidebarSelectionContext(targetNode)
                  || {
                      connectionId,
                      dbName,
                      sidebarStateKey: connectionId,
                  },
                  targetKey,
              );
          }
          scrollSidebarTreeToKey(targetKey, 'center');
          return;
      }

      const conn = connections.find(item => item.id === request.connectionId);
      if (!conn) {
          message.warning(t('sidebar.message.locate_connection_not_found_for_object'));
          return;
      }

      const target = resolveSidebarLocateTarget(request, {
          groupBySchema: shouldHideSchemaPrefix(conn),
      });
      const objectLabel = request.objectGroup === 'materializedViews'
          ? t('sidebar.locate.object.materialized_view')
          : request.objectGroup === 'views'
              ? t('sidebar.locate.object.view')
              : request.objectGroup === 'triggers'
                  ? t('sidebar.locate.object.trigger')
                  : request.objectGroup === 'routines'
                      ? t('sidebar.locate.object.routine')
                      : t('sidebar.locate.object.table');

      let path = findSidebarNodePathForLocate(treeDataRef.current as SidebarLocateTreeNodeLike[], target);
      const dbLoadKey = `dbs-${request.connectionId}`;
      const tableLoadKey = `tables-${request.connectionId}-${request.dbName}`;

      if (!path && !findSidebarNodePathByKey(treeDataRef.current as SidebarLocateTreeNodeLike[], target.databaseKey)) {
          const connectionNode = findTreeNodeByKey(treeDataRef.current, target.connectionKey);
          if (!connectionNode) {
              message.warning(t('sidebar.message.locate_connection_not_in_tree'));
              return;
          }
          if (loadingNodesRef.current.has(dbLoadKey)) {
              const loaded = await waitForSidebarLoadKey(dbLoadKey);
              if (!loaded) {
                  message.info(t('sidebar.message.locate_database_loading', { database: request.dbName }));
                  return;
              }
          } else {
              await loadDatabases(connectionNode);
          }
      }

      const dbNode = findTreeNodeByKey(treeDataRef.current, target.databaseKey);
      if (!dbNode) {
          message.warning(t('sidebar.message.locate_database_not_found', { database: request.dbName }));
          return;
      }

      path = findSidebarNodePathForLocate(treeDataRef.current as SidebarLocateTreeNodeLike[], target);
      if (!path) {
          if (loadingNodesRef.current.has(tableLoadKey)) {
              const loaded = await waitForSidebarLoadKey(tableLoadKey);
              if (!loaded) {
                  message.info(t('sidebar.message.locate_object_loading', {
                      object: objectLabel,
                      database: request.dbName,
                  }));
                  return;
              }
          } else {
              await loadTables(dbNode);
          }
          path = findSidebarNodePathForLocate(treeDataRef.current as SidebarLocateTreeNodeLike[], target);
      }

      if (!path) {
          message.warning(t('sidebar.message.locate_object_not_found', {
              object: objectLabel,
              name: request.tableName,
          }));
          return;
      }

      const targetKey = path[path.length - 1];
      const targetNode = findTreeNodeByKey(treeDataRef.current, targetKey);
      setSearchValue('');
      setV2ExplorerFilter('all');
      mergeExpandedTreeKeys(path.slice(0, -1));
      setSidebarSelectedKeys([targetKey]);
      selectedNodesRef.current = targetNode ? [targetNode] : [];
      setActiveContext({
          connectionId: request.connectionId,
          dbName: request.dbName,
          tableName: resolveSidebarTitlebarObjectName(targetNode) || request.tableName,
          ...buildOptionalSchemaContext(targetNode?.dataRef?.schemaName || request.schemaName),
      });
      publishTitlebarSelection(
          resolveSidebarSelectionContext(targetNode)
          || {
              connectionId: request.connectionId,
              dbName: request.dbName,
              tableName: request.tableName,
              sidebarStateKey: request.connectionId,
          },
          targetKey,
      );
      scrollSidebarTreeToKey(targetKey, 'center');
  };

  const handleLocateActiveTabInSidebar = () => {
      if (!activeTabLocateRequest) {
          message.warning(t('sidebar.message.locate_current_table_unavailable'));
          return;
      }
      void locateObjectInSidebar(activeTabLocateRequest);
  };

  useEffect(() => {
      locateObjectInSidebarRef.current = locateObjectInSidebar;
  });

  useEffect(() => {
      const handleLocateSidebarObject = (event: Event) => {
          void locateObjectInSidebarRef.current((event as CustomEvent).detail);
      };
      window.addEventListener('gonavi:locate-sidebar-object', handleLocateSidebarObject as EventListener);
      return () => {
          window.removeEventListener('gonavi:locate-sidebar-object', handleLocateSidebarObject as EventListener);
      };
  }, []);

  useEffect(() => {
      const handleSidebarTablePinChanged = (event: Event) => {
          const detail = (event as CustomEvent).detail || {};
          const connectionId = String(detail.connectionId || '').trim();
          const dbName = String(detail.dbName || '').trim();
          if (!connectionId || !dbName) return;
          const dbNode = findTreeNodeByKeyRef.current(treeDataRef.current, `${connectionId}-${dbName}`);
          if (dbNode) {
              void loadTables(dbNode, { ensureFresh: true });
          }
      };
      window.addEventListener('gonavi:sidebar-table-pin-changed', handleSidebarTablePinChanged as EventListener);
      return () => {
          window.removeEventListener('gonavi:sidebar-table-pin-changed', handleSidebarTablePinChanged as EventListener);
      };
  }, []);

  useEffect(() => {
      const handleSidebarTableCreated = (event: Event) => {
          const detail = (event as CustomEvent).detail || {};
          const connectionId = String(detail.connectionId || '').trim();
          const dbName = String(detail.dbName || '').trim();
          if (!connectionId || !dbName) return;
          const dbNode = findTreeNodeByKeyRef.current(treeDataRef.current, `${connectionId}-${dbName}`);
          if (dbNode) {
              void loadTables(dbNode, { ensureFresh: true });
          }
      };
      window.addEventListener('gonavi:sidebar-table-created', handleSidebarTableCreated as EventListener);
      return () => {
          window.removeEventListener('gonavi:sidebar-table-created', handleSidebarTableCreated as EventListener);
      };
  }, []);

  useEffect(() => {
      const handleSidebarDatabaseRefresh = (event: Event) => {
          const request = normalizeSidebarDatabaseRefreshRequest((event as CustomEvent).detail);
          if (!request) return;
          if (!request.dbName) {
              const connectionNode = findTreeNodeByKeyRef.current(
                  treeDataRef.current,
                  request.connectionId,
              );
              if (connectionNode) {
                  void refreshConnectionResourcesRef.current(connectionNode);
              }
              return;
          }
          const dbNode = findTreeNodeByKeyRef.current(
              treeDataRef.current,
              `${request.connectionId}-${request.dbName}`,
          );
          if (dbNode) {
              void loadTables(dbNode, { ensureFresh: true });
          }
      };
      window.addEventListener(SIDEBAR_DATABASE_REFRESH_EVENT, handleSidebarDatabaseRefresh as EventListener);
      return () => {
          window.removeEventListener(SIDEBAR_DATABASE_REFRESH_EVENT, handleSidebarDatabaseRefresh as EventListener);
      };
  }, []);

  const onLoadData = async ({ key, children, dataRef, type }: any) => {
    if (type === 'tag' || type === 'all-saved-queries' || type === 'saved-query-group' || type === 'saved-query-manual-group' || type === 'unmatched-saved-queries') return;
    if (hasSidebarLazyChildren(children)) return;

    if (type === 'connection') {
        await loadDatabases({ key, dataRef });
    } else if (type === 'jvm-mode' || type === 'jvm-resource') {
        await loadJVMResources({ key, dataRef });
    } else if (type === 'database' || type === 'message-namespace') {
        await loadTables({ key, dataRef });
    } else if (type === 'nacos-config-entry') {
        await loadNacosConfigGroups({ key, dataRef });
    } else if (type === 'nacos-services-entry') {
        await loadNacosServiceGroups({ key, dataRef });
    } else if (type === 'external-sql-root') {
        await refreshGlobalExternalSQLRootNode(false);
    } else if (type === 'table') {
        // Expand table to show object categories
        const conn = dataRef; 

        const folders: TreeNode[] = [
            {
                title: t('sidebar.table_folder.columns'),
                key: `${key}-columns`,
                icon: <UnorderedListOutlined />,
                type: 'folder-columns',
                isLeaf: true,
                dataRef: conn
            },
            {
                title: t('sidebar.table_folder.indexes'),
                key: `${key}-indexes`,
                icon: <KeyOutlined style={{ transform: 'rotate(45deg)' }} />,
                type: 'folder-indexes',
                isLeaf: true,
                dataRef: conn
            },
            {
                title: t('sidebar.table_folder.foreign_keys'),
                key: `${key}-fks`,
                icon: <LinkOutlined />,
                type: 'folder-fks',
                isLeaf: true,
                dataRef: conn
            },
            {
                title: t('sidebar.table_folder.triggers'),
                key: `${key}-triggers`,
                icon: <ThunderboltOutlined />,
                type: 'folder-triggers',
                isLeaf: true,
                dataRef: conn
            }
        ];
        
        replaceTreeNodeChildren(key, folders);
    }
  };

  const isStructureOnlyDbType = (connectionId: string): boolean => {
      const conn = connections.find(c => c.id === connectionId);
      if (!conn) return false;
      const dbType = resolveDataSourceType(conn.config);
      return dbType === 'elasticsearch' || dbType === 'mongodb' || dbType === 'redis' || dbType === 'iotdb';
  };

  const openDesign = (node: any, initialTab: string, readOnly: boolean = false) => {
      const { tableName, dbName, id, schemaName } = node.dataRef;
      const conn = connections.find(c => c.id === id);
      const forceReadOnly = readOnly
          || isStructureOnlyDbType(id)
          || isConnectionStructureEditRestricted(conn?.config);
      addTab({
          id: `design-${id}-${dbName}-${schemaName || 'default'}-${tableName}`,
          title: forceReadOnly
              ? t('sidebar.tab.table_structure', { table: tableName })
              : t('sidebar.tab.design_table', { table: tableName }),
          type: 'design',
          connectionId: id,
          dbName: dbName,
          tableName: tableName,
          schemaName,
          initialTab: initialTab,
          readOnly: forceReadOnly
      });
  };

  const openNewTableDesign = (node: any) => {
      const { dbName, id, schemaName } = node.dataRef;
      const conn = connections.find(c => c.id === id);
      if (isStructureOnlyDbType(id) || isConnectionStructureEditRestricted(conn?.config)) {
          message.warning(t('sidebar.message.visual_new_table_unsupported'));
          return;
      }
      addTab({
          id: `new-table-${id}-${dbName}-${Date.now()}`,
          title: t('sidebar.tab.new_table', { database: dbName }),
          type: 'design',
          connectionId: id,
          dbName: dbName,
          tableName: '', // Empty tableName signals creation mode
          schemaName,
          initialTab: 'columns',
          readOnly: false
      });
  };

  const openSidebarObjectNode = (node: any): boolean => {
      if (node.type === 'view' || node.type === 'materialized-view') {
          const { viewName, dbName, id, schemaName } = node.dataRef;
          addTab({
              id: node.key,
              title: viewName,
              type: 'table',
              connectionId: id,
              dbName,
              tableName: viewName,
              objectType: node.type === 'materialized-view' ? 'materialized-view' : 'view',
              schemaName,
              sidebarLocateKey: String(node.key || ''),
          });
          return true;
      }
      if (node.type === 'db-trigger') {
          const { triggerName, triggerTableName, schemaName, dbName, id } = node.dataRef;
          addTab({
              id: `trigger-${node.key}`,
              title: t('sidebar.tab.trigger', { name: triggerName }),
              type: 'trigger',
              connectionId: id,
              dbName,
              triggerName,
              triggerTableName,
              schemaName,
              sidebarLocateKey: String(node.key || ''),
          });
          return true;
      }
      if (node.type === 'db-event') {
          openEventDefinition(node);
          return true;
      }
      if (node.type === 'routine') {
          const { routineName, routineType, dbName, id, schemaName } = node.dataRef;
          const typeLabel = t(routineType === 'PROCEDURE' ? 'sidebar.object.procedure' : 'sidebar.object.function');
          addTab({
              id: `routine-def-${node.key}`,
              title: t('sidebar.tab.routine_definition', { type: typeLabel, name: routineName }),
              type: 'routine-def',
              connectionId: id,
              dbName,
              routineName,
              routineType,
              ...buildOptionalSchemaContext(schemaName),
          });
          return true;
      }
      if (node.type === 'sequence') {
          openSequenceDefinition(node);
          return true;
      }
      if (node.type === 'package') {
          openPackageDefinition(node);
          return true;
      }
      return false;
  };

  const openMessageObjectNode = (node: any): boolean => {
      if (node?.type !== 'message-object') return false;
      openMessageQueueWorkbench(node, 'open');
      return true;
  };

  const clearStaleHostStateOnSelection = (node: any): void => {
      if (node?.type !== 'connection') return;
      const connectionId = String(node.key || node.dataRef?.id || '').trim();
      if (!connectionId) return;

      // The rail and command-search paths call this before writing the tree
      // selection. Register the row first so a queued update from the prior
      // Host cannot repaint the title bar after this selection.
      selectedSidebarKeyRef.current = String(node.key || connectionId).trim();

      // Selecting a Host is a navigation action, not a connection-health
      // assertion. Clear only a previous success/error result. If an
      // explicit expansion/reconnect is already loading, keep that request
      // and its loading state so the title bar stays in lockstep with the
      // Host row instead of cancelling the in-flight probe.
      setConnectionStates((previous) => clearSidebarHostConnectionState(previous, connectionId));
      const selection = resolveSidebarSelectionContext(node);
      publishTitlebarSnapshotUpdate((snapshot) => ({
          ...snapshot,
          selection,
          connectionStates: clearSidebarHostConnectionState(
              snapshot.connectionStates,
              connectionId,
          ),
      }), selectedSidebarKeyRef.current);
  };

  const onSelect = (keys: React.Key[], info: any) => {
      if (isV2Ui && (info?.node?.type === 'v2-table-section' || info?.node?.type === 'v2-database-section')) {
          return;
      }
      if (Date.now() < treeDragSelectSuppressUntilRef.current) {
          return;
      }
      if (isTreeDragging) {
          return;
      }
      setSidebarSelectedKeys(keys);
      selectedNodesRef.current = info.selectedNodes || [];

      if (keys.length === 0) {
          publishTitlebarSelection(null);
          if (shouldClearSidebarActiveContextOnEmptySelect(isV2Ui)) {
              setActiveContext(null);
          }
          return;
      }
      if (shouldSkipSidebarSelectWhileDragging(isTreeDragging, info)) return;

      const { type, dataRef, key, title } = info.node;
      const nodeConnectionId = resolveSidebarNodeConnectionId(info.node, connectionIds);
      if (type === 'connection') {
          clearStaleHostStateOnSelection(info.node);
      } else {
          publishTitlebarSelectionForNode(info.node);
      }

      // Update active context
      if (type === 'connection') {
          setActiveContext({ connectionId: key, dbName: '' });
      } else if (type === 'database' || type === 'message-namespace') {
          setActiveContext({ connectionId: nodeConnectionId || dataRef.id, dbName: dataRef.dbName });
      } else if (type === 'object-group' && dataRef?.groupKey === 'schema') {
          setActiveContext({
              connectionId: nodeConnectionId || dataRef.id,
              dbName: dataRef.dbName,
              ...buildOptionalSchemaContext(dataRef.schemaName),
          });
      } else if (
          type === 'table'
          || type === 'message-object'
          || type === 'view'
          || type === 'materialized-view'
          || type === 'sequence'
          || type === 'package'
          || type === 'db-trigger'
          || type === 'db-event'
          || type === 'routine'
      ) {
          setActiveContext({
              connectionId: nodeConnectionId || dataRef.id,
              dbName: dataRef.dbName,
              tableName: resolveSidebarTitlebarObjectName(info.node),
              ...buildOptionalSchemaContext(dataRef.schemaName),
          });
      } else if (type === 'jvm-mode' || type === 'jvm-resource' || type === 'jvm-diagnostic' || type === 'jvm-monitoring') {
          setActiveContext({ connectionId: nodeConnectionId || dataRef.id, dbName: '' });
      } else if (type === 'saved-query') {
          setActiveContext({ connectionId: dataRef.connectionId, dbName: dataRef.dbName });
      } else if (type === 'redis-db') {
          setActiveContext({ connectionId: dataRef.id, dbName: `db${dataRef.redisDB}` });
      } else if (
          type === 'nacos-namespace'
          || type === 'nacos-config-entry'
          || type === 'nacos-config-group'
          || type === 'nacos-services-entry'
          || type === 'nacos-service-group'
      ) {
          setActiveContext({
              connectionId: dataRef.id,
              dbName: dataRef.nacosNamespaceName || dataRef.nacosNamespaceId || 'public',
          });
      }

      if (type === 'folder-columns') openDesign(info.node, 'columns', false);
      else if (type === 'folder-indexes') openDesign(info.node, 'indexes', false);
      else if (type === 'folder-fks') openDesign(info.node, 'foreignKeys', false);
      else if (type === 'folder-triggers') openDesign(info.node, 'triggers', false);
      else if (type === 'object-group' && dataRef?.groupKey === 'tables') {
          // 单击延迟打开表概览，双击时会取消此定时器
          if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
          const { id, dbName: gDbName, schemaName } = dataRef;
          clickTimerRef.current = setTimeout(() => {
              clickTimerRef.current = null;
              addTab({
                  id: `table-overview-${id}-${gDbName}${schemaName ? `-${schemaName}` : ''}`,
                  title: t('sidebar.tab.table_overview', {
                      database: gDbName,
                      schema: schemaName ? ` (${schemaName})` : '',
                  }),
                  type: 'table-overview' as any,
                  connectionId: id,
                  dbName: gDbName,
                  schemaName,
              } as any);
          }, 250);
      } else if (openSidebarObjectNode(info.node)) {
          return;
      }
  };

  const onExpand = (newExpandedKeys: React.Key[], info?: any) => {
    // rc-tree auto-expands any loaded node after a drag hover. During a V2 Host
    // move, group expansion is controlled by the explicit 500ms inside target;
    // ignore rc-tree's competing expansion so connection resource rows do not
    // unexpectedly open and move the target under the pointer.
    if (
        isV2Ui
        && isTreeDragging
        && sidebarTreeDragNodeRef.current?.type === 'connection'
    ) {
        return;
    }
    if (!info?.expanded && shouldClearSidebarNodeChildrenOnCollapse(info?.node)) {
        const collapsedKey = String(info.node?.key || '').trim();
        const keysToClear = [
            collapsedKey,
            ...collectSidebarSubtreeKeys(info.node),
        ].filter(Boolean);
        const keysToClearSet = new Set(keysToClear);
        setExpandedKeys(newExpandedKeys.filter((key) => !keysToClearSet.has(String(key))));
        setAutoExpandParent(false);
        clearTreeNodeChildrenByKeys(keysToClear);
        return;
    }
    setExpandedKeys(newExpandedKeys);
    setAutoExpandParent(false);
    if (!shouldSkipSidebarLoadOnExpandWhileDragging(isTreeDragging, info)) {
        void onLoadData(info.node);
    }
  };

  const onDoubleClick = (e: any, node: any) => {
      // 双击时取消单击延迟动作（如表概览打开），让双击只触发展开/折叠
      if (clickTimerRef.current) {
          clearTimeout(clickTimerRef.current);
          clickTimerRef.current = null;
      }
      const { type, dataRef, key: nodeKey } = node;
      if (isV2Ui && (type === 'v2-table-section' || type === 'v2-database-section')) {
          return;
      }
      const nodeConnectionId = resolveSidebarNodeConnectionId(node, connectionIds);
      // Context-menu actions call this handler directly, without rc-tree's
      // preceding select event. Keep the tree selection in sync so the
      // titlebar layout effect cannot restore the previously selected row
      // after opening the requested object.
      if (nodeKey !== undefined && nodeKey !== null && String(nodeKey).trim() !== '') {
          setSidebarSelectedKeys([nodeKey]);
          selectedNodesRef.current = [node];
      }
      if (type === 'connection') {
          clearStaleHostStateOnSelection(node);
      } else {
          publishTitlebarSelectionForNode(node);
      }
      if (type === 'connection') {
          setActiveContext({ connectionId: nodeKey, dbName: '' });
      } else if (type === 'database' || type === 'message-namespace') {
          setActiveContext({ connectionId: nodeConnectionId || dataRef.id, dbName: dataRef.dbName });
      } else if (type === 'object-group' && dataRef?.groupKey === 'schema') {
          setActiveContext({
              connectionId: nodeConnectionId || dataRef.id,
              dbName: dataRef.dbName,
              ...buildOptionalSchemaContext(dataRef.schemaName),
          });
      } else if (type === 'jvm-mode' || type === 'jvm-resource' || type === 'jvm-diagnostic' || type === 'jvm-monitoring') {
          setActiveContext({ connectionId: nodeConnectionId || dataRef.id, dbName: '' });
      } else if (type === 'table' || type === 'message-object' || type === 'view' || type === 'materialized-view' || type === 'sequence' || type === 'package' || type === 'db-trigger' || type === 'db-event' || type === 'routine') {
          setActiveContext({
              connectionId: nodeConnectionId || dataRef.id,
              dbName: dataRef.dbName,
              tableName: resolveSidebarTitlebarObjectName(node),
              ...buildOptionalSchemaContext(dataRef.schemaName),
          });
      } else if (type === 'saved-query') {
          setActiveContext({ connectionId: dataRef.connectionId, dbName: dataRef.dbName });
      }
      else if (type === 'redis-db') {
          setActiveContext({ connectionId: dataRef.id, dbName: `db${dataRef.redisDB}` });
      }
      else if (
          type === 'nacos-namespace'
          || type === 'nacos-config-entry'
          || type === 'nacos-config-group'
          || type === 'nacos-services-entry'
          || type === 'nacos-service-group'
      ) {
          setActiveContext({
              connectionId: dataRef.id,
              dbName: dataRef.nacosNamespaceName || dataRef.nacosNamespaceId || 'public',
          });
      }

      const isMessageQueueConnection = node.type === 'connection'
          && ['mqtt', 'kafka', 'rocketmq', 'rabbitmq'].includes(
              resolveDataSourceType(node.dataRef?.config),
          );
      if (isMessageQueueConnection || node.type === 'message-namespace') {
          openMessageQueueWorkbench(node, 'open');
          return;
      }
      if (openMessageObjectNode(node)) {
          return;
      } else if (node.type === 'table') {
          const { tableName, dbName, id, schemaName } = node.dataRef;
          // 记录表访问
          recordTableAccess(id, dbName, tableName);
          addTab({
              id: node.key,
              title: tableName,
              type: 'table',
              connectionId: id,
              dbName,
              tableName,
              ...buildOptionalSchemaContext(schemaName),
              initialViewMode: tableDoubleClickAction === 'open-design' ? 'fields' : undefined,
              initialViewModeRequestId: tableDoubleClickAction === 'open-design' ? String(Date.now()) : undefined,
              objectType: 'table',
          });
          return;
      } else if (node.type === 'view' || node.type === 'materialized-view') {
          const { viewName, dbName, id, schemaName } = node.dataRef;
          addTab({
              id: node.key,
              title: viewName,
              type: 'table',
              connectionId: id,
              dbName,
              tableName: viewName,
              objectType: node.type === 'materialized-view' ? 'materialized-view' : 'view',
              schemaName,
              sidebarLocateKey: String(node.key || ''),
          });
          return;
      } else if (node.type === 'saved-query') {
          const q = node.dataRef;
          addTab({
              id: q.id,
              title: resolveSavedQueryDisplayName(q.name),
              type: 'query',
              connectionId: q.connectionId,
              dbName: q.dbName,
              query: q.sql,
              savedQueryId: q.id,
          });
          return;
      } else if (node.type === 'external-sql-file') {
          void openExternalSQLFile(node);
          return;
      } else if (node.type === 'redis-db') {
          const { id, redisDB } = node.dataRef;
          addTab({
              id: `redis-keys-${id}-db${redisDB}`,
              title: `db${redisDB}`,
              type: 'redis-keys',
              connectionId: id,
              redisDB: redisDB
          });
          return;
      } else if (node.type === 'nacos-config-entry') {
          // Folder node: fall through to expand/collapse + lazy load groups.
      } else if (node.type === 'nacos-config-group') {
          const {
              id,
              nacosNamespaceId = '',
              nacosNamespaceName = '',
              nacosGroup = '',
              nacosAllConfigs = false,
          } = node.dataRef || {};
          const nsName = nacosNamespaceName || nacosNamespaceId || 'public';
          const nsKey = nacosNamespaceId || 'public';
          const isAll = !!nacosAllConfigs;
          const groupName = isAll ? '' : (String(nacosGroup || '').trim() || 'DEFAULT_GROUP');
          addTab({
              id: isAll
                  ? `nacos-config-${id}-ns-${nsKey}`
                  : `nacos-config-${id}-ns-${nsKey}-g-${encodeURIComponent(groupName)}`,
              title: isAll ? `${nsName} · ${t('nacos_viewer.label.all')}` : `${nsName} · ${groupName}`,
              type: 'nacos-config',
              connectionId: id,
              nacosNamespaceId: nacosNamespaceId || '',
              nacosNamespaceName: nsName,
              ...(isAll ? {} : { nacosGroup: groupName }),
          });
          return;
      } else if (node.type === 'nacos-services-entry' || node.type === 'nacos-service-group') {
          const action = resolveNacosServicesDoubleClickAction(node);
          if (action?.kind === 'open') {
              addTab(action.tab);
              return;
          }
          // Service explorer entry is a folder: fall through to expand/collapse + lazy load groups.
      } else if (node.type === 'db-trigger') {
          const { triggerName, triggerTableName, schemaName, dbName, id } = node.dataRef;
          addTab({
              id: `trigger-${node.key}`,
              title: t('sidebar.tab.trigger', { name: triggerName }),
              type: 'trigger',
              connectionId: id,
              dbName,
              triggerName,
              triggerTableName,
              schemaName,
              sidebarLocateKey: String(node.key || ''),
          });
          return;
      } else if (node.type === 'db-event') {
          openEventDefinition(node);
          return;
      } else if (node.type === 'routine') {
          const { routineName, routineType, dbName, id, schemaName } = node.dataRef;
          const typeLabel = t(routineType === 'PROCEDURE' ? 'sidebar.object.procedure' : 'sidebar.object.function');
          addTab({
              id: `routine-def-${node.key}`,
              title: t('sidebar.tab.routine_definition', { type: typeLabel, name: routineName }),
              type: 'routine-def',
              connectionId: id,
              dbName,
              routineName,
              routineType,
              ...buildOptionalSchemaContext(schemaName),
          });
          return;
      } else if (node.type === 'sequence') {
          openSequenceDefinition(node);
          return;
      } else if (node.type === 'package') {
          openPackageDefinition(node);
          return;
      } else if (node.type === 'jvm-mode') {
          const { providerMode, id } = node.dataRef;
          const conn = (connections.find((item) => item.id === id) || node.dataRef) as SavedConnection;
          openJVMOverviewTab(conn, providerMode);
          return;
      } else if (node.type === 'jvm-resource') {
          const { providerMode, resourcePath, resourceKind, id } = node.dataRef;
          const conn = (connections.find((item) => item.id === id) || node.dataRef) as SavedConnection;
          openJVMResourceTab(conn, providerMode, resourcePath, resourceKind);
          return;
      } else if (node.type === 'jvm-monitoring') {
          const { providerMode, id } = node.dataRef;
          const conn = (connections.find((item) => item.id === id) || node.dataRef) as SavedConnection;
          openJVMMonitoringTab(conn, providerMode);
          return;
      } else if (node.type === 'jvm-diagnostic') {
          const conn = (connections.find((item) => item.id === node.dataRef.id) || node.dataRef) as SavedConnection;
          openJVMDiagnosticTab(conn);
          return;
      }

      const key = node.key;
      const isExpanded = expandedKeys.includes(key);
      const newExpandedKeys = isExpanded
          ? expandedKeys.filter(k => k !== key)
          : [...expandedKeys, key];

      setExpandedKeys(newExpandedKeys);
      if (!isExpanded) {
          setAutoExpandParent(false);
          if (shouldLoadSidebarNodeOnExpand(node)) {
              void onLoadData(node);
          }
      }
  };

  const renderSidebarSwitcherIcon = useCallback((node: SidebarTreeSwitcherNodeLike) => {
      if (node.isLeaf) {
          return null;
      }
      const keepCollapsed = shouldKeepSidebarSwitcherCollapsedWhileLoading(node, loadingNodesRef.current);
      return <CaretDownFilled rotate={keepCollapsed ? -90 : undefined} />;
  }, []);
  

  const buildRuntimeConfig = (conn: any, overrideDatabase?: string, clearDatabase: boolean = false) => {
      return buildRpcConnectionConfig(conn.config, {
          database: resolveSidebarRuntimeDatabase(
              conn?.config?.type,
              conn?.config?.driver,
              conn?.config?.database,
              overrideDatabase,
              clearDatabase,
              conn?.config?.oceanBaseProtocol,
          ),
      });
  };

  const buildJVMRuntimeConfig = (conn: SavedConnection & { dbName?: string }, providerMode: string) => {
      const sourceJVM = conn.config.jvm || {};
      return buildRpcConnectionConfig(conn.config, {
          database: '',
          jvm: {
              ...sourceJVM,
              preferredMode: providerMode as 'jmx' | 'endpoint' | 'agent',
              allowedModes: [providerMode as 'jmx' | 'endpoint' | 'agent'],
          },
      });
  };

  const openJVMOverviewTab = (conn: SavedConnection, providerMode: string) => {
      addTab({
          id: `jvm-overview-${conn.id}-${providerMode}`,
          title: buildJVMTabTitle(conn.name, 'overview', providerMode),
          type: 'jvm-overview',
          connectionId: conn.id,
          providerMode: providerMode as 'jmx' | 'endpoint' | 'agent',
      });
  };

  const openJVMMonitoringTab = (conn: SavedConnection, providerMode: string) => {
      addTab({
          id: `jvm-monitoring-${conn.id}-${providerMode}`,
          title: buildJVMTabTitle(conn.name, 'monitoring', providerMode),
          type: 'jvm-monitoring',
          connectionId: conn.id,
          providerMode: providerMode as 'jmx' | 'endpoint' | 'agent',
      });
  };

  const buildJVMDiagnosticTreeNodes = (conn: SavedConnection): TreeNode[] => {
      const descriptor = buildJVMDiagnosticActionDescriptor(conn.id, conn.config.jvm?.diagnostic, t);
      if (!descriptor) {
          return [];
      }
      return [{
          title: descriptor.title,
          key: descriptor.key,
          icon: <DashboardOutlined />,
          type: 'jvm-diagnostic',
          dataRef: {
              ...conn,
              diagnosticTransport: descriptor.transport,
          },
          isLeaf: true,
      }];
  };

  const openJVMResourceTab = (conn: SavedConnection, providerMode: string, resourcePath: string, resourceKind?: string) => {
      const trimmedResourcePath = String(resourcePath || '').trim();
      addTab({
          id: `jvm-resource-${conn.id}-${providerMode}-${encodeURIComponent(trimmedResourcePath)}`,
          title: trimmedResourcePath
              ? `${buildJVMTabTitle(conn.name, 'resource', providerMode)} · ${trimmedResourcePath}`
              : buildJVMTabTitle(conn.name, 'resource', providerMode),
          type: 'jvm-resource',
          connectionId: conn.id,
          providerMode: providerMode as 'jmx' | 'endpoint' | 'agent',
          resourcePath: trimmedResourcePath,
          resourceKind,
      });
  };

  const openJVMDiagnosticTab = (conn: SavedConnection) => {
      const transport = conn.config.jvm?.diagnostic?.transport || 'agent-bridge';
      addTab({
          id: `jvm-diagnostic-${conn.id}`,
          title: buildJVMTabTitle(conn.name, 'diagnostic', transport),
          type: 'jvm-diagnostic',
          connectionId: conn.id,
      });
  };

  const getConnectionNodeRef = (connRef: any) => {
      const latestConn = connections.find(c => c.id === connRef.id);
      return { key: connRef.id, dataRef: latestConn || connRef };
  };

  const getDatabaseNodeRef = (connRef: any, dbName: string) => {
      const latestConn = connections.find(c => c.id === connRef.id);
      return {
          title: dbName,
          key: `${connRef.id}-${dbName}`,
          dataRef: { ...(latestConn || connRef), dbName }
      };
  };

  const extractObjectName = (fullName: string) => {
      return splitQualifiedName(String(fullName || '').trim()).objectName || String(fullName || '').trim();
  };


  const resolveSavedQueryDisplayName = (name: string | null | undefined) => {
      const rawName = String(name || '').trim();
      return rawName || t('query_editor.save_modal.unnamed');
  };

  const openSavedQueryGroupModal = useCallback(async (
      target?: SavedQueryGroup | null,
      initialParentGroupId?: string | null,
  ) => {
      try {
          const groups = await reloadSavedQueryGroups();
          const targetId = String(target?.id || '').trim();
          if (targetId && !groups.some((group) => group.id === targetId)) {
              message.warning(t('sidebar.message.saved_query_group_not_found'));
              return;
          }
          const parentId = String(initialParentGroupId || '').trim();
          setSavedQueryGroupTargetId(targetId || null);
          setSavedQueryGroupInitialParentId(
              parentId && groups.some((group) => group.id === parentId) ? parentId : null,
          );
          setIsSavedQueryGroupModalOpen(true);
      } catch (error) {
          message.error(t('sidebar.message.saved_query_group_load_failed', {
              error: error instanceof Error ? error.message : String(error),
          }));
      }
  }, [reloadSavedQueryGroups]);

  const closeSavedQueryGroupModal = useCallback(() => {
      setIsSavedQueryGroupModalOpen(false);
      setSavedQueryGroupTargetId(null);
      setSavedQueryGroupInitialParentId(null);
  }, []);

  const handleSaveSavedQueryGroup = useCallback(async (group: SavedQueryGroup) => {
      const isEditing = Boolean(group.id);
      await saveSavedQueryGroup(group);
      message.success(t(
          isEditing
              ? 'sidebar.message.saved_query_group_updated'
              : 'sidebar.message.saved_query_group_created',
      ));
  }, [saveSavedQueryGroup]);

  const savedQueryGroupTarget = useMemo(
      () => savedQueryGroups.find((group) => group.id === savedQueryGroupTargetId) || null,
      [savedQueryGroupTargetId, savedQueryGroups],
  );

  const {
      loadDatabases,
      loadJVMResources,
      loadTables,
      loadNacosConfigGroups,
      loadNacosServiceGroups,
      invalidateConnectionLoads,
  } = useSidebarTreeLoaders({
      savedQueries,
      tableSortPreference,
      tableAccessCount,
      pinnedSidebarTables,
      pinnedSidebarDatabases,
      isV2Ui,
      loadingNodesRef,
      setConnectionStates,
      setLoadedKeys,
      replaceTreeNodeChildren,
      buildRuntimeConfig,
      buildJVMRuntimeConfig,
      buildJVMDiagnosticTreeNodes,
      resolveSavedQueryDisplayName,
      onDatabaseTreeLoaded: (databaseKey: string) => {
          databaseTreeTouchedAtRef.current[databaseKey] = Date.now();
          pruneLoadedDatabaseTrees();
      },
  });
  invalidateConnectionLoadsRef.current = invalidateConnectionLoads;
  loadNacosServiceGroupsRef.current = loadNacosServiceGroups;
  replaceTreeNodeChildrenRef.current = replaceTreeNodeChildren;

  // Rehydrate descendants that were open before the connection loader replaces its tree.
  const refreshConnectionResources = async (node: any): Promise<void> => {
      const connectionId = String(node?.key || node?.dataRef?.id || '').trim();
      if (!connectionId) return;

      const expandedKeysToReload = resolveSidebarConnectionRefreshKeys({
          treeData: treeDataRef.current,
          expandedKeys: expandedKeysRef.current,
          connectionId,
      });

      invalidateConnectionLoads(connectionId);
      setLoadedKeys((previous) => previous.filter((key) => !isConnectionTreeKey(key, connectionId)));
      Array.from(loadingNodesRef.current).forEach((loadingKey) => {
          if (loadingKey === `dbs-${connectionId}` || loadingKey.startsWith(`tables-${connectionId}-`)) {
              loadingNodesRef.current.delete(loadingKey);
          }
      });

      await loadDatabases(node);

      const loadedKeysToRestore = new Set<string>();
      const refreshedConnection = findTreeNodeByKeyRef.current(treeDataRef.current, connectionId);
      if (refreshedConnection?.children?.length) {
          loadedKeysToRestore.add(connectionId);
      }

      for (const key of expandedKeysToReload) {
          if (key === connectionId) continue;
          if (!expandedKeysRef.current.some((expandedKey) => String(expandedKey) === key)) {
              continue;
          }
          const currentNode = findTreeNodeByKeyRef.current(treeDataRef.current, key);
          if (!currentNode) continue;

          await onLoadData(currentNode);
          const loadedNode = findTreeNodeByKeyRef.current(treeDataRef.current, key);
          if (loadedNode?.children?.length) {
              loadedKeysToRestore.add(key);
          }
      }

      const availableConnectionKeys = new Set<string>();
      const collectConnectionKeys = (nodes: TreeNode[]) => {
          nodes.forEach((treeNode) => {
              const key = String(treeNode.key || '').trim();
              if (key && isConnectionTreeKey(key, connectionId)) {
                  availableConnectionKeys.add(key);
              }
              if (treeNode.children?.length) collectConnectionKeys(treeNode.children);
          });
      };
      collectConnectionKeys(treeDataRef.current);
      const expandedKeysBeforeRefresh = new Set(expandedKeysToReload);

      setExpandedKeys((previous) => previous.filter((key) => {
          const keyText = String(key);
          return !isConnectionTreeKey(keyText, connectionId)
              || !expandedKeysBeforeRefresh.has(keyText)
              || availableConnectionKeys.has(keyText);
      }));
      setLoadedKeys((previous) => {
          const next = previous.filter((key) => {
              const keyText = String(key);
              return !isConnectionTreeKey(keyText, connectionId) || availableConnectionKeys.has(keyText);
          });
          loadedKeysToRestore.forEach((key) => next.push(key));
          return Array.from(new Set(next));
      });
  };
  refreshConnectionResourcesRef.current = refreshConnectionResources;

  useEffect(() => {
      const handleSidebarDatabaseListRefresh = (event: Event) => {
          const request = normalizeSidebarDatabaseListRefreshRequest((event as CustomEvent).detail);
          if (!request) return;
          const connectionNode = findTreeNodeByKeyRef.current(
              treeDataRef.current,
              request.connectionId,
          );
          if (connectionNode) {
              void refreshConnectionResources(connectionNode);
          }
      };
      window.addEventListener(
          SIDEBAR_DATABASE_LIST_REFRESH_EVENT,
          handleSidebarDatabaseListRefresh as EventListener,
      );
      return () => {
          window.removeEventListener(
              SIDEBAR_DATABASE_LIST_REFRESH_EVENT,
              handleSidebarDatabaseListRefresh as EventListener,
          );
      };
  }, [refreshConnectionResources]);

  useEffect(() => {
      const handleNacosServicesChanged = (event: Event) => {
          const target = resolveNacosServiceGroupsRefreshTarget(
              (event as CustomEvent).detail,
              treeDataRef.current,
              expandedKeysRef.current,
          );
          if (!target) return;

          replaceTreeNodeChildrenRef.current(target.key, undefined);
          setLoadedKeys((prev) => prev.filter((key) => String(key) !== target.key));
          if (!target.shouldReload) return;

          void loadNacosServiceGroupsRef.current(
              { ...target.node, children: undefined },
              { force: true },
          ).then((loaded) => {
              if (!loaded) return;
              setLoadedKeys((prev) => prev.includes(target.key) ? prev : [...prev, target.key]);
          });
      };
      window.addEventListener(NACOS_SERVICES_CHANGED_EVENT, handleNacosServicesChanged as EventListener);
      return () => {
          window.removeEventListener(NACOS_SERVICES_CHANGED_EVENT, handleNacosServicesChanged as EventListener);
      };
  }, []);

  const supportsConnectionVisibility = useCallback((connection: SavedConnection): boolean => (
      getDataSourceCapabilities(connection.config).supportsPrimaryVisibility
  ), []);

  const openConnectionVisibilitySettings = useCallback((connection: SavedConnection, initialDatabase?: string) => {
      const currentConnection = connections.find((item) => item.id === connection.id) || connection;
      if (!supportsConnectionVisibility(currentConnection)) return;
      setConnectionVisibilityTarget({
          connection: currentConnection,
          initialDatabase: String(initialDatabase || '').trim() || undefined,
      });
  }, [connections, supportsConnectionVisibility]);

  const openSchemaVisibilitySettings = useCallback((node: any) => {
      const dbName = String(node?.dataRef?.dbName || node?.title || '').trim();
      const connectionId = String(node?.dataRef?.id || '').trim();
      const connection = connections.find((item) => item.id === connectionId) || node?.dataRef;
      if (!connection || !dbName) return;
      const capabilities = getDataSourceCapabilities((connection as SavedConnection).config);
      if (!capabilities.supportsSecondarySchemaVisibility) return;
      openConnectionVisibilitySettings(connection as SavedConnection, dbName);
  }, [connections, openConnectionVisibilitySettings]);

  const handleSaveConnectionVisibility = useCallback(async (
      draft: DatabaseSchemaVisibilityDraft,
  ) => {
      if (!connectionVisibilityTarget) return;
      setIsSavingConnectionVisibility(true);
      try {
          const target = connections.find(
              (item) => item.id === connectionVisibilityTarget.connection.id,
          ) || connectionVisibilityTarget.connection;
          const isRedis = target.config.type === 'redis';
          const backendApp = (window as any).go?.app?.App;
          if (typeof backendApp?.UpdateConnectionVisibility !== 'function') {
              throw new Error(t('connection_modal.message.save_failed'));
          }
          const saved = await backendApp.UpdateConnectionVisibility({
              id: target.id,
              includeDatabases: isRedis ? target.includeDatabases : draft.includeDatabases,
              includeDatabasePatterns: isRedis ? target.includeDatabasePatterns : draft.includeDatabasePatterns,
              excludeDatabasePatterns: isRedis ? target.excludeDatabasePatterns : draft.excludeDatabasePatterns,
              includeRedisDatabases: isRedis
                  ? draft.includeDatabases
                      .map((database) => Number(String(database).replace(/^db/i, '')))
                      .filter((database) => Number.isInteger(database) && database >= 0)
                  : target.includeRedisDatabases,
              schemaVisibilityByDatabase: isRedis
                  ? target.schemaVisibilityByDatabase
                  : draft.schemaVisibilityByDatabase,
          });
          const persistedConnection = saved as SavedConnection;
          connectionReloadSignaturesRef.current[persistedConnection.id] =
              buildConnectionReloadSignature(persistedConnection);
          updateConnection(persistedConnection);
          const connectionNodeKey = persistedConnection.id;
          setLoadedKeys((previous) => previous.filter(
              (key) => !isConnectionTreeKey(String(key), connectionNodeKey),
          ));
          replaceTreeNodeChildren(connectionNodeKey, undefined, persistedConnection);
          await loadDatabases(
              { key: connectionNodeKey, type: 'connection', dataRef: persistedConnection },
              { ensureFresh: true },
          );
          setExpandedKeys((previous) => previous.includes(connectionNodeKey)
              ? previous
              : [...previous, connectionNodeKey]);
          setConnectionVisibilityTarget(null);
          message.success(t('sidebar.database_schema_visibility.message.saved'));
      } catch (error: any) {
          message.error(t('sidebar.database_schema_visibility.message.save_failed', {
              error: error?.message || String(error),
          }));
      } finally {
          setIsSavingConnectionVisibility(false);
      }
  }, [connectionVisibilityTarget, connections, loadDatabases, updateConnection]);

  const persistConnectionVisibilityMetadata = useCallback(async (
      currentConnection: SavedConnection,
      nextConnection: SavedConnection,
  ): Promise<SavedConnection> => {
      if (
          JSON.stringify(nextConnection.includeDatabases || []) === JSON.stringify(currentConnection.includeDatabases || [])
          && JSON.stringify(nextConnection.schemaVisibilityByDatabase || {}) === JSON.stringify(currentConnection.schemaVisibilityByDatabase || {})
      ) {
          return currentConnection;
      }

      const backendApp = (window as any).go?.app?.App;
      if (typeof backendApp?.UpdateConnectionVisibility !== 'function') {
          message.warning(t('sidebar.schema_visibility.message.save_failed', {
              error: t('connection_modal.message.save_failed'),
          }));
          return currentConnection;
      }

      try {
          const saved = await backendApp.UpdateConnectionVisibility({
              id: nextConnection.id,
              includeDatabases: nextConnection.includeDatabases,
              includeDatabasePatterns: nextConnection.includeDatabasePatterns,
              excludeDatabasePatterns: nextConnection.excludeDatabasePatterns,
              includeRedisDatabases: nextConnection.includeRedisDatabases,
              schemaVisibilityByDatabase: nextConnection.schemaVisibilityByDatabase,
          });
          const persistedConnection = saved as SavedConnection;
          connectionReloadSignaturesRef.current[persistedConnection.id] =
              buildConnectionReloadSignature(persistedConnection);
          updateConnection(persistedConnection);
          return persistedConnection;
      } catch (error: any) {
          message.warning(t('sidebar.schema_visibility.message.save_failed', {
              error: error?.message || String(error),
          }));
          return currentConnection;
      }
  }, [updateConnection]);

  const migrateVisibilityForRenamedDatabase = useCallback(async (
      connection: SavedConnection,
      oldDbName: string,
      newDbName: string,
  ): Promise<SavedConnection> => {
      const currentConnection = connections.find((item) => item.id === connection.id) || connection;
      const capabilities = getDataSourceCapabilities(currentConnection.config);
      const nextConnection = {
          ...moveSchemaVisibilityRule(
              currentConnection,
              oldDbName,
              newDbName,
              { caseSensitive: capabilities.schemaIdentifierCaseSensitive },
          ),
          includeDatabases: moveExactDatabaseVisibilityEntry(
              currentConnection,
              oldDbName,
              newDbName,
          ),
      };
      return persistConnectionVisibilityMetadata(currentConnection, nextConnection);
  }, [connections, persistConnectionVisibilityMetadata]);

  const removeVisibilityForDeletedDatabase = useCallback(async (
      connection: SavedConnection,
      dbName: string,
  ): Promise<SavedConnection> => {
      const currentConnection = connections.find((item) => item.id === connection.id) || connection;
      const capabilities = getDataSourceCapabilities(currentConnection.config);
      const connectionNode = findTreeNodeByKeyRef.current(
          treeDataRef.current,
          currentConnection.id,
      );
      const remainingLoadedDatabases = Array.from(new Set(
          (connectionNode?.children || [])
              .filter((child) => child.type === 'database')
              .map((child) => String(child.dataRef?.dbName || child.title || '').trim())
              .filter((name) => name && name !== dbName),
      ));
      const exactIncludes = removeExactDatabaseVisibilityEntry(currentConnection, dbName);
      const nextConnection = {
          ...updateSchemaVisibilityRule(
              currentConnection,
              dbName,
              undefined,
              { caseSensitive: capabilities.schemaIdentifierCaseSensitive },
          ),
          includeDatabases: Array.isArray(currentConnection.includeDatabases)
              && currentConnection.includeDatabases.length > 0
              && exactIncludes?.length === 0
              ? (remainingLoadedDatabases.length > 0 ? remainingLoadedDatabases : [dbName])
              : exactIncludes,
      };
      return persistConnectionVisibilityMetadata(currentConnection, nextConnection);
  }, [connections, persistConnectionVisibilityMetadata]);

  const migrateVisibilityForRenamedSchema = useCallback(async (
      connection: SavedConnection,
      dbName: string,
      oldSchemaName: string,
      newSchemaName: string,
  ): Promise<SavedConnection> => {
      const currentConnection = connections.find((item) => item.id === connection.id) || connection;
      const capabilities = getDataSourceCapabilities(currentConnection.config);
      const nextConnection = moveSchemaVisibilityEntry(
          currentConnection,
          dbName,
          oldSchemaName,
          newSchemaName,
          { caseSensitive: capabilities.schemaIdentifierCaseSensitive },
      );
      return persistConnectionVisibilityMetadata(currentConnection, nextConnection);
  }, [connections, persistConnectionVisibilityMetadata]);

  const removeVisibilityForDeletedSchema = useCallback(async (
      connection: SavedConnection,
      dbName: string,
      schemaName: string,
  ): Promise<SavedConnection> => {
      const currentConnection = connections.find((item) => item.id === connection.id) || connection;
      const capabilities = getDataSourceCapabilities(currentConnection.config);
      const databaseNode = findTreeNodeByKeyRef.current(
          treeDataRef.current,
          `${currentConnection.id}-${dbName}`,
      );
      const normalizeSchemaName = (name: string) => (
          capabilities.schemaIdentifierCaseSensitive
              ? name
              : name.toLocaleLowerCase()
      );
      const deletedSchemaKey = normalizeSchemaName(schemaName);
      const remainingLoadedSchemas = (databaseNode?.children || [])
          .filter((child) => (
              child.type === 'object-group'
              && child.dataRef?.groupKey === 'schema'
              && String(child.dataRef?.id || '') === currentConnection.id
              && String(child.dataRef?.dbName || '') === dbName
          ))
          .map((child) => String(child.dataRef?.schemaName ?? '').trim())
          .filter((name) => name && normalizeSchemaName(name) !== deletedSchemaKey);
      const nextConnection = removeSchemaVisibilityEntry(
          currentConnection,
          dbName,
          schemaName,
          { caseSensitive: capabilities.schemaIdentifierCaseSensitive },
          remainingLoadedSchemas,
      );
      return persistConnectionVisibilityMetadata(currentConnection, nextConnection);
  }, [connections, persistConnectionVisibilityMetadata]);

  const migratePinnedDatabaseKey = useCallback((
      connectionId: string,
      oldDbName: string,
      newDbName?: string,
  ) => {
      if (!isSidebarDatabasePinned(pinnedSidebarDatabases, connectionId, oldDbName)) return;
      setSidebarDatabasePinned(connectionId, oldDbName, false);
      if (newDbName) {
          setSidebarDatabasePinned(connectionId, newDbName, true);
      }
  }, [pinnedSidebarDatabases, setSidebarDatabasePinned]);

  const {
      handleCopyStructure,
      handleCopyTable,
      handleCopyTableName,
      handleCopyDatabaseName,
      handleExport,
      openExportDialog,
      handleCopyTableAsInsert,
      openTableDdlInDesigner,
      openTableInERView,
      injectTablePromptToAI,
      handleCreateDatabase,
      openCreateSchemaModal,
      handleCreateSchema,
      openRenameSchemaModal,
      handleRenameSchema,
      handleDeleteSchema,
      handleRenameDatabase,
      handleDeleteDatabase,
      handleRenameTable,
      handleDeleteTable,
      handleTableDataDangerAction,
      openViewDefinition,
      openEditView,
      openCreateView,
      openCreateStarRocksMaterializedView,
      openCreateStarRocksExternalCatalog,
      openCreateStarRocksRollup,
      handleDropView,
      handleRenameView,
      openRenameSavedQueryModal,
      handleRenameSavedQuery,
      handleRevealSavedQueryInFolder,
      isSavedQueryUnmatched,
      handleRebindSavedQuery,
      openRoutineDefinition,
      openEventDefinition,
      openEditEvent,
      openSequenceDefinition,
      openPackageDefinition,
      openEditRoutine,
      openCreateRoutine,
      handleDropRoutine,
      handleCompileOracleObject,
      resolveMessagePublishTarget,
      openMessageQueueWorkbench,
      openMessagePublishModal,
      handleMessagePublishSuccess,
  } = useSidebarObjectActions({
      connections,
      connectionIds,
      connectionIdSet,
      tabs,
      treeDataRef,
      setTreeData,
      setExpandedKeys,
      setLoadedKeys,
      addTab,
      updateQueryTabDraft,
      saveQuery,
      addSqlLog,
      closeTabsByDatabase,
      createDbForm,
      targetConnection,
      isCreateDbModalOpen,
      setIsCreateDbModalOpen,
      createDbCharsets,
      setCreateDbCharsets,
      createDbCollations,
      setCreateDbCollations,
      loadingCreateDbOptions,
      setLoadingCreateDbOptions,
      createSchemaForm,
      createSchemaTarget,
      setCreateSchemaTarget,
      setIsCreateSchemaModalOpen,
      renameSchemaForm,
      renameSchemaTarget,
      setRenameSchemaTarget,
      setIsRenameSchemaModalOpen,
      renameDbForm,
      renameDbTarget,
      setRenameDbTarget,
      setIsRenameDbModalOpen,
      renameTableForm,
      renameTableTarget,
      setRenameTableTarget,
      setIsRenameTableModalOpen,
      renameViewForm,
      renameViewTarget,
      setRenameViewTarget,
      setIsRenameViewModalOpen,
      renameSavedQueryForm,
      renameSavedQueryTarget,
      setRenameSavedQueryTarget,
      setIsRenameSavedQueryModalOpen,
      setMessagePublishTarget,
      buildRuntimeConfig,
      getConnectionNodeRef,
      getDatabaseNodeRef,
      extractObjectName,
      isPostgresSchemaDialect,
      loadDatabases,
      loadTables,
      openDesign,
      onDoubleClick,
      runExportWithProgress,
      setAIPanelVisible,
      addAIContext,
      migrateVisibilityForRenamedDatabase,
      removeVisibilityForDeletedDatabase,
      migrateVisibilityForRenamedSchema,
      removeVisibilityForDeletedSchema,
      migratePinnedDatabaseKey,
  });



  const refreshV2TableContextMenuStatsRef = useRef<(node: any) => void>(() => {});

  const {
      getConnectionNodeForAction,
      handleV2TableContextMenuAction,
      handleTableGroupSortAction,
      handleV2TableGroupContextMenuAction,
      handleV2DatabaseContextMenuAction,
      disconnectConnectionNode,
      deleteConnectionNode,
      handleV2ConnectionContextMenuAction,
      handleV2ConnectionGroupContextMenuAction,
  } = useSidebarV2ActionHandlers({
      connections,
      connectionTags,
      pinnedSidebarTables,
      pinnedSidebarDatabases,
      loadingNodesRef,
      treeDataRef,
      refreshConnectionResources,
      invalidateConnectionLoads,
      findTreeNodeByKeyRef,
      refreshV2TableContextMenuStatsRef,
      setConnectionStates,
      setExpandedKeys,
      setLoadedKeys,
      setTargetConnection,
      setIsCreateDbModalOpen,
      setRenameDbTarget,
      setIsRenameDbModalOpen,
      setRenameTableTarget,
      setIsRenameTableModalOpen,
      setRenameViewTarget,
      setIsCreateTagModalOpen,
      renameDbForm,
      renameTableForm,
      createTagForm,
      addTab,
      closeTabsByDatabase,
      closeTabsByConnection,
      removeConnection,
      removeConnectionTag,
      moveConnectionToTag,
      setSidebarTablePinned,
      setSidebarDatabasePinned,
      setTableSortPreference,
      replaceTreeNodeChildren,
      loadDatabases,
      loadTables,
      getDatabaseNodeRef,
      extractObjectName,
      openDesign,
      openNewTableDesign,
      onDoubleClick,
      openMessageQueueWorkbench,
      openMessagePublishModal,
      openTableDdlInDesigner,
      openTableInERView,
      handleCopyTableName,
      handleCopyTable,
      handleCopyDatabaseName,
      handleCopyStructure,
      handleCopyTableAsInsert,
      openCreateStarRocksRollup,
      handleExport,
      openExportDialog,
      injectTablePromptToAI,
      handleTableDataDangerAction,
      handleDeleteTable,
      openCreateSchemaModal,
      openCreateStarRocksMaterializedView,
      openCreateStarRocksExternalCatalog,
      handleExportDatabaseSQL,
      openBatchTableWorkbench,
      openBatchDatabaseWorkbench,
      handleRunSQLFile,
      handleDeleteDatabase,
      onCreateConnectionInGroup,
      onEditConnection,
      openConnectionVisibilitySettings,
      handleDuplicateConnection,
      buildConnectionRootQueryTabTitle,
      buildConnectionRootRedisCommandTabTitle,
      buildConnectionRootRedisMonitorTabTitle,
  });
  useEffect(() => {
      const handleDeleteConnection = (event: Event) => {
          const connectionId = String(
              (event as CustomEvent<{ connectionId?: string }>).detail?.connectionId || '',
          ).trim();
          const connection = connections.find((item) => item.id === connectionId);
          if (connection) deleteConnectionNode(getConnectionNodeForAction(connection));
      };
      window.addEventListener('gonavi:delete-connection', handleDeleteConnection);
      return () => window.removeEventListener('gonavi:delete-connection', handleDeleteConnection);
  }, [connections, deleteConnectionNode, getConnectionNodeForAction]);
  const {
      onSearch,
      searchScopeSummary,
      searchScopePopoverContent,
      displayTreeData,
      v2CommandSearchObjectMode,
      v2CommandSearchAiMode,
      filteredCommandSearchTreeItems,
      filteredCommandSearchActionItems,
      filteredCommandSearchRecentItems,
      commandSearchAiItem,
      commandSearchFlatItems,
      flattenConnectionNodes,
      activeConnection,
      v2VisibleTreeData,
      v2TreeHorizontalScrollWidth,
      effectiveTreeHeight,
      v2TreeMetrics,
  } = useSidebarSearchModel({
      searchScopes,
      setSearchScopes,
      setSearchValue,
      deferredSearchValue,
      deferredV2CommandSearchValue,
      v2CommandSearchValue,
      setV2CommandActiveIndex,
      v2ExplorerFilter,
      sidebarTableMetadataFields,
      treeData: visibleSidebarTreeData,
      treeViewportWidth,
      treeHeight,
      isV2Ui,
      isV2CommandSearchOpen,
      connections,
      connectionIds,
      selectedKeys,
      selectedNodesRef,
      activeContext,
      activeTab,
      recentSqlLogs,
      shortcutOptions,
      activeShortcutPlatform,
      overlayTheme,
      darkMode,
      onCreateConnection,
      onToggleAI,
      onToggleLogPanel,
      setAIPanelVisible,
      extractObjectName,
  });
  useSidebarLayoutEffect(() => {
      if (!sidebarTreeScrollRequest) return;

      const renderedTreeData = isV2Ui ? v2VisibleTreeData : displayTreeData;
      const visiblePath = findSidebarNodePathByKey(
          renderedTreeData as SidebarLocateTreeNodeLike[],
          String(sidebarTreeScrollRequest.key),
      );
      if (!visiblePath) return;

      const expandedKeySet = new Set(expandedKeys.map((key) => String(key)));
      const visibleAncestorsExpanded = visiblePath
          .slice(0, -1)
          .every((key) => expandedKeySet.has(String(key)));
      if (!visibleAncestorsExpanded) return;

      const request = sidebarTreeScrollRequest;
      let cancelled = false;
      let attempt = 0;
      let frameId: number | null = null;
      const requestFrame = typeof window.requestAnimationFrame === 'function'
          ? window.requestAnimationFrame.bind(window)
          : (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0);
      const cancelFrame = typeof window.cancelAnimationFrame === 'function'
          ? window.cancelAnimationFrame.bind(window)
          : window.clearTimeout.bind(window);

      const findExactTreeRow = (): HTMLElement | null => {
          const nodeTitles = treeContainerRef.current
              ?.querySelectorAll<HTMLElement>('[data-sidebar-node-key]');
          const targetTitle = Array.from(nodeTitles || [])
              .find((element) => element.dataset.sidebarNodeKey === String(request.key));
          const exactRow = targetTitle?.closest('.ant-tree-treenode') as HTMLElement | null;
          if (exactRow) return exactRow;
          return isV2Ui
              ? null
              : treeContainerRef.current?.querySelector('.ant-tree-treenode-selected') as HTMLElement | null;
      };

      const attemptScroll = () => {
          if (cancelled || sidebarTreeScrollRequestIdRef.current !== request.id) return;
          treeRef.current?.scrollTo?.({ key: request.key, align: 'auto' });
          frameId = requestFrame(() => {
              if (cancelled || sidebarTreeScrollRequestIdRef.current !== request.id) return;
              const targetRow = findExactTreeRow();
              if (targetRow) {
                  targetRow.scrollIntoView?.({
                      block: request.scrollBlock,
                      inline: 'nearest',
                      behavior: 'auto',
                  });
                  setSidebarTreeScrollRequest((current) => current?.id === request.id ? null : current);
                  return;
              }
              attempt += 1;
              if (attempt < 6) {
                  frameId = requestFrame(attemptScroll);
              } else {
                  setSidebarTreeScrollRequest((current) => current?.id === request.id ? null : current);
              }
          });
      };

      frameId = requestFrame(attemptScroll);
      return () => {
          cancelled = true;
          if (frameId !== null) cancelFrame(frameId);
      };
  }, [displayTreeData, expandedKeys, isV2Ui, sidebarTreeScrollRequest, v2VisibleTreeData]);

  const activeConnectionIsMessageQueue = [
      'mqtt',
      'kafka',
      'rocketmq',
      'rabbitmq',
  ].includes(resolveDataSourceType(activeConnection?.config));
  const legacyToolbarButtonColor = darkMode ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)';
  const legacyToolbarStyle: React.CSSProperties = {
      padding: '6px 16px',
      display: 'grid',
      gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
      gap: 8,
      alignItems: 'center',
      justifyItems: 'center',
      borderTop: `1px solid ${darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'}`,
      borderBottom: `1px solid ${darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'}`,
      background: darkMode ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.015)',
  };
  const legacyToolbarItemStyle: React.CSSProperties = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 0,
  };
  const legacyToolbarDisabledWrapStyle: React.CSSProperties = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
  };

  const {
      contextMenu,
      setContextMenu,
      contextMenuPortalRef,
      openV2ConnectionContextMenu,
      getV2TreeMetaText,
      renderV2SidebarContextMenuContent,
      fetchV2TableContextMenuStats,
      refreshV2TableContextMenuStats,
  } = useSidebarV2ContextMenu({
      connections,
      connectionTags,
      activeShortcutPlatform,
      flattenConnectionNodes,
      v2TreeMetrics,
      tableSortPreference,
      pinnedSidebarTables,
      pinnedSidebarDatabases,
      getConnectionNodeForAction,
      buildRuntimeConfig,
      extractObjectName,
      isPostgresSchemaDialect,
      loadTables,
      getDatabaseNodeRef,
      handleExportSchemaSQL,
      handleDeleteSchema,
      openRenameSchemaModal,
      openSchemaVisibilitySettings,
      supportsConnectionVisibility,
      resolveMessagePublishTarget,
      addSqlLog,
      handleV2TableContextMenuAction,
      handleV2TableGroupContextMenuAction,
      handleV2DatabaseContextMenuAction,
      handleV2ConnectionContextMenuAction,
      handleV2ConnectionGroupContextMenuAction,
  });
  refreshV2TableContextMenuStatsRef.current = refreshV2TableContextMenuStats;
  const getV2TreeMetaTextRef = useRef(getV2TreeMetaText);
  getV2TreeMetaTextRef.current = getV2TreeMetaText;

  const renderV2TreeTitle = useCallback((node: any, hoverTitle: string, statusBadge: React.ReactNode) => renderSidebarV2TreeTitle({
      node,
      hoverTitle,
      statusBadge,
      getV2TreeMetaText: getV2TreeMetaTextRef.current,
      sidebarTableMetadataFields,
      snapshotTreeSelectionBeforeDrag,
      restoreTreeSelectionAfterDrag,
      treeDragSelectSuppressUntilRef,
      setIsTreeDragging,
      sidebarDropPlacement: sidebarTreeDropPreview?.nodeKey === String(node.key || '')
          ? sidebarTreeDropPreview.placement
          : null,
  }), [
      restoreTreeSelectionAfterDrag,
      setIsTreeDragging,
      sidebarTreeDropPreview,
      sidebarTableMetadataFields,
      snapshotTreeSelectionBeforeDrag,
      treeDragSelectSuppressUntilRef,
  ]);

  const revealCommandSearchNode = useCallback((node: TreeNode) => {
      const targetKey = node.key;
      const path = findSidebarNodePathByKey(
          treeDataRef.current as SidebarLocateTreeNodeLike[],
          String(targetKey),
      );
      setSearchValue('');
      setV2ExplorerFilter('all');
      if (path) mergeExpandedTreeKeys(path.slice(0, -1));
      setSidebarSelectedKeys([targetKey]);
      selectedNodesRef.current = [node];
      scrollSidebarTreeToKey(targetKey, 'center');
  }, [mergeExpandedTreeKeys, scrollSidebarTreeToKey, setSidebarSelectedKeys]);

  const {
      selectConnectionFromRail,
      runCommandSearchItem,
      handleV2CommandSearchKeyDown,
  } = useSidebarCommandSearchRunner({
      activeContext,
      activeTab,
      addTab,
      clearStaleHostStateOnSelection,
      closeV2CommandSearch,
      commandSearchFlatItems,
      connectionIds,
      queryCapableConnectionIds,
      findTreeNodeByKeyRef,
      locateObjectInSidebar,
      loadDatabases,
      mergeExpandedTreeKeys,
      onDoubleClick,
      publishTitlebarSelectionForNode,
      revealCommandSearchNode,
      scrollSidebarTreeToKey,
      selectedNodesRef,
      setActiveContext,
      setSelectedKeys: setSidebarSelectedKeys,
      setV2CommandActiveIndex,
      treeDataRef,
      v2CommandActiveIndex,
  });
  expandConnectionFromRailRef.current = (connectionId: string) => {
      const conn = connections.find((item) => item.id === connectionId);
      if (conn) {
          void selectConnectionFromRail(conn);
      }
  };

  const locateConnectionInSidebar = useCallback(async (detail: unknown) => {
      const request = normalizeSidebarLocateConnectionRequest(detail);
      if (!request) return;

      const connection = connections.find((item) => item.id === request.connectionId);
      if (!connection) return;

      onEnsureSidebarExpanded?.();
      setSearchValue('');
      await selectConnectionFromRail(connection);

      if (!request.dbName) {
          scrollSidebarTreeToKey(connection.id);
          return;
      }

      await waitForSidebarLoadKey(`dbs-${connection.id}`);
      const databaseNode = findTreeNodeByKeyRef.current(
          treeDataRef.current,
          `${connection.id}-${request.dbName}`,
      );
      if (!databaseNode) {
          scrollSidebarTreeToKey(connection.id);
          return;
      }

      const dbName = String(databaseNode.dataRef?.dbName || request.dbName).trim();
      setSidebarSelectedKeys([databaseNode.key]);
      selectedNodesRef.current = [databaseNode];
      setActiveContext({ connectionId: connection.id, dbName });
      publishTitlebarSelectionForNode(databaseNode);
      scrollSidebarTreeToKey(databaseNode.key);
  }, [connections, findTreeNodeByKeyRef, onEnsureSidebarExpanded, publishTitlebarSelectionForNode, scrollSidebarTreeToKey, selectConnectionFromRail, selectedNodesRef, setActiveContext, setSearchValue, setSidebarSelectedKeys, treeDataRef]);

  useEffect(() => {
      const handleLocateSidebarConnection = (event: Event) => {
          void locateConnectionInSidebar((event as CustomEvent).detail);
      };
      window.addEventListener(SIDEBAR_LOCATE_CONNECTION_EVENT, handleLocateSidebarConnection as EventListener);
      return () => {
          window.removeEventListener(SIDEBAR_LOCATE_CONNECTION_EVENT, handleLocateSidebarConnection as EventListener);
      };
  }, [locateConnectionInSidebar]);

  const getNodeMenuItems = (node: any): MenuProps['items'] => buildSidebarLegacyNodeMenuItems(node, {
    addTab,
    getMetadataDialect,
    shouldHideSchemaPrefix,
    openSchemaVisibilitySettings,
    openConnectionVisibilitySettings,
    supportsConnectionVisibility,
    handleV2DatabaseContextMenuAction,
    isPostgresSchemaDialect,
    handleExportSchemaSQL,
    openRenameSchemaModal,
    loadTables,
    getDatabaseNodeRef,
    handleDeleteSchema,
    tableSortPreference,
    isStructureOnlyDbType,
    openNewTableDesign,
    handleTableGroupSortAction,
    openCreateView,
    openCreateStarRocksMaterializedView,
    openCreateRoutine,
    createTagForm,
    setRenameViewTarget,
    setIsCreateTagModalOpen,
    removeConnectionTag,
    onCreateConnectionInGroup,
    setExpandedKeys,
    setLoadedKeys,
    loadingNodesRef,
    loadDatabases,
    refreshConnectionResources,
    buildConnectionRootRedisCommandTabTitle,
    buildConnectionRootRedisMonitorTabTitle,
    onEditConnection,
    handleDuplicateConnection,
    disconnectConnectionNode,
    deleteConnectionNode,
    connectionTags,
    moveConnectionToTag,
    setTargetConnection,
    setIsCreateDbModalOpen,
    buildConnectionRootQueryTabTitle,
    handleRunSQLFile,
    openCreateStarRocksExternalCatalog,
    openEditView,
    renameViewForm,
    setIsRenameViewModalOpen,
    handleDropView,
    onDoubleClick,
    openViewDefinition,
    openRoutineDefinition,
    openEditRoutine,
    handleDropRoutine,
    handleCompileOracleObject,
    openEventDefinition,
    openEditEvent,
    openSequenceDefinition,
    openPackageDefinition,
    resolveMessagePublishTarget,
    openMessageQueueWorkbench,
    openMessagePublishModal,
    openDesign,
    openCreateStarRocksRollup,
    handleCopyTableName,
    handleCopyTable,
    handleCopyStructure,
    handleExport,
    setRenameTableTarget,
    renameTableForm,
    setIsRenameTableModalOpen,
    handleTableDataDangerAction,
    handleDeleteTable,
    openExportDialog,
    openBatchTableWorkbench,
    openBatchDatabaseWorkbench,
    isSavedQueryUnmatched,
    connections,
    handleRebindSavedQuery,
    openRenameSavedQueryModal,
    handleRevealSavedQueryInFolder,
    resolveSavedQueryDisplayName,
    deleteQuery,
    savedQueryGroups,
    openSavedQueryGroupModal,
    deleteSavedQueryGroup,
    moveSavedQueryToGroup,
    treeDataRef,
    getNacosNamespaceDiscoveryMode: (connectionId: string) =>
      resolveNacosNamespaceDiscoveryModeFromTreeNode(
        findTreeNodeByKeyRef.current(treeDataRef.current, connectionId),
      ),
    setTreeData,
    handleAddExternalSQLDirectory,
    openCreateExternalSQLFileModal,
    openCreateExternalSQLDirectoryModal,
    openRenameExternalSQLDirectoryModal,
    handleRefreshExternalSQLDirectory,
    handleDeleteExternalSQLDirectory,
    handleRemoveExternalSQLDirectory,
    openExternalSQLFile,
    openExternalSQLBindingModal,
    openRenameExternalSQLFileModal,
    handleDeleteExternalSQLFile,
    extractObjectName,
  });

  const titleRender = useSidebarTitleRender({
      connectionStates,
      isV2Ui,
      renderV2TreeTitle,
      handleAddExternalSQLDirectory,
      snapshotTreeSelectionBeforeDrag,
      restoreTreeSelectionAfterDrag,
      treeDragSelectSuppressUntilRef,
      setIsTreeDragging,
  });
  const v2RailConnectionGroups = useMemo(
      () => buildV2RailConnectionGroups(connections, connectionTags, sidebarRootOrder, rootSortMode, rootConnectionSortMode),
      [connections, connectionTags, sidebarRootOrder, rootSortMode, rootConnectionSortMode],
  );
  const getTagParentId = (tagId: unknown): string | null => {
      const tag = connectionTags.find((candidate) => candidate.id === String(tagId || '').trim());
      const parentTagId = String(tag?.parentTagId || '').trim();
      return parentTagId || null;
  };

  const getConnectionParentTagId = (connectionId: unknown): string | null => (
      connectionTags.find((tag) => tag.connectionIds.includes(String(connectionId || '').trim()))?.id || null
  );

  const getNodeParentTagId = (node: any): string | null => {
      if (node?.type === 'tag') return getTagParentId(node?.dataRef?.id);
      if (node?.type === 'connection') return getConnectionParentTagId(node?.key);
      return null;
  };

  const getNodeOrderToken = (node: any): string | null => {
      if (node?.type === 'tag') {
          const tagId = String(node?.dataRef?.id || '').trim();
          return tagId ? buildSidebarRootTagToken(tagId) : null;
      }
      if (node?.type === 'connection') {
          const connectionId = String(node?.key || '').trim();
          return connectionId ? buildSidebarRootConnectionToken(connectionId) : null;
      }
      return null;
  };

  const clearSidebarGroupHoverExpandTimer = () => {
      if (sidebarGroupHoverExpandTimerRef.current === null) return;
      window.clearTimeout(sidebarGroupHoverExpandTimerRef.current);
      sidebarGroupHoverExpandTimerRef.current = null;
  };

  const updateSidebarTreeDropPreview = (
      nextPreview: { nodeKey: string; placement: SidebarTreeDropPlacement } | null,
  ) => {
      const previousPreview = sidebarTreeDropPreviewRef.current;
      if (
          previousPreview?.nodeKey === nextPreview?.nodeKey
          && previousPreview?.placement === nextPreview?.placement
      ) {
          return;
      }

      clearSidebarGroupHoverExpandTimer();
      sidebarTreeDropPreviewRef.current = nextPreview;
      setSidebarTreeDropPreview(nextPreview);
      if (!nextPreview || nextPreview.placement !== 'inside') return;
      if (expandedKeysRef.current.some((key) => String(key) === nextPreview.nodeKey)) return;

      sidebarGroupHoverExpandTimerRef.current = window.setTimeout(() => {
          sidebarGroupHoverExpandTimerRef.current = null;
          const activePreview = sidebarTreeDropPreviewRef.current;
          if (
              activePreview?.nodeKey !== nextPreview.nodeKey
              || activePreview.placement !== 'inside'
          ) {
              return;
          }
          setExpandedKeys((previous) => previous.some((key) => String(key) === nextPreview.nodeKey)
              ? previous
              : [...previous, nextPreview.nodeKey]);
          setAutoExpandParent(false);
      }, SIDEBAR_GROUP_HOVER_EXPAND_DELAY_MS);
  };

  const clearSidebarTreeDragVisuals = () => {
      clearSidebarGroupHoverExpandTimer();
      sidebarTreeDropPreviewRef.current = null;
      setSidebarTreeDropPreview(null);
      sidebarTreeDragNodeRef.current = null;
      setSidebarTreeDragNodeType(null);
      sidebarTreeDragPreviewElementRef.current?.remove();
      sidebarTreeDragPreviewElementRef.current = null;
      setIsTreeDragging(false);
  };

  const resolveSidebarHostGroupDropAtEvent = (event: {
      clientX?: number;
      clientY?: number;
      target?: EventTarget | null;
  }) => {
      if (!isV2Ui) return null;
      const dragNode = sidebarTreeDragNodeRef.current;
      if (dragNode?.type !== 'connection') return null;
      const hit = resolveSidebarDropDomHit(event);
      if (!hit || hit.type !== 'tag') return null;
      const dropNode = findTreeNodeByKeyRef.current(treeDataRef.current, hit.key);
      if (!dropNode || dropNode.type !== 'tag') return null;
      const placement = resolveSidebarTreeDropPlacement({
          dragNodeType: dragNode.type,
          dropNodeType: dropNode.type,
          relativeDropPosition: 0,
          dropToGap: undefined,
          fallbackInsertBefore: false,
          metrics: hit.metrics ? {
              clientY: event.clientY,
              top: hit.metrics.top,
              height: hit.metrics.height,
          } : null,
      });
      return { dragNode, dropNode, hit, placement };
  };

  const handleSidebarTreeDragOverCapture = (event: React.DragEvent<HTMLDivElement>) => {
      const resolvedDrop = resolveSidebarHostGroupDropAtEvent(event);
      if (!resolvedDrop) {
          updateSidebarTreeDropPreview(null);
          return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'move';
      }
      updateSidebarTreeDropPreview({
          nodeKey: resolvedDrop.hit.key,
          placement: resolvedDrop.placement,
      });
  };

  const handleSidebarTreeDropCapture = (event: React.DragEvent<HTMLDivElement>) => {
      const resolvedDrop = resolveSidebarHostGroupDropAtEvent(event);
      if (!resolvedDrop) return;

      event.preventDefault();
      event.stopPropagation();
      const connectionId = String(resolvedDrop.dragNode.key || '').trim();
      const tagId = String(resolvedDrop.dropNode?.dataRef?.id || '').trim();
      if (connectionId && tagId) {
          const destination = resolveSidebarHostGroupDropDestination({
              targetTagId: tagId,
              targetTagParentId: getTagParentId(tagId),
              targetTagToken: getNodeOrderToken(resolvedDrop.dropNode),
              placement: resolvedDrop.placement,
          });
          moveConnectionToTag(
              connectionId,
              destination.targetParentTagId,
              destination.targetToken,
              destination.insertBefore,
          );
      }
      restoreTreeSelectionAfterDrag();
      clearSidebarTreeDragVisuals();
  };

  const allowSidebarTreeDrop = ({ dragNode, dropNode, dropPosition }: any): boolean => {
      if (!dragNode || !dropNode) return false;
      if ((dragNode.type !== 'tag' && dragNode.type !== 'connection') || (dropNode.type !== 'tag' && dropNode.type !== 'connection')) {
          return false;
      }
      // Connections cannot contain tree items. A group can contain a group only
      // when the pointer lands on its content, not on its before/after gap.
      const droppingIntoTag = dropNode.type === 'tag' && Number(dropPosition) === 0;
      if (dropNode.type === 'connection' && Number(dropPosition) === 0) return false;
      if (dragNode.type !== 'tag') return String(dragNode.key) !== String(dropNode.key);

      const dragTagId = String(dragNode?.dataRef?.id || '').trim();
      const targetParentTagId = droppingIntoTag
          ? String(dropNode?.dataRef?.id || '').trim() || null
          : getNodeParentTagId(dropNode);
      return !!dragTagId && !isConnectionTagDescendant(dragTagId, targetParentTagId, connectionTags);
  };

  const handleDrop = (info: any) => {
      clearSidebarTreeDragVisuals();
      const dropPosition = normalizeSidebarTreeRelativeDropPosition(
          Number(info.dropPosition || 0),
          info?.node?.pos,
      );
      const domDropHit = resolveSidebarDropDomHit(info?.event);
      const domDropNode = domDropHit ? { key: domDropHit.key, type: domDropHit.type } : null;
      const dropTargetMetrics = domDropHit?.metrics || null;
      const insertBefore = resolveSidebarDropInsertBefore(dropPosition, dropTargetMetrics ? {
          clientY: info?.event?.clientY,
          top: dropTargetMetrics.top,
          height: dropTargetMetrics.height,
      } : null);
      const dragNode = info.dragNode;
      const dropNode = domDropNode && domDropNode.key === String(info?.node?.key || '')
          ? info.node
          : (domDropNode
              ? findTreeNodeByKeyRef.current(treeDataRef.current, domDropNode.key) || info.node
              : info.node);
      if (!dragNode || !dropNode) return;

      const placement: SidebarTreeDropPlacement = isV2Ui
          ? resolveSidebarTreeDropPlacement({
              dragNodeType: dragNode.type,
              dropNodeType: dropNode.type,
              relativeDropPosition: dropPosition,
              dropToGap: info?.dropToGap,
              fallbackInsertBefore: insertBefore,
              metrics: dropTargetMetrics ? {
                  clientY: info?.event?.clientY,
                  top: dropTargetMetrics.top,
                  height: dropTargetMetrics.height,
              } : null,
          })
          : (dropNode.type === 'tag' && info?.dropToGap === false
              ? 'inside'
              : (insertBefore ? 'before' : 'after'));
      const droppingIntoTag = dropNode.type === 'tag' && placement === 'inside';
      const targetParentTagId = droppingIntoTag
          ? String(dropNode?.dataRef?.id || '').trim() || null
          : getNodeParentTagId(dropNode);
      const targetToken = droppingIntoTag ? null : getNodeOrderToken(dropNode);
      const targetInsertBefore = droppingIntoTag ? false : placement === 'before';

      if (dragNode.type === 'tag') {
          const dragTagId = String(dragNode?.dataRef?.id || '').trim();
          if (!dragTagId || isConnectionTagDescendant(dragTagId, targetParentTagId, connectionTags)) return;
          moveConnectionTag(dragTagId, targetParentTagId, targetToken, targetInsertBefore);
          return;
      }

      if (dragNode.type === 'connection') {
          const connectionId = String(dragNode.key || '').trim();
          if (!connectionId || connectionId === String(dropNode.key || '')) return;
          moveConnectionToTag(connectionId, targetParentTagId, targetToken, targetInsertBefore);
      }
  };

  const onRightClick = ({ event, node }: any) => {
      if (isV2Ui && (node?.type === 'v2-table-section' || node?.type === 'v2-database-section')) {
          event.preventDefault();
          event.stopPropagation();
          return;
      }
      if (isV2Ui && node?.type === 'tag') {
          const group = resolveV2ConnectionGroup(node, v2RailConnectionGroups);
          if (group) {
              event.preventDefault();
              event.stopPropagation();
              const position = resolveSidebarContextMenuPosition(event.clientX, event.clientY);
              setContextMenu({
                  x: position.x,
                  y: position.y,
                  sourceX: event.clientX,
                  sourceY: event.clientY,
                  items: [],
                  kind: 'v2-connection-group',
                  node: group,
                  rootClassName: 'gn-v2-table-context-menu-popup',
                  overlayStyle: { width: 264, maxWidth: 'calc(100vw - 24px)' },
                  maxHeight: position.maxHeight,
              });
              return;
          }
      }
      if (isV2Ui && node?.type === 'connection') {
          openV2ConnectionContextMenu(event, node);
          return;
      }
      if (isV2Ui && node?.type === 'database') {
          const position = resolveSidebarContextMenuPosition(event.clientX, event.clientY);
          setContextMenu({
              x: position.x,
              y: position.y,
              sourceX: event.clientX,
              sourceY: event.clientY,
              items: [],
              kind: 'v2-database',
              node,
              rootClassName: 'gn-v2-table-context-menu-popup',
              overlayStyle: { width: 264, maxWidth: 'calc(100vw - 24px)' },
              maxHeight: position.maxHeight,
          });
          return;
      }
      if (
          isV2Ui
          && node?.type === 'object-group'
          && node?.dataRef?.groupKey === 'schema'
          && isPostgresSchemaDialect(getMetadataDialect(node.dataRef as SavedConnection))
          && String(node?.dataRef?.schemaName || '').trim()
      ) {
          const position = resolveSidebarContextMenuPosition(event.clientX, event.clientY);
          setContextMenu({
              x: position.x,
              y: position.y,
              sourceX: event.clientX,
              sourceY: event.clientY,
              items: [],
              kind: 'v2-schema',
              node,
              rootClassName: 'gn-v2-table-context-menu-popup',
              overlayStyle: { width: 264, maxWidth: 'calc(100vw - 24px)' },
              maxHeight: position.maxHeight,
          });
          return;
      }
      if (isV2Ui && node?.type === 'object-group' && node?.dataRef?.groupKey === 'tables') {
          const position = resolveSidebarContextMenuPosition(event.clientX, event.clientY);
          setContextMenu({
              x: position.x,
              y: position.y,
              sourceX: event.clientX,
              sourceY: event.clientY,
              items: [],
              kind: 'v2-table-group',
              node,
              rootClassName: 'gn-v2-table-context-menu-popup',
              overlayStyle: { width: 264, maxWidth: 'calc(100vw - 24px)' },
              maxHeight: position.maxHeight,
          });
          return;
      }
      if (isV2Ui && node?.type === 'table') {
          const position = resolveSidebarContextMenuPosition(event.clientX, event.clientY);
          setContextMenu({
              x: position.x,
              y: position.y,
              sourceX: event.clientX,
              sourceY: event.clientY,
              items: [],
              kind: 'v2-table',
              node,
              rootClassName: 'gn-v2-table-context-menu-popup',
              overlayStyle: { width: 264, maxWidth: 'calc(100vw - 24px)' },
              maxHeight: position.maxHeight,
          });
          return;
      }
      const items = getNodeMenuItems(node);
      if (items && items.length > 0) {
          setContextMenu({
              x: event.clientX,
              y: event.clientY,
              items
          });
      }
  };

  const v2RailObjectActionsLabel = t('sidebar.rail.object_actions');
  const v2RailSystemActionsLabel = t('sidebar.rail.system_actions');
  const v2NewGroupLabel = t('sidebar.action.new_group');
  const v2BatchActionsLabel = t('sidebar.action.batch_operations');
  const v2BatchTablesLabel = t('sidebar.action.batch_tables');
  const v2BatchDatabasesLabel = t('sidebar.action.batch_databases');
  const v2DataImportLabel = t('sidebar.action.data_import');
  const v2DataWorkflowLabel = t('app.tools.group.workflow.title');
  const v2SchemaCompareLabel = t('app.tools.entry.schema_compare.title');
  const v2DataCompareLabel = t('app.tools.entry.data_compare.title');
  const v2DataSyncLabel = t('app.tools.entry.sync.title');
  const v2SqlToolsLabel = t('sidebar.action.sql_tools');
  const v2SlowQueryLabel = t('sql_analysis.slow_query.rail.aria_label');
  const v2SqlAuditLabel = t('sql_audit.rail.aria_label');
  const v2OpenExternalSqlFileLabel = t('sidebar.sql_file_exec.title');
  const v2LocateCurrentTableLabel = t('sidebar.action.locate_current_table');
  const v2LocateCurrentTableUnavailableLabel = t('sidebar.message.locate_current_table_unavailable');
  const v2AiAssistantLabel = t('app.sidebar.ai_assistant');
  const v2SettingsLabel = t('app.sidebar.settings');
  const v2ConnectionActionsLabel = t('sidebar.active_connection.actions');
  const v2ScrollToTopLabel = t('sidebar.action.scroll_to_top');
  const v2CommandSearchLabel = t('sidebar.command_search.label');
  const v2CommandSearchPlaceholder = t('sidebar.command_search.placeholder');

  const scrollV2ExplorerToTop = () => {
    treeRef.current?.scrollTo?.({ index: 0, align: 'top' });
  };

  const v2ExplorerToolbarActionProps = {
    labels: {
      objectActions: v2RailObjectActionsLabel,
      locateCurrentTable: v2LocateCurrentTableLabel,
      locateCurrentTableUnavailable: v2LocateCurrentTableUnavailableLabel,
      scrollToTop: v2ScrollToTopLabel,
      connectionActions: v2ConnectionActionsLabel,
      systemActions: v2RailSystemActionsLabel,
      aiAssistant: v2AiAssistantLabel,
      settings: v2SettingsLabel,
    },
    canLocateActiveTab,
    hasActiveConnection: Boolean(activeConnection),
    aiActive: aiPanelVisible,
    onLocateCurrentTable: handleLocateActiveTabInSidebar,
    onScrollToTop: scrollV2ExplorerToTop,
    onOpenConnectionActions: (event: React.MouseEvent<HTMLElement>) => {
      if (activeConnection) {
        openV2ConnectionContextMenu(event, activeConnection);
      }
    },
    onToggleAI,
    onOpenSettings,
  };

  const handleOpenDataImportWorkbench = useCallback(() => {
    const node = selectedNodesRef.current[0];
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    const nodeConnectionId = String(
      node?.dataRef?.id || (node?.type === 'connection' ? node?.key : '') || '',
    ).trim();
    const connectionId = nodeConnectionId || String(activeContext?.connectionId || '').trim();
    const dbName = String(
      node?.type === 'database'
        ? (node?.dataRef?.dbName || node?.title || '')
        : node?.dataRef?.dbName || activeContext?.dbName || '',
    ).trim();
    const tableName = String(
      node?.type === 'table'
        ? (node?.dataRef?.tableName || node?.title || '')
        : !node && activeTab?.type === 'table'
          ? activeTab.tableName || ''
          : '',
    ).trim();
    const mode = node?.type === 'database' ? 'database' : 'table';

    openDataImportWorkbench({ connectionId, dbName, tableName, mode });
  }, [activeContext?.connectionId, activeContext?.dbName, activeTabId, openDataImportWorkbench, tabs]);

  const handleOpenSlowQueryWorkbench = useCallback(() => {
    if (!activeTabHasConnection || !activeTab?.connectionId) return;
    addTab(buildSqlAnalysisWorkbenchTab({
      connectionId: activeTab.connectionId,
      dbName: activeTab.dbName,
      view: 'slow-query',
    }));
  }, [activeTab?.connectionId, activeTab?.dbName, activeTabHasConnection, addTab]);

  const handleOpenSqlAuditWorkbench = useCallback(() => {
    addTab(buildSqlAuditWorkbenchTab());
  }, [addTab]);

  const v2TitlebarQuickActions: TitleBarQuickAction[] = [
    {
      key: 'new-group',
      label: v2NewGroupLabel,
      icon: <FolderOpenOutlined aria-hidden="true" />,
      onClick: () => { setRenameViewTarget(null); createTagForm.resetFields(); setIsCreateTagModalOpen(true); },
      priority: 'secondary',
    },
    {
      key: 'batch-actions',
      label: v2BatchActionsLabel,
      icon: <AppstoreOutlined aria-hidden="true" />,
      menu: [
        {
          key: 'batch-tables',
          label: v2BatchTablesLabel,
          icon: <TableOutlined aria-hidden="true" />,
          onClick: openBatchTableWorkbench,
        },
        {
          key: 'batch-databases',
          label: v2BatchDatabasesLabel,
          icon: <DatabaseOutlined aria-hidden="true" />,
          onClick: openBatchDatabaseWorkbench,
        },
        {
          key: 'data-import',
          label: v2DataImportLabel,
          icon: <ImportOutlined aria-hidden="true" />,
          onClick: handleOpenDataImportWorkbench,
        },
      ],
    },
    {
      key: 'sql-tools',
      label: v2SqlToolsLabel,
      icon: <ToolOutlined aria-hidden="true" />,
      menu: [
        {
          key: 'slow-query',
          label: v2SlowQueryLabel,
          icon: <HistoryOutlined aria-hidden="true" />,
          onClick: handleOpenSlowQueryWorkbench,
          disabled: !activeTabHasConnection,
        },
        {
          key: 'sql-audit',
          label: v2SqlAuditLabel,
          icon: <AuditOutlined aria-hidden="true" />,
          onClick: handleOpenSqlAuditWorkbench,
        },
      ],
    },
    {
      key: 'data-workflow',
      label: v2DataWorkflowLabel,
      icon: <SwitcherOutlined aria-hidden="true" />,
      priority: 'secondary',
      menu: [
        {
          key: 'schema-compare',
          label: v2SchemaCompareLabel,
          icon: <AppstoreOutlined aria-hidden="true" />,
          onClick: () => onOpenDataSyncWorkbench?.('schemaCompare'),
        },
        {
          key: 'data-compare',
          label: v2DataCompareLabel,
          icon: <SwitcherOutlined aria-hidden="true" />,
          onClick: () => onOpenDataSyncWorkbench?.('dataCompare'),
        },
        {
          key: 'data-sync',
          label: v2DataSyncLabel,
          icon: <UploadOutlined rotate={90} aria-hidden="true" />,
          onClick: () => onOpenDataSyncWorkbench?.('sync'),
        },
      ],
    },
    {
      key: 'connection-package',
      label: t('app.tools.group.config.title'),
      icon: <HddOutlined aria-hidden="true" />,
      priority: 'secondary',
      menu: [
        {
          key: 'import-connections',
          label: t('app.tools.entry.import.title'),
          icon: <UploadOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'config', action: 'import-connections' }),
        },
        {
          key: 'export-connections',
          label: t('app.tools.entry.export.title'),
          icon: <DownloadOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'config', action: 'export-connections' }),
        },
      ],
    },
    {
      key: 'drivers',
      label: t('app.tools.entry.drivers.title'),
      icon: <SettingOutlined aria-hidden="true" />,
      onClick: () => onOpenSettingsNavigation?.({ group: 'workspace', pane: 'drivers' }),
    },
    {
      key: 'open-external-sql-file',
      label: v2OpenExternalSqlFileLabel,
      icon: <FileAddOutlined aria-hidden="true" />,
      onClick: () => { void handleOpenSQLFileFromToolbar(); },
      priority: 'secondary',
    },
    // Settings center groups (same order as 设置 left nav)
    {
      key: 'settings-preferences',
      label: t('app.settings.group.preferences.title'),
      icon: <SettingOutlined aria-hidden="true" />,
      priority: 'secondary',
      menu: [
        {
          key: 'language',
          label: t('settings.language.title'),
          icon: <GlobalOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'preferences', pane: 'language' }),
        },
        {
          key: 'theme',
          label: t('app.settings.entry.theme.title'),
          icon: <SkinOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'preferences', pane: 'theme' }),
        },
        {
          key: 'brand-icon',
          label: t('app.settings.entry.brand_icon.title'),
          icon: <AppstoreOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'preferences', pane: 'brand-icon' }),
        },
        {
          key: 'sidebar-metadata',
          label: t('app.settings.sidebar_metadata.title'),
          icon: <TableOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'preferences', pane: 'sidebar-metadata' }),
        },
        {
          key: 'sidebar-objects',
          label: t('app.settings.sidebar_objects.title'),
          icon: <FolderOpenOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'preferences', pane: 'sidebar-objects' }),
        },
      ],
    },
    {
      key: 'settings-services',
      label: t('app.settings.group.services.title'),
      icon: <GlobalOutlined aria-hidden="true" />,
      priority: 'secondary',
      menu: [
        {
          key: 'proxy',
          label: t('app.settings.entry.proxy.title'),
          icon: <GlobalOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'services', pane: 'proxy' }),
        },
        {
          key: 'download-source',
          label: t('app.settings.entry.download_source.title'),
          icon: <CloudDownloadOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'services', pane: 'download-source' }),
        },
        ...(isWebRuntime ? [{
          key: 'web-auth',
          label: t('app.settings.entry.web_auth.title'),
          icon: <SafetyCertificateOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'services', pane: 'web-auth' }),
        }] : []),
        {
          key: 'cloud-backup',
          label: t('app.settings.entry.cloud_backup.title'),
          icon: <CloudDownloadOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'services', pane: 'cloud-backup' }),
        },
        {
          key: 'ai',
          label: t('app.settings.entry.ai.title'),
          icon: <RobotOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'services', pane: 'ai' }),
        },
      ],
    },
    {
      key: 'settings-config',
      label: t('app.tools.group.config.title'),
      icon: <SettingOutlined aria-hidden="true" />,
      priority: 'secondary',
      menu: [
        {
          key: 'data-root',
          label: t('app.tools.entry.data_root.title'),
          icon: <HddOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'config', pane: 'data-root' }),
        },
        {
          key: 'security-update',
          label: t('app.tools.entry.security_update.title'),
          icon: <SafetyCertificateOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'config', pane: 'security-update' }),
        },
      ],
    },
    {
      key: 'settings-workflow',
      label: t('app.tools.group.workflow.title'),
      icon: <SwitcherOutlined aria-hidden="true" />,
      priority: 'secondary',
      menu: [
        {
          key: 'schema-compare',
          label: t('app.tools.entry.schema_compare.title'),
          icon: <AppstoreOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'workflow', action: 'schema-compare' }),
        },
        {
          key: 'data-compare',
          label: t('app.tools.entry.data_compare.title'),
          icon: <SwitcherOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'workflow', action: 'data-compare' }),
        },
        {
          key: 'sync',
          label: t('app.tools.entry.sync.title'),
          icon: <UploadOutlined rotate={90} aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'workflow', action: 'sync' }),
        },
      ],
    },
    {
      key: 'settings-workspace',
      label: t('app.tools.group.workspace.title'),
      icon: <CodeOutlined aria-hidden="true" />,
      priority: 'secondary',
      menu: [
        {
          key: 'snippet-settings',
          label: t('app.tools.entry.snippets.title'),
          icon: <CodeOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'workspace', pane: 'snippet-settings' }),
        },
        {
          key: 'shortcut-settings',
          label: t('app.tools.entry.shortcuts.title'),
          icon: <LinkOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'workspace', pane: 'shortcut-settings' }),
        },
        {
          key: 'sql-audit',
          label: t('app.tools.entry.sql_audit.title'),
          icon: <AuditOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'workspace', action: 'sql-audit' }),
        },
      ],
    },
  ];
  // 关于 GoNavi（在线更新入口）单独放在「更多」按钮右侧，减少操作层级
  const v2TitlebarAboutActions: TitleBarQuickAction[] = [
    {
      key: 'about-go-navi',
      label: t('app.settings.group.about.title'),
      icon: <InfoCircleOutlined aria-hidden="true" />,
      onClick: () => onOpenSettingsNavigation?.({ group: 'about', pane: 'about-go-navi' }),
    },
  ];
  const v2TitlebarQuickActionsTarget = isV2Ui && typeof document !== 'undefined'
    ? document.getElementById('gonavi-titlebar-quick-actions')
    : null;

  const v2CommandSearchPanelProps: SidebarSearchPanelProps<V2CommandSearchItem> = {
    isOpen: isV2CommandSearchOpen,
    searchValue: v2CommandSearchValue,
    activeIndex: v2CommandActiveIndex,
    label: v2CommandSearchLabel,
    placeholder: v2CommandSearchPlaceholder,
    aiMode: v2CommandSearchAiMode,
    objectMode: v2CommandSearchObjectMode,
    flatItems: commandSearchFlatItems,
    sections: {
      goTo: filteredCommandSearchTreeItems,
      ai: commandSearchAiItem,
      actions: filteredCommandSearchActionItems,
      recent: filteredCommandSearchRecentItems,
    },
    inputRef: commandSearchInputRef,
    handlers: {
      onSearchValueChange: handleV2CommandSearchValueChange,
      onKeyDown: handleV2CommandSearchKeyDown,
      onClose: closeV2CommandSearch,
      onItemSelect: (item: V2CommandSearchItem) => runCommandSearchItem(item),
      onItemHover: (key: string) => setV2CommandActiveIndex(commandSearchFlatItems.findIndex((entry) => entry.key === key)),
      onRemoveRecentItem: (item: V2CommandSearchItem) => {
        if (item.kind === 'recent') hideSqlLogFromRecent(item.logId);
      },
      onClearRecentItems: clearRecentSqlLogs,
    },
  };

  // V2 Connection Rail 子组件 props（从原 renderV2ConnectionRail 抽出，保留所有原行为）
  const v2ConnectionRailProps = {
    labels: {
      railSystemActions: v2RailSystemActionsLabel,
      railObjectActions: v2RailObjectActionsLabel,
      newGroup: v2NewGroupLabel,
      batchTables: v2BatchTablesLabel,
      batchDatabases: v2BatchDatabasesLabel,
      dataImport: v2DataImportLabel,
      openExternalSqlFile: v2OpenExternalSqlFileLabel,
      locateCurrentTable: v2LocateCurrentTableLabel,
      locateCurrentTableUnavailable: v2LocateCurrentTableUnavailableLabel,
      aiAssistant: v2AiAssistantLabel,
      settings: v2SettingsLabel,
    },
    handlers: {
      openCreateTagModal: () => { setRenameViewTarget(null); createTagForm.resetFields(); setIsCreateTagModalOpen(true); },
      openBatchTableExport: openBatchTableWorkbench,
      openBatchDatabaseExport: openBatchDatabaseWorkbench,
      openDataImport: handleOpenDataImportWorkbench,
      openExternalSqlFile: handleOpenSQLFileFromToolbar,
      locateActiveTab: handleLocateActiveTabInSidebar,
      toggleAI: onToggleAI ?? (() => {}),
      openSettings: onOpenSettings ?? (() => {}),
    },
    canLocateActiveTab,
    showObjectActions: false,
    showLocateAction: false,
    aiActive: aiPanelVisible,
    sidebarExpandAction: !collapsedSidebarActionsTarget && onExpandSidebar && expandSidebarLabel ? {
      label: expandSidebarLabel,
      onClick: onExpandSidebar,
      buttonRef: expandSidebarButtonRef,
    } : undefined,
  };

  return (
    <div className={isV2Ui ? 'gn-v2-sidebar-redesign' : undefined} style={{ display: 'flex', height: '100%', minHeight: 0 }}>
        {exportProgressModal}
        {isV2Ui && <SidebarConnectionRail {...v2ConnectionRailProps} />}
        <div
            id={isV2Ui ? 'gonavi-sidebar-tree-panel' : undefined}
            className={isV2Ui ? 'gn-v2-object-explorer' : undefined}
            data-sidebar-tree-panel={isV2Ui ? 'true' : undefined}
            style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, flex: 1 }}
        >
        {isV2Ui && (
            <div
                className="gn-v2-explorer-actions"
                role="toolbar"
                aria-label={v2RailSystemActionsLabel}
                data-sidebar-explorer-actions="true"
            >
                {v2ExplorerContext && <V2ExplorerContextSummary context={v2ExplorerContext} />}
                {!v2UseLegacySidebarFilter && (
                    <div
                        className="gn-v2-explorer-action-group is-search"
                        role="group"
                        aria-label={v2CommandSearchLabel}
                        data-v2-sidebar-search-mode="command"
                    >
                        <Tooltip title={v2CommandSearchLabel} placement="bottom" mouseEnterDelay={0.35}>
                            <Button
                                size="small"
                                type="text"
                                className="gn-v2-explorer-tool"
                                icon={<SearchOutlined />}
                                aria-label={v2CommandSearchLabel}
                                data-sidebar-command-search-action="true"
                                data-v2-command-search-icon-only="true"
                                onClick={() => {
                                    openV2CommandSearch();
                                    onFocusCommandSearch?.();
                                }}
                            />
                        </Tooltip>
                    </div>
                )}
                <V2ExplorerToolbarActions
                    {...v2ExplorerToolbarActionProps}
                    toggleAction={onCollapseSidebar && collapseSidebarLabel ? {
                      label: collapseSidebarLabel,
                      onClick: onCollapseSidebar,
                      buttonRef: collapseSidebarButtonRef,
                      placement: 'explorer-toolbar',
                      expanded: true,
                    } : undefined}
                />
            </div>
        )}

        {(!isV2Ui || v2UseLegacySidebarFilter) && (
        <div className={isV2Ui ? 'gn-v2-explorer-search' : undefined} style={{ padding: '8px 14px', borderBottom: `1px solid ${darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'}` }}>
            {isV2Ui ? (
                <div className="gn-v2-explorer-legacy-filter-row" data-v2-sidebar-search-mode="filter">
                    <Input
                        {...noAutoCapInputProps}
                        ref={searchInputRef}
                        value={searchValue}
                        placeholder={t('sidebar.search.placeholder')}
                        onChange={onSearch}
                        size="small"
                        prefix={<SearchOutlined />}
                    />
                    <Tooltip title={searchValue ? t('sidebar.command_search.reset_filter') : t('sidebar.command_search.no_filter_content')}>
                        <button
                            type="button"
                            className="gn-v2-explorer-filter-action"
                            aria-label={t('sidebar.command_search.reset_filter')}
                            disabled={!searchValue}
                            onClick={resetV2SidebarFilter}
                        >
                            <ReloadOutlined />
                        </button>
                    </Tooltip>
                </div>
            ) : (
                <Input
                    {...noAutoCapInputProps}
                    ref={searchInputRef}
                    placeholder={t('sidebar.search.placeholder')}
                    onChange={onSearch}
                    size="small"
                    prefix={<SearchOutlined style={{ color: darkMode ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)' }} />}
                    style={{
                        borderRadius: 6,
                        border: 'none',
                        background: darkMode ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.03)',
                        boxShadow: 'none',
                        padding: '4px 8px',
                        color: darkMode ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.85)',
                    }}
                    suffix={(
                        <Popover
                            content={searchScopePopoverContent}
                            trigger="click"
                            placement="bottomRight"
                            open={isSearchScopePopoverOpen}
                            onOpenChange={setIsSearchScopePopoverOpen}
                            styles={{ body: { padding: 0, borderRadius: 16, overflow: 'hidden' } }}
                        >
                            <Tooltip title={t('sidebar.command_search.scope.tooltip', { scope: searchScopeSummary })}>
                                <div
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 4,
                                        cursor: 'pointer',
                                        padding: '2px 6px',
                                        borderRadius: 4,
                                        background: isSearchScopePopoverOpen
                                            ? (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)')
                                            : 'transparent',
                                        transition: 'background 0.2s',
                                        color: searchScopes.includes('smart')
                                            ? (darkMode ? '#ffd666' : '#1677ff')
                                            : (darkMode ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)'),
                                    }}
                                    onMouseEnter={(e) => {
                                        if (!isSearchScopePopoverOpen) {
                                          e.currentTarget.style.background = darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)';
                                          e.currentTarget.style.color = darkMode ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.65)';
                                        }
                                    }}
                                    onMouseLeave={(e) => {
                                        if (!isSearchScopePopoverOpen) {
                                          e.currentTarget.style.background = 'transparent';
                                          e.currentTarget.style.color = searchScopes.includes('smart')
                                              ? (darkMode ? '#ffd666' : '#1677ff')
                                              : (darkMode ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)');
                                        }
                                    }}
                                >
                                    <FilterOutlined style={{ fontSize: 13 }} />
                                    <span style={{ fontSize: 12, fontWeight: 500 }}>
                                        {searchScopes.includes('smart') ? t('sidebar.command_search.scope.compact_smart') : searchScopes.length}
                                    </span>
                                </div>
                            </Tooltip>
                        </Popover>
                    )}
                />
            )}
        </div>
        )}

        {isV2Ui && !activeConnectionIsMessageQueue && (
            <div className="gn-v2-explorer-filter-tabs" aria-label={t('sidebar.command_search.object_kind.filter_aria')}>
                {V2_EXPLORER_FILTER_OPTIONS.map((item) => (
                    <button
                        key={item.key}
                        type="button"
                        className={v2ExplorerFilter === item.key ? 'is-active' : undefined}
                        aria-pressed={v2ExplorerFilter === item.key}
                        onClick={() => setV2ExplorerFilter(item.key)}
                    >
                        {t(item.labelKey)}
                    </button>
                ))}
            </div>
        )}

        {/* Toolbar */}
        {!isV2Ui && (
        <div data-sidebar-legacy-toolbar="true" style={legacyToolbarStyle}>
            <div data-sidebar-legacy-toolbar-item="true" style={legacyToolbarItemStyle}>
                <Tooltip title={t('sidebar.action.new_group')}>
                    <Button
                        size="small"
                        type="text"
                        icon={<FolderOpenOutlined />}
                        aria-label={t('sidebar.action.new_group')}
                        data-sidebar-create-group-action="true"
                        onClick={() => { setRenameViewTarget(null); createTagForm.resetFields(); setIsCreateTagModalOpen(true); }}
                        style={{ color: legacyToolbarButtonColor }}
                    />
                </Tooltip>
            </div>
            <div data-sidebar-legacy-toolbar-item="true" style={legacyToolbarItemStyle}>
                <Tooltip title={t('sidebar.action.batch_tables')}>
                    <Button
                        size="small"
                        type="text"
                        icon={<TableOutlined />}
                        aria-label={t('sidebar.action.batch_tables')}
                        data-sidebar-batch-table-action="true"
                        onClick={openBatchTableWorkbench}
                        style={{ color: legacyToolbarButtonColor }}
                    />
                </Tooltip>
            </div>
            <div data-sidebar-legacy-toolbar-item="true" style={legacyToolbarItemStyle}>
                <Tooltip title={t('sidebar.action.batch_databases')}>
                    <Button
                        size="small"
                        type="text"
                        icon={<DatabaseOutlined />}
                        aria-label={t('sidebar.action.batch_databases')}
                        data-sidebar-batch-database-action="true"
                        onClick={openBatchDatabaseWorkbench}
                        style={{ color: legacyToolbarButtonColor }}
                    />
                </Tooltip>
            </div>
            <div data-sidebar-legacy-toolbar-item="true" style={legacyToolbarItemStyle}>
                <Tooltip title={v2DataImportLabel}>
                    <Button
                        size="small"
                        type="text"
                        icon={<ImportOutlined />}
                        aria-label={v2DataImportLabel}
                        data-sidebar-data-import-action="true"
                        onClick={handleOpenDataImportWorkbench}
                        style={{ color: legacyToolbarButtonColor }}
                    />
                </Tooltip>
            </div>
            <div data-sidebar-legacy-toolbar-item="true" style={legacyToolbarItemStyle}>
                <Tooltip title={v2OpenExternalSqlFileLabel}>
                    <Button
                        size="small"
                        type="text"
                        icon={<FileAddOutlined />}
                        aria-label={v2OpenExternalSqlFileLabel}
                        data-sidebar-open-external-sql-file-action="true"
                        onClick={handleOpenSQLFileFromToolbar}
                        style={{ color: legacyToolbarButtonColor }}
                    />
                </Tooltip>
            </div>
            <div data-sidebar-legacy-toolbar-item="true" style={legacyToolbarItemStyle}>
                <Tooltip title={canLocateActiveTab ? t('sidebar.action.locate_current_tab') : t('sidebar.message.locate_current_tab_unavailable')}>
                    <span style={legacyToolbarDisabledWrapStyle}>
                        <Button
                            size="small"
                            type="text"
                            icon={<AimOutlined />}
                            aria-label={t('sidebar.action.locate_current_tab')}
                            data-sidebar-locate-current-tab-action="true"
                            disabled={!canLocateActiveTab}
                            onClick={handleLocateActiveTabInSidebar}
                            style={{ color: legacyToolbarButtonColor }}
                        />
                    </span>
                </Tooltip>
            </div>
        </div>
        )}

        <div
            ref={treeContainerRef}
            className={`sidebar-tree-scroll-shell${isV2Ui ? ' gn-v2-explorer-tree-shell' : ''}${isTreeScrolling ? ' is-vertical-scrolling' : ''}${sidebarTreeDragNodeType === 'connection' ? ' is-host-tree-dragging' : ''}${sidebarTreeDropPreview ? ' has-host-group-drop-preview' : ''}`}
            onWheelCapture={handleTreeWheel}
            onTouchMoveCapture={markTreeScrollActivity}
            onDragEnterCapture={handleSidebarTreeDragOverCapture}
            onDragOverCapture={handleSidebarTreeDragOverCapture}
            onDropCapture={handleSidebarTreeDropCapture}
            onDragLeaveCapture={(event) => {
                const relatedTarget = event.relatedTarget as Node | null;
                if (!relatedTarget || !event.currentTarget.contains(relatedTarget)) {
                    updateSidebarTreeDropPreview(null);
                }
            }}
            style={{
                flex: 1,
                overflow: 'hidden',
                minHeight: 0,
            }}
        >
            <div className="sidebar-tree-scroll-content">
                <Tree
                    key={`${isV2Ui ? `v2-tree-${v2ExplorerFilter}` : 'legacy-tree'}-${sidebarObjectVisibilitySignature}`}
                    ref={treeRef}
                    showIcon
                    draggable={{
                        icon: false,
                        nodeDraggable: (node: any) => node.type === 'connection' || node.type === 'tag'
                    }}
                    allowDrop={allowSidebarTreeDrop}
                    onDragStart={({ event, node }: any) => {
                        snapshotTreeSelectionBeforeDrag();
                        treeDragSelectSuppressUntilRef.current = Date.now() + 600;
                        sidebarTreeDragNodeRef.current = node;
                        setSidebarTreeDragNodeType(isV2Ui ? String(node?.type || '') || null : null);
                        if (isV2Ui) updateSidebarTreeDropPreview(null);
                        sidebarTreeDragPreviewElementRef.current?.remove();
                        sidebarTreeDragPreviewElementRef.current = isV2Ui
                            ? createSidebarTreeDragPreview(event, node)
                            : null;
                        setIsTreeDragging(true);
                    }}
                    onDragEnter={() => {
                        treeDragSelectSuppressUntilRef.current = Date.now() + 600;
                        setIsTreeDragging(true);
                    }}
                    onDragEnd={() => {
                        restoreTreeSelectionAfterDrag();
                        clearSidebarTreeDragVisuals();
                    }}
                    onDrop={handleDrop}
                    loadData={onLoadData}
                    treeData={isV2Ui ? v2VisibleTreeData : displayTreeData}
                    onDoubleClick={onDoubleClick}
                    onSelect={onSelect}
                    titleRender={titleRender}
                    switcherIcon={renderSidebarSwitcherIcon}
                    expandedKeys={expandedKeys}
                    onExpand={onExpand}
                    loadedKeys={loadedKeys}
                    onLoad={setLoadedKeys}
                    autoExpandParent={autoExpandParent}
                    selectedKeys={selectedKeys}
                    blockNode
                    height={effectiveTreeHeight}
                    scrollWidth={isV2Ui ? v2TreeHorizontalScrollWidth : undefined}
                    onRightClick={onRightClick}
                />
            </div>
        </div>

        </div>
        <SidebarSearchPanel {...v2CommandSearchPanelProps} />

        {collapsedSidebarActionsTarget && createPortal(
          <V2ExplorerToolbarActions
            {...v2ExplorerToolbarActionProps}
            onLocateCurrentTable={() => {
              handleLocateActiveTabInSidebar();
            }}
            onScrollToTop={() => {
              onExpandSidebar?.();
              scrollV2ExplorerToTop();
            }}
            toggleAction={onExpandSidebar && expandSidebarLabel ? {
              label: expandSidebarLabel,
              onClick: onExpandSidebar,
              buttonRef: expandSidebarButtonRef,
              placement: 'collapsed-titlebar',
              expanded: false,
            } : undefined}
          />,
          collapsedSidebarActionsTarget,
        )}

        {v2TitlebarQuickActionsTarget && createPortal(
          <TitleBarQuickActions
            label={v2RailObjectActionsLabel}
            moreLabel={t('query_editor.action.more')}
            actions={v2TitlebarQuickActions}
            trailingActions={v2TitlebarAboutActions}
          />,
          v2TitlebarQuickActionsTarget,
        )}

        {contextMenu?.kind && typeof document !== 'undefined' && createPortal(
            <div
                ref={contextMenuPortalRef}
                className={`gn-v2-sidebar-context-menu-portal ${contextMenu.rootClassName || ''}`}
                data-gonavi-close-shortcut-guard="true"
                data-gonavi-close-shortcut-blocks-background="true"
                style={{
                    position: 'fixed',
                    left: contextMenu.x,
                    top: contextMenu.y,
                    zIndex: APP_POPUP_Z_INDEX,
                    width: contextMenu.overlayStyle?.width ?? SIDEBAR_CONTEXT_MENU_FALLBACK_WIDTH,
                    maxWidth: contextMenu.overlayStyle?.maxWidth ?? 'calc(100vw - 24px)',
                    ['--gn-v2-context-menu-max-height' as any]: `${contextMenu.maxHeight ?? SIDEBAR_CONTEXT_MENU_FALLBACK_HEIGHT}px`,
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.preventDefault()}
            >
                {renderV2SidebarContextMenuContent(contextMenu)}
            </div>,
            document.body,
        )}

        {contextMenu && !contextMenu.kind && (
            <Dropdown
                menu={{ items: contextMenu.items }}
                open={true}
                onOpenChange={(open) => { if (!open) setContextMenu(null); }}
                trigger={['contextMenu']}
                rootClassName={contextMenu.rootClassName}
                overlayStyle={contextMenu.overlayStyle}
            >
                <div style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, width: 1, height: 1 }} />
            </Dropdown>
        )}

        <SidebarEntityModals
            connections={connections}
            connectionTags={connectionTags}
            modalPanelStyle={modalPanelStyle}
            modalSectionStyle={modalSectionStyle}
            modalScrollSectionStyle={modalScrollSectionStyle}
            renderSidebarModalTitle={renderSidebarModalTitle}
            isCreateTagModalOpen={isCreateTagModalOpen}
            setIsCreateTagModalOpen={setIsCreateTagModalOpen}
            createTagForm={createTagForm}
            renameViewTarget={renameViewTarget}
            updateConnectionTag={updateConnectionTag}
            addConnectionTag={addConnectionTag}
            isCreateDbModalOpen={isCreateDbModalOpen}
            setIsCreateDbModalOpen={setIsCreateDbModalOpen}
            createDbForm={createDbForm}
            handleCreateDatabase={handleCreateDatabase}
            createDbTarget={targetConnection}
            createDbCharsets={createDbCharsets}
            createDbCollations={createDbCollations}
            loadingCreateDbOptions={loadingCreateDbOptions}
            isCreateSchemaModalOpen={isCreateSchemaModalOpen}
            setIsCreateSchemaModalOpen={setIsCreateSchemaModalOpen}
            createSchemaForm={createSchemaForm}
            createSchemaTarget={createSchemaTarget}
            setCreateSchemaTarget={setCreateSchemaTarget}
            handleCreateSchema={handleCreateSchema}
            isRenameSchemaModalOpen={isRenameSchemaModalOpen}
            setIsRenameSchemaModalOpen={setIsRenameSchemaModalOpen}
            renameSchemaForm={renameSchemaForm}
            renameSchemaTarget={renameSchemaTarget}
            setRenameSchemaTarget={setRenameSchemaTarget}
            handleRenameSchema={handleRenameSchema}
            isRenameDbModalOpen={isRenameDbModalOpen}
            setIsRenameDbModalOpen={setIsRenameDbModalOpen}
            renameDbForm={renameDbForm}
            renameDbTarget={renameDbTarget}
            setRenameDbTarget={setRenameDbTarget}
            handleRenameDatabase={handleRenameDatabase}
            isRenameTableModalOpen={isRenameTableModalOpen}
            setIsRenameTableModalOpen={setIsRenameTableModalOpen}
            renameTableForm={renameTableForm}
            renameTableTarget={renameTableTarget}
            setRenameTableTarget={setRenameTableTarget}
            handleRenameTable={handleRenameTable}
            isRenameViewModalOpen={isRenameViewModalOpen}
            setIsRenameViewModalOpen={setIsRenameViewModalOpen}
            renameViewForm={renameViewForm}
            setRenameViewTarget={setRenameViewTarget}
            handleRenameView={handleRenameView}
            isRenameSavedQueryModalOpen={isRenameSavedQueryModalOpen}
            setIsRenameSavedQueryModalOpen={setIsRenameSavedQueryModalOpen}
            renameSavedQueryForm={renameSavedQueryForm}
            renameSavedQueryTarget={renameSavedQueryTarget}
            setRenameSavedQueryTarget={setRenameSavedQueryTarget}
            handleRenameSavedQuery={handleRenameSavedQuery}
        />

        <SavedQueryGroupModal
            open={isSavedQueryGroupModalOpen}
            groups={savedQueryGroups}
            savedQueries={savedQueries}
            target={savedQueryGroupTarget}
            initialParentGroupId={savedQueryGroupInitialParentId}
            modalPanelStyle={modalPanelStyle}
            modalSectionStyle={modalSectionStyle}
            modalScrollSectionStyle={modalScrollSectionStyle}
            renderModalTitle={renderSidebarModalTitle}
            onClose={closeSavedQueryGroupModal}
            onSave={handleSaveSavedQueryGroup}
        />

        {connectionVisibilityTarget && (() => {
            const target = connectionVisibilityTarget.connection;
            const capabilities = getDataSourceCapabilities(target.config);
            const isRedis = target.config.type === 'redis';
            const source = isRedis ? {
                includeDatabases: target.includeRedisDatabases?.map((database) => `db${database}`),
                schemaVisibilityByDatabase: undefined,
            } : target;
            const primaryKind = capabilities.navigation.primaryKind;
            const primaryLabel = t(`sidebar.database_schema_visibility.primary.${primaryKind}`);
            return (
                <DatabaseSchemaVisibilityModal
                    open
                    connectionName={target.name}
                    source={source}
                    initialDatabase={isRedis
                        ? undefined
                        : connectionVisibilityTarget.initialDatabase}
                    primaryLabel={primaryLabel}
                    supportsSchemas={!isRedis && capabilities.supportsSecondarySchemaVisibility}
                    databaseCaseSensitive={capabilities.schemaIdentifierCaseSensitive}
                    schemaCaseSensitive={capabilities.schemaIdentifierCaseSensitive}
                    saving={isSavingConnectionVisibility}
                    loadDatabases={async () => {
                        const backendApp = (window as any).go?.app?.App;
                        const result = isRedis
                            ? await backendApp.RedisGetDatabases(buildRpcConnectionConfig(target.config))
                            : await backendApp.DBGetDatabases(buildRpcConnectionConfig(target.config));
                        if (!result?.success) {
                            throw new Error(result?.message || t('sidebar.database_schema_visibility.message.load_failed_fallback'));
                        }
                        const rows = Array.isArray(result.data) ? result.data : [];
                        return isRedis
                            ? rows
                                .map((row: any) => Number(row?.index ?? row?.Index))
                                .filter((database: number) => Number.isInteger(database) && database >= 0)
                                .map((database: number) => `db${database}`)
                            : rows
                                .map((row: any) => String(row?.Database ?? row?.database ?? '').trim())
                                .filter(Boolean);
                    }}
                    loadSchemas={async (database) => loadSchemas(target, database)}
                    onCancel={() => setConnectionVisibilityTarget(null)}
                    onSave={handleSaveConnectionVisibility}
                />
            );
        })()}

        {isWebRuntime ? (
          <input
            {...browserSQLFileInputProps}
            data-sidebar-browser-sql-file-input="true"
          />
        ) : null}
        <ExternalSQLFileModal {...externalSQLFileModalProps} />
        <ExternalSQLBindingModal {...externalSQLBindingModalProps} />

        <FindInDatabaseModal
            open={findInDbContext.open}
            onClose={() => setFindInDbContext({ open: false, connectionId: '', dbName: '' })}
            connectionId={findInDbContext.connectionId}
            dbName={findInDbContext.dbName}
        />
        <MessagePublishModal
            open={Boolean(messagePublishTarget)}
            connection={messagePublishTarget?.connection || null}
            executionDbName={messagePublishTarget?.executionDbName || ''}
            defaultDestination={messagePublishTarget?.destination || ''}
            defaultExchange={messagePublishTarget?.exchange || ''}
            onCancel={() => setMessagePublishTarget(null)}
            onSuccess={handleMessagePublishSuccess}
        />
    </div>
  );
});

export default Sidebar;
