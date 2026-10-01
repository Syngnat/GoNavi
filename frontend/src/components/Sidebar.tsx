import SidebarConnectionRail from './sidebar/SidebarConnectionRail';
import Modal from './common/ResizableDraggableModal';
import { type TitleBarQuickAction } from './TitleBarQuickActions';
import { TitlebarGraphIcon, TitlebarSqlToolIcon } from './titlebar/gonaviTitlebarIcons';
import { buildTitlebarTrailingActions } from './sidebar/titlebarTrailingActions';
import { renderSidebarObjectIcon } from './sidebar/sidebarObjectIcons';
import { GnDatabaseIcon, GnFieldsIcon, GnFolderIcon, GnFolderOpenIcon, GnIndexIcon, GnLinkIcon, GnSqlDocIcon } from './icons/gnIcons';
import TitleBarQuickActionsHost from './TitleBarQuickActionsHost';
import { type DataSyncEntryModeAlias } from './dataSyncEntryMode';
import type { DatabaseCharsetOption, DatabaseCollationOption } from '../utils/databaseCharset';
import SidebarSearchPanel, { type SidebarSearchPanelProps } from './sidebar/SidebarSearchPanel';
import { buildSidebarNodeMenuItems } from './sidebar/sidebarNodeMenu';
import { useSidebarCommandSearchCopy } from './sidebar/useSidebarCommandSearchCopy';
import { useCommandSearchDestinations } from './sidebar/useCommandSearchDestinations';
import type { SettingsCenterNavigationTarget } from './settings/settingsCenterMenuCatalog';
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
import { renderSidebarV2TreeTitle, type SidebarTreeConnectionStatus } from './sidebar/SidebarTreeTitle';
import {
  useSidebarV2ContextMenu,
} from './sidebar/useSidebarV2ContextMenu';
import {
  useSidebarObjectActions,
  type SidebarMessagePublishTarget,
} from './sidebar/useSidebarObjectActions';
import { tryOpenSidebarObjectNode } from './sidebar/sidebarOpenObjectNode';
import { useSidebarSearchModel } from './sidebar/useSidebarSearchModel';
import { useV2ExplorerFilterReset } from './sidebar/useV2ExplorerFilterReset';
import SidebarFilterSlot from './sidebar/SidebarFilterSlot';
import { useSidebarFilterPersistence } from './sidebar/useSidebarFilterPersistence';
import { useSidebarV2ActionHandlers } from './sidebar/useSidebarV2ActionHandlers';
import { useSidebarCommandSearchRunner } from './sidebar/useSidebarCommandSearchRunner';
import { useSidebarTitleRender } from './sidebar/useSidebarTitleRender';
import {
  normalizeDriverType,
  useSidebarTreeLoaders,
} from './sidebar/useSidebarTreeLoaders';
import * as sidebarTreeDrag from './sidebar/sidebarTreeDragOrder';
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
  shouldLoadSidebarNodeOnExpand,
  resolveSidebarDoubleClickExpandedKeys,
  getV2RailConnectionGroupBadgeText,
  resolveSidebarTitlebarObjectName,
  resolveSidebarTableNameForCopy,
  resolveSidebarDatabaseNameForCopy,
  isV2SidebarObjectNode,
  clearSidebarHostConnectionState,
  shouldDeferSidebarTitlebarSelection,
  type V2ExplorerFilter,
} from './sidebar/sidebarHelpers';
// 重新导出，保持外部测试文件的 `from './Sidebar'` 兼容
export {
  V2_RAIL_UNGROUPED_CONNECTION_GROUP_ID,
  formatSidebarRowCount,
  hasSidebarLazyChildren,
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
import { Tree, message, MenuProps, Input, Button, Form, Popover, Radio, Select, Tooltip } from 'antd';
import { APP_POPUP_Z_INDEX } from '../utils/overlayZIndex';
import { createSidebarResizeAwareFrameScheduler } from '../utils/sidebarResizeLifecycle';
	import {
	  AppstoreOutlined,
	  AuditOutlined,
	  CaretDownFilled,
	  ClockCircleOutlined,
	  CloudOutlined,
	  CloudDownloadOutlined,
	  CodeOutlined,
	  DatabaseOutlined,
	  DownloadOutlined,
	  EyeOutlined,
	  GlobalOutlined,
	  HistoryOutlined,
	  LoadingOutlined,
	  TableOutlined,
	  SwitcherOutlined,
	  UploadOutlined,
	  ConsoleSqlOutlined,
  HddOutlined,
  CopyOutlined,
  ExportOutlined,
  FolderAddOutlined,
  SaveOutlined,
  EditOutlined,
  SearchOutlined,
  FunctionOutlined,
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
  SafetyCertificateOutlined,
  SkinOutlined,
	} from '@ant-design/icons';
import { V2ExplorerSearchAction, V2ExplorerToolbarActions, V2RailExplorerActions } from './sidebar/SidebarExplorerToolbar';
import { useStore } from '../store';
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
import { useSidebarWorkbenchLaunchers } from './sidebar/useSidebarWorkbenchLaunchers';
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
  collectSidebarLocateExpandKeys,
  findSidebarNodePathByKey,
  findSidebarNodePathForLocate,
  SIDEBAR_LOCATE_CONNECTION_EVENT,
  normalizeSidebarLocateConnectionRequest,
  normalizeSidebarLocateObjectRequest,
  resolveSidebarLocateTarget,
  type SidebarLocateTreeNodeLike,
} from '../utils/sidebarLocate';
import {
  runSidebarLocateDatabaseObject,
  waitForSidebarLocateLoadKey,
} from './sidebar/sidebarLocateDatabaseObject';
import {
  canLocateSidebarActiveTab,
  describeSidebarLocateFailure,
  dispatchSidebarActiveQueryTableLocate,
  resolveSidebarActiveTabLocateAction,
} from './sidebar/sidebarLocateActiveTab';
import {
  runSidebarTreeScrollRequest,
  type SidebarTreeScrollRequest,
} from './sidebar/sidebarTreeScrollRequest';
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
  resolveSidebarTreeRowKey,
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
  resolveSidebarTreeRowHeight,
  collectSidebarSubtreeKeys,
  filterV2CommandSearchTreeItems,
  filterV2ExplorerTreeByKind,
  isSidebarDatabasePinned,
  isSidebarTablePinned,
  isConnectionTagDescendant,
  normalizeSidebarTreeRelativeDropPosition,
  resolveSidebarConnectionIdFromKey,
  resolveSidebarConnectionRefreshKeys,
  resolveSidebarDropDomHit,
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
  resolveSidebarTreeRowHeight,
  collectSidebarSubtreeKeys,
  filterV2CommandSearchTreeItems,
  filterV2ExplorerTreeByKind,
  isSidebarDatabasePinned,
  isSidebarTablePinned,
  isConnectionTagDescendant,
  normalizeSidebarTreeRelativeDropPosition,
  resolveSidebarConnectionIdFromKey,
  resolveSidebarConnectionRefreshKeys,
  resolveSidebarDropDomHit,
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
export {
  resolveSidebarHostGroupDropDestination,
  resolveSidebarTagDropInsertBefore,
} from './sidebarV2Utils';
export type { SidebarDropDomHit, SidebarTreeDropPlacement, V2CommandSearchItem, V2RailConnectionGroup } from './sidebarV2Utils';

// 懒加载节点的 key 映射与加载态判定统一放在 ./sidebar/sidebarSwitcherState，
// 这里只保留转出以维持既有引用（含 Sidebar.locate-toolbar.test.tsx）。
export {
  resolveSidebarSwitcherLoadKey,
  shouldKeepSidebarSwitcherCollapsedWhileLoading,
  type SidebarTreeSwitcherNodeLike,
} from './sidebar/sidebarSwitcherState';
import {
  isSidebarSwitcherLoading,
  type SidebarTreeSwitcherNodeLike,
} from './sidebar/sidebarSwitcherState';

const { Search } = Input;
const SIDEBAR_CACHED_DATABASE_TREE_LIMIT = 12;
const NACOS_SERVICES_CHANGED_EVENT = 'gonavi:nacos-services-changed';
const SIDEBAR_GROUP_HOVER_EXPAND_DELAY_MS = 500;
const SIDEBAR_TREE_SCROLL_IDLE_DELAY_MS = 2000;

const buildOptionalSchemaContext = (value: unknown): { schemaName?: string } => {
  const schemaName = String(value ?? '').trim();
  return schemaName ? { schemaName } : {};
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
      icon: <GnSqlDocIcon />,
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
          icon: <GnDatabaseIcon />,
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
              icon: getDbIcon(iconType, iconColor, 20),
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
                  icon: <GnFolderOpenIcon />,
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
          icon: <GnFolderIcon />,
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
          icon: <GnFolderOpenIcon />,
          type: 'saved-query-group',
          selectable: false,
          isLeaf: false,
          children: automaticChildren,
      });
  }

  return {
      title: t('sidebar.tree.all_saved_queries'),
      key: 'all-saved-queries',
      icon: (
        <span className="gn-v2-tree-folder-icon" data-sidebar-tree-folder-icon="true">
          <GnFolderOpenIcon />
        </span>
      ),
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

export { V2ExplorerToolbarActions } from './sidebar/SidebarExplorerToolbar';
export type {
  V2ExplorerToolbarActionLabels,
  V2ExplorerToolbarToggleAction,
} from './sidebar/SidebarExplorerToolbar';

const Sidebar: React.FC<{
  onCreateConnection?: () => void;
  onCreateConnectionInGroup?: (targetTagId: string) => void;
  onEditConnection?: (conn: SavedConnection) => void;
  onOpenSettings?: () => void;
  /**
   * Open a settings-center group/pane, tool-center entry, or run a settings action
   * (import/export connections, data-sync, driver manager, sql audit). Mirrors 设置 left-nav groups.
   */
  onOpenSettingsNavigation?: (spec: SettingsCenterNavigationTarget) => void;
  onCheckUpdate?: () => void; // 标题栏「关于 → 检查更新」，与 macOS 菜单栏一致
  activeSettingsCenterPaneKey?: string | null; // 设置中心当前面板 key，用于点亮工具条入口
  hideTitlebarAboutAction?: boolean; // macOS 的「关于」走原生菜单栏，不再渲染到工具条
  hideTitlebarDriverAction?: boolean; // macOS 的「驱动管理」走原生菜单栏，不再渲染到工具条
  /** Whether web-only settings entries (e.g. browser auth) should appear. */
  isWebRuntime?: boolean;
  onOpenDataSyncWorkbench?: (entryMode: DataSyncEntryModeAlias) => void;
  onToggleAI?: () => void;
  onToggleLogPanel?: () => void;
  v2ExplorerContext?: V2ExplorerContext;
  /** 标题栏第二行的工具条宿主；存在时搜索/定位/回顶/更多按钮常驻此处，explorer 头部不再渲染（折叠按钮由 App 持有）。 */
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
  activeSettingsCenterPaneKey,
  onCheckUpdate,
  hideTitlebarAboutAction = false,
  hideTitlebarDriverAction = false,
  isWebRuntime = false,
  onToggleAI,
  onToggleLogPanel,
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
  const sidebarTreeOrders = useStore(state => state.sidebarTreeOrders);
  const updateSidebarTreeOrders = useStore(state => state.updateSidebarTreeOrders);
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

  const [treeData, setTreeData] = useState<TreeNode[]>([]);
  const sidebarTreeOrdersRef = useRef(sidebarTreeOrders);
  const tableSortPreferenceRef = useRef(tableSortPreference);
  sidebarTreeOrdersRef.current = sidebarTreeOrders;
  tableSortPreferenceRef.current = tableSortPreference;
  const activeTab = useMemo(() => tabs.find(tab => tab.id === activeTabId) || null, [tabs, activeTabId]);
  const activeTabHasConnection = useMemo(
    () => Boolean(
      activeTab?.connectionId
      && connections.some((connection) => connection.id === activeTab.connectionId),
    ),
    [activeTab?.connectionId, connections],
  );
  const activeTabLocateAction = useMemo(() => resolveSidebarActiveTabLocateAction({
    tab: activeTab,
    hasConnection: activeTabHasConnection,
  }), [activeTab, activeTabHasConnection]);
  const canLocateActiveTab = canLocateSidebarActiveTab(activeTabLocateAction);

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
      }),
      [darkMode, disableLocalBackdropFilter],
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
  const usePersistentSidebarFilter = v2SidebarSearchMode === 'filter';
  const v2PersistedSidebarFilter = appearance.v2SidebarPersistedFilter ?? '';
  const tableDoubleClickAction = appearance.tableDoubleClickAction === 'open-design' ? 'open-design' : 'open-data';
  const sidebarSingleDatabaseExpansion = appearance.sidebarSingleDatabaseExpansion === true;
  const [searchValue, setSearchValue] = useState(
      usePersistentSidebarFilter ? v2PersistedSidebarFilter : '',
  );
  const deferredSearchValue = useDeferredValue(searchValue);
  const [searchScopes, setSearchScopes] = useState<SearchScope[]>(['smart']);
  const [v2ExplorerFilter, setV2ExplorerFilter] = useState<V2ExplorerFilter>('all');
  const [isSearchScopePopoverOpen, setIsSearchScopePopoverOpen] = useState(false);
  const searchInputRef = useRef<any>(null);
  const commandSearchInputRef = useRef<any>(null);
  const [isV2CommandSearchOpen, setIsV2CommandSearchOpen] = useState(false);
  const commandSearchSqlLogs = useStore(
      state => selectSidebarCommandSearchSqlLogs(state, isV2CommandSearchOpen),
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
      return sidebarTreeDrag.applySidebarTreeOrdersToNode(
          buildAllSavedQueriesTreeNode(savedQueries, connections, savedQueryGroups),
          sidebarTreeOrders,
          tableSortPreference,
      );
  }, [connections, savedQueries, savedQueryGroups, sidebarTreeOrders, tableSortPreference]);
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
      setSearchValue(usePersistentSidebarFilter ? v2PersistedSidebarFilter : '');
  }, [usePersistentSidebarFilter, v2PersistedSidebarFilter]);

  const persistV2SidebarFilter = useCallback((nextFilter: string) => {
      setAppearance({ v2SidebarPersistedFilter: nextFilter });
  }, [setAppearance]);

  useSidebarFilterPersistence({
      enabled: usePersistentSidebarFilter,
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
  const treeContainerRef = useRef<HTMLDivElement>(null);
  const treeScrollIdleTimerRef = useRef<number | null>(null);
  const treeRef = useRef<any>(null);
  const sidebarTreeScrollRequestIdRef = useRef(0);
  const [sidebarTreeScrollRequest, setSidebarTreeScrollRequest] = useState<SidebarTreeScrollRequest | null>(null);
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
          setTreeHeight((current) => (Math.abs(current - rect.height) < 1 ? current : rect.height));
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
      treeContainerRef.current?.classList.add('is-vertical-scrolling');
      if (treeScrollIdleTimerRef.current !== null) {
          window.clearTimeout(treeScrollIdleTimerRef.current);
      }
      treeScrollIdleTimerRef.current = window.setTimeout(() => {
          treeScrollIdleTimerRef.current = null;
          treeContainerRef.current?.classList.remove('is-vertical-scrolling');
      }, SIDEBAR_TREE_SCROLL_IDLE_DELAY_MS);
  }, []);

  useEffect(() => () => {
      if (treeScrollIdleTimerRef.current !== null) {
          window.clearTimeout(treeScrollIdleTimerRef.current);
      }
      treeContainerRef.current?.classList.remove('is-vertical-scrolling');
  }, []);

  useEffect(() => {
      const handleFocusSidebarSearch = () => {
          if (!usePersistentSidebarFilter) {
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
  }, [openV2CommandSearch, usePersistentSidebarFilter]);

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
      openBatchConnectionWorkbench,
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
          icon: getDbIcon(iconType, iconColor, 20),
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
              <GnFolderIcon />
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
      const orderedChildren = children
          ? sidebarTreeDrag.applySidebarTreeOrders(
              String(key),
              children,
              sidebarTreeOrdersRef.current,
              tableSortPreferenceRef.current,
          )
          : undefined;
      const nextTreeData = replaceSidebarTreeNodeChildren(treeDataRef.current, key, orderedChildren, dataRef);
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
          return (
            <span className="gn-v2-tree-folder-icon" data-sidebar-tree-folder-icon="true">
              <GnFolderOpenIcon />
            </span>
          );
        case 'external-sql-directory':
          return node.dataRef.directoryStatus === 'missing' ? <WarningOutlined /> : <HddOutlined />;
        case 'external-sql-folder':
          return <GnFolderIcon />;
        default:
          return <GnSqlDocIcon />;
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

  const waitForSidebarLoadKey = async (loadKey: string): Promise<boolean> => (
      waitForSidebarLocateLoadKey(loadKey, (key) => loadingNodesRef.current.has(key))
  );

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

      setSearchValue('');
      setV2ExplorerFilter('all');
      const outcome = await runSidebarLocateDatabaseObject({
          request,
          target,
          objectLabel,
          getTree: () => treeDataRef.current as SidebarLocateTreeNodeLike[],
          findNode: (key) => findTreeNodeByKey(treeDataRef.current, key),
          mergeExpandedTreeKeys,
          revealNode: (key, node, stage) => {
              setSidebarSelectedKeys([key]);
              selectedNodesRef.current = node ? [node] : [];
              if (stage === 'connection') {
                  clearStaleHostStateOnSelection(node);
              }
              setActiveContext({
                  connectionId: request.connectionId,
                  dbName: request.dbName,
                  ...(stage === 'object'
                      ? {
                          tableName: resolveSidebarTitlebarObjectName(node) || request.tableName,
                          ...buildOptionalSchemaContext(node?.dataRef?.schemaName || request.schemaName),
                      }
                      : {}),
              });
              publishTitlebarSelection(
                  resolveSidebarSelectionContext(node)
                  || {
                      connectionId: request.connectionId,
                      dbName: request.dbName,
                      ...(stage === 'object' ? { tableName: request.tableName } : {}),
                      sidebarStateKey: request.connectionId,
                  },
                  key,
              );
              scrollSidebarTreeToKey(key, stage === 'object' ? 'center' : 'nearest');
          },
          loadDatabases,
          loadTables,
          isLoadPending: (loadKey) => loadingNodesRef.current.has(loadKey),
      });
      if (outcome.status === 'failed') {
          const notify = outcome.message.level === 'info' ? message.info : message.warning;
          notify(t(outcome.message.key, outcome.message.params));
      }
  };

  const handleLocateActiveTabInSidebar = () => {
      if (activeTabLocateAction.kind === 'object') {
          void locateObjectInSidebar(activeTabLocateAction.request).catch((error: unknown) => {
              console.error('GoNavi sidebar locate failed', error);
              message.error(t('sidebar.message.locate_failed', { detail: describeSidebarLocateFailure(error) }));
          });
          return;
      }
      if (activeTabLocateAction.kind === 'query-line-table') {
          dispatchSidebarActiveQueryTableLocate(activeTabLocateAction);
          return;
      }
      message.warning(t('sidebar.message.locate_current_table_unavailable'));
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
                icon: <GnFieldsIcon />,
                type: 'folder-columns',
                isLeaf: true,
                dataRef: conn
            },
            {
                title: t('sidebar.table_folder.indexes'),
                key: `${key}-indexes`,
                icon: <GnIndexIcon />,
                type: 'folder-indexes',
                isLeaf: true,
                dataRef: conn
            },
            {
                title: t('sidebar.table_folder.foreign_keys'),
                key: `${key}-fks`,
                icon: <GnLinkIcon />,
                type: 'folder-fks',
                isLeaf: true,
                dataRef: conn
            },
            {
                title: t('sidebar.table_folder.triggers'),
                key: `${key}-triggers`,
                icon: renderSidebarObjectIcon('trigger'),
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

  const openSidebarObjectNode = (node: any): boolean => tryOpenSidebarObjectNode(node, {
      addTab,
      openEventDefinition,
      openSequenceDefinition,
      openPackageDefinition,
      t,
      buildOptionalSchemaContext,
  });

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
      if (info?.node?.type === 'v2-table-section' || info?.node?.type === 'v2-database-section') {
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
      } else if (isV2SidebarObjectNode(info.node)) {
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
        isTreeDragging
        && sidebarTreeDrag.isSidebarHostTreeNode(sidebarTreeDragNodeRef.current)
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
      // 双击时取消单击延迟动作（如表概览打开）。连接节点只展开不折叠，其它目录仍切换展开。
      if (clickTimerRef.current) {
          clearTimeout(clickTimerRef.current);
          clickTimerRef.current = null;
      }
      const { type, dataRef, key: nodeKey } = node;
      if (type === 'v2-table-section' || type === 'v2-database-section') {
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
      } else if (isV2SidebarObjectNode(node)) {
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
          && ['mqtt', 'kafka', 'rocketmq', 'rabbitmq', 'pulsar'].includes(
              resolveDataSourceType(node.dataRef?.config),
          );
      if (isMessageQueueConnection || node.type === 'message-namespace') {
          openMessageQueueWorkbench(node, 'open');
          return;
      }
      if (openMessageObjectNode(node)) {
          return;
      } else if (openSidebarObjectNode(node)) {
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
      const { expandedKeys: nextExpandedKeys, didExpand } = resolveSidebarDoubleClickExpandedKeys({
          nodeType: type,
          nodeKey: key,
          expandedKeys,
      });
      setExpandedKeys(nextExpandedKeys);
      // 连接节点双击只展开：工作台定位已经展开后，再双击同一 Host 保持库树打开。
      // 若已展开但子节点尚未加载，继续走懒加载，而不是把树收起来。
      if (didExpand || (type === 'connection' && shouldLoadSidebarNodeOnExpand(node))) {
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
      // 懒加载期间给出转圈反馈；Nacos 命名空间下双击「配置管理」「服务管理」
      // 走手动 onLoadData，rc-tree 的 node.loading 不会置位，只能靠 loadingNodesRef。
      if (isSidebarSwitcherLoading(node, loadingNodesRef.current)) {
          return <LoadingOutlined className="gn-v2-tree-switcher-loading" spin />;
      }
      return <CaretDownFilled />;
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
      openBatchConnectionWorkbench,
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
      flattenConnectionNodes,
      activeConnection,
      v2VisibleTreeData,
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
      treeData: visibleSidebarTreeData,
      treeHeight,
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
  const { destinationSections: commandSearchDestinations, flatItems: commandSearchFlatItems } = useCommandSearchDestinations({
      isOpen: isV2CommandSearchOpen,
      searchValue: deferredV2CommandSearchValue,
      isWebRuntime,
      onOpenSettingsNavigation,
      aiItems: commandSearchAiItem,
      treeItems: filteredCommandSearchTreeItems,
      actionItems: filteredCommandSearchActionItems,
      recentItems: filteredCommandSearchRecentItems,
  });
  // The tree never scrolls horizontally: long labels ellipsize and the user
  // widens the sidebar to read them. Wheel input only drives vertical scroll.
  const handleTreeWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
          markTreeScrollActivity();
      }
  }, [markTreeScrollActivity]);

  useSidebarLayoutEffect(() => {
      if (!sidebarTreeScrollRequest) return;

      const renderedTreeData = v2VisibleTreeData;
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
      const findExactTreeRow = (): HTMLElement | null => {
          const nodeTitles = treeContainerRef.current
              ?.querySelectorAll<HTMLElement>('[data-sidebar-node-key]');
          const targetTitle = Array.from(nodeTitles || [])
              .find((element) => element.dataset.sidebarNodeKey === String(request.key));
          return (targetTitle?.closest('.ant-tree-treenode') as HTMLElement | null) ?? null;
      };
      return runSidebarTreeScrollRequest({
          request,
          isCurrent: () => sidebarTreeScrollRequestIdRef.current === request.id,
          scrollTreeToKey: (key, align) => treeRef.current?.scrollTo?.({ key, align }),
          findRow: findExactTreeRow,
          onSettled: (outcome) => {
              if (outcome === 'cancelled') return;
              setSidebarTreeScrollRequest((current) => current?.id === request.id ? null : current);
          },
      });
  }, [displayTreeData, expandedKeys, true, sidebarTreeScrollRequest, v2VisibleTreeData]);

  const hasRelationalObjectKindFilterConnection = connections.some(
      (connection) => getDataSourceCapabilities(connection.config).supportsRelationalObjectKindFilter,
  );
  // Drops a filter belonging to another workbench family, so a stale one cannot
  // empty the tree. The slot derives the same family from the same connection, so
  // the two cannot disagree. See the hook for the reasoning.
  useV2ExplorerFilterReset(activeConnection, v2ExplorerFilter, setV2ExplorerFilter);


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

  const renderV2TreeTitle = useCallback((node: any, hoverTitle: string, connectionStatus: SidebarTreeConnectionStatus) => renderSidebarV2TreeTitle({
      node,
      hoverTitle,
      connectionStatus,
      getV2TreeMetaText: getV2TreeMetaTextRef.current,
      sidebarTableMetadataFields,
      sidebarDropPlacement: sidebarTreeDropPreview?.nodeKey === String(node.key || '')
          ? sidebarTreeDropPreview.placement
          : null,
  }), [
      sidebarTreeDropPreview,
      sidebarTableMetadataFields,
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
      setV2ExplorerFilter('all');
      mergeExpandedTreeKeys(collectSidebarLocateExpandKeys(
          treeDataRef.current as SidebarLocateTreeNodeLike[],
          connection.id,
      ));
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
  }, [
      connections,
      findTreeNodeByKeyRef,
      mergeExpandedTreeKeys,
      onEnsureSidebarExpanded,
      publishTitlebarSelectionForNode,
      scrollSidebarTreeToKey,
      selectConnectionFromRail,
      selectedNodesRef,
      setActiveContext,
      setSearchValue,
      setSidebarSelectedKeys,
      setV2ExplorerFilter,
      treeDataRef,
  ]);

  useEffect(() => {
      const handleLocateSidebarConnection = (event: Event) => {
          void locateConnectionInSidebar((event as CustomEvent).detail);
      };
      window.addEventListener(SIDEBAR_LOCATE_CONNECTION_EVENT, handleLocateSidebarConnection as EventListener);
      return () => {
          window.removeEventListener(SIDEBAR_LOCATE_CONNECTION_EVENT, handleLocateSidebarConnection as EventListener);
      };
  }, [locateConnectionInSidebar]);

  const getNodeMenuItems = (node: any): MenuProps['items'] => buildSidebarNodeMenuItems(node, {
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
    openBatchConnectionWorkbench,
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
      renderV2TreeTitle,
      handleAddExternalSQLDirectory,
  });
  const v2RailConnectionGroups = useMemo(
      () => buildV2RailConnectionGroups(connections, connectionTags, sidebarRootOrder, rootSortMode, rootConnectionSortMode),
      [connections, connectionTags, sidebarRootOrder, rootSortMode, rootConnectionSortMode],
  );
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

      const resolved = sidebarTreeDrag.resolveSidebarHostTreeDropAtEvent(
          treeDataRef.current,
          sidebarTreeDragNodeRef.current,
          event,
      );
      if (!resolved) return null;
      return sidebarTreeDrag.resolveSidebarHostTreeMove({
          ...resolved,
          connectionTags,
      }) ? resolved : null;
  };

  const applySidebarHostTreeDrop = (
      dragNode: TreeNode,
      dropNode: TreeNode,
      placement: SidebarTreeDropPlacement,
  ): boolean => {
      if (
          placement !== 'inside'
          && sidebarTreeDrag.isSidebarTreeGapNoOp(treeDataRef.current, dragNode, dropNode, placement)
      ) return false;
      const move = sidebarTreeDrag.resolveSidebarHostTreeMove({
          dragNode,
          dropNode,
          placement,
          connectionTags,
      });
      if (!move) return false;
      if (move.type === 'tag') {
          moveConnectionTag(move.id, move.targetParentTagId, move.targetToken, move.insertBefore);
      } else {
          moveConnectionToTag(move.id, move.targetParentTagId, move.targetToken, move.insertBefore);
      }
      return true;
  };

  const applySidebarTreeOrderDrop = (
      dragNode: TreeNode,
      dropNode: TreeNode,
      insertBefore: boolean,
  ): boolean => sidebarTreeDrag.commitSidebarTreeOrderDrop({
      treeData: treeDataRef.current, dragNode, dropNode, insertBefore,
      treeOrders: sidebarTreeOrdersRef.current,
      tableSortPreference: tableSortPreferenceRef.current,
      callbacks: {
          onTreeData: (next) => { treeDataRef.current = next; setTreeData(next); },
          onTreeOrders: (parentKey, orderedKeys, next) => {
              sidebarTreeOrdersRef.current = next;
              updateSidebarTreeOrders({ [parentKey]: orderedKeys });
          },
          onTableSort: (connectionId, dbName, next) => {
              tableSortPreferenceRef.current = next;
              setTableSortPreference(connectionId, dbName, 'manual');
          },
      },
  });

  const handleSidebarTreeDragOverCapture = (event: React.DragEvent<HTMLDivElement>) => {
      const objectDrop = sidebarTreeDrag.resolveSidebarTreeOrderDropAtEvent(
          treeDataRef.current,
          sidebarTreeDragNodeRef.current,
          event,
      );
      const resolvedDrop = objectDrop || resolveSidebarHostGroupDropAtEvent(event);
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
      const objectDrop = sidebarTreeDrag.resolveSidebarTreeOrderDropAtEvent(
          treeDataRef.current,
          sidebarTreeDragNodeRef.current,
          event,
      );
      if (objectDrop) {
          event.preventDefault();
          event.stopPropagation();
          applySidebarTreeOrderDrop(
              objectDrop.dragNode,
              objectDrop.dropNode,
              objectDrop.placement === 'before',
          );
          restoreTreeSelectionAfterDrag();
          clearSidebarTreeDragVisuals();
          return;
      }
      const hostDrop = resolveSidebarHostGroupDropAtEvent(event);
      if (!hostDrop) return;

      event.preventDefault();
      event.stopPropagation();
      applySidebarHostTreeDrop(hostDrop.dragNode, hostDrop.dropNode, hostDrop.placement);
      restoreTreeSelectionAfterDrag();
      clearSidebarTreeDragVisuals();
  };

  const allowSidebarTreeDrop = ({ dragNode, dropNode, dropPosition }: any): boolean => {
      if (!dragNode || !dropNode) return false;
      if (sidebarTreeDrag.isSidebarTreeOrderNode(dragNode) || sidebarTreeDrag.isSidebarTreeOrderNode(dropNode)) {
          return sidebarTreeDrag.canDropSidebarTreeOrderNode(
              treeDataRef.current,
              dragNode,
              dropNode,
              Number(dropPosition),
          );
      }
      if ((dragNode.type !== 'tag' && dragNode.type !== 'connection') || (dropNode.type !== 'tag' && dropNode.type !== 'connection')) {
          return false;
      }
      const dropPlacement = Number(dropPosition) < 0
          ? 'before'
          : Number(dropPosition) > 0
              ? 'after'
              : 'inside';
      if (
          dropPlacement !== 'inside'
          && sidebarTreeDrag.isSidebarTreeGapNoOp(treeDataRef.current, dragNode, dropNode, dropPlacement)
      ) return false;
      // Connections cannot contain tree items. A group can contain a group only
      // when the pointer lands on its content, not on its before/after gap.
      const droppingIntoTag = dropNode.type === 'tag' && Number(dropPosition) === 0;
      if (dropNode.type === 'connection' && Number(dropPosition) === 0) return false;
      if (dragNode.type !== 'tag') return String(dragNode.key) !== String(dropNode.key);

      const dragTagId = String(dragNode?.dataRef?.id || '').trim();
      const targetParentTagId = droppingIntoTag
          ? String(dropNode?.dataRef?.id || '').trim() || null
          : sidebarTreeDrag.getSidebarTreeNodeParentTagId(dropNode, connectionTags);
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

      const placement: SidebarTreeDropPlacement = resolveSidebarTreeDropPlacement({
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
          });
      if (sidebarTreeDrag.isSidebarTreeOrderNode(dragNode) || sidebarTreeDrag.isSidebarTreeOrderNode(dropNode)) {
          applySidebarTreeOrderDrop(dragNode, dropNode, placement === 'before');
          return;
      }
      applySidebarHostTreeDrop(dragNode, dropNode, placement);
  };

  const onRightClick = ({ event, node }: any) => {
      if (node?.type === 'v2-table-section' || node?.type === 'v2-database-section') {
          event.preventDefault();
          event.stopPropagation();
          return;
      }
      if (node?.type === 'tag') {
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
      if (node?.type === 'connection') {
          openV2ConnectionContextMenu(event, node);
          return;
      }
      if (node?.type === 'database') {
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
          node?.type === 'object-group'
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
      if (node?.type === 'object-group' && node?.dataRef?.groupKey === 'tables') {
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
      if (node?.type === 'table') {
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
          const position = resolveSidebarContextMenuPosition(event.clientX, event.clientY);
          setContextMenu({
              x: position.x,
              y: position.y,
              sourceX: event.clientX,
              sourceY: event.clientY,
              items,
              kind: 'v2-node',
              node,
              rootClassName: 'gn-v2-table-context-menu-popup',
              overlayStyle: { width: 264, maxWidth: 'calc(100vw - 24px)' },
              maxHeight: position.maxHeight,
          });
      }
  };

  const handleV2TreeContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) return;
      const nodeKey = resolveSidebarTreeRowKey(event.target);
      if (!nodeKey) return;
      const node = findTreeNodeByKeyRef.current(treeDataRef.current, nodeKey);
      if (!node) return;
      event.preventDefault();
      onRightClick({ event, node });
  };

  const v2RailObjectActionsLabel = t('sidebar.rail.object_actions');
  const v2RailSystemActionsLabel = t('sidebar.rail.system_actions');
  const v2NewGroupLabel = t('sidebar.action.new_group');
  const v2DataWorkflowLabel = t('app.tools.group.workflow.title');
  const v2BatchTablesLabel = t('sidebar.action.batch_tables');
  const v2BatchDatabasesLabel = t('sidebar.action.batch_databases');
  const v2BatchConnectionsLabel = t('sidebar.action.batch_connections');
  const v2DataImportLabel = t('sidebar.action.data_import');
  const v2SqlToolsLabel = t('sidebar.action.sql_tools');
  const v2SlowQueryLabel = t('sql_analysis.slow_query.rail.aria_label');
  const v2SqlAuditLabel = t('sql_audit.rail.aria_label');
  const v2OpenExternalSqlFileLabel = t('sidebar.sql_file_exec.title');
  const v2LocateCurrentTableLabel = t('sidebar.action.locate_current_table');
  const v2LocateCurrentTableUnavailableLabel = t('sidebar.message.locate_current_table_unavailable');
  const v2ConnectionActionsLabel = t('sidebar.active_connection.actions');
  const v2ScrollToTopLabel = t('sidebar.action.scroll_to_top');
  const v2CommandSearchLabel = t('sidebar.command_search.label');
  const v2CommandSearchPlaceholder = t('sidebar.command_search.placeholder');

  const scrollV2ExplorerToTop = () => {
    treeRef.current?.scrollTo?.({ index: 0, align: 'top' });
  };
  // Docked / rail actions stay reachable while the explorer is collapsed, so reveal it before scrolling.
  const scrollV2ExplorerToTopExpanded = () => {
    onEnsureSidebarExpanded?.();
    scrollV2ExplorerToTop();
  };
  const sidebarActionsInRail = appearance.sidebarActionsPlacement === 'rail';

  const v2ExplorerToolbarActionProps = {
    labels: {
      objectActions: v2RailObjectActionsLabel,
      locateCurrentTable: v2LocateCurrentTableLabel,
      locateCurrentTableUnavailable: v2LocateCurrentTableUnavailableLabel,
      scrollToTop: v2ScrollToTopLabel,
      connectionActions: v2ConnectionActionsLabel,
    },
    canLocateActiveTab,
    hasActiveConnection: Boolean(activeConnection),
    onLocateCurrentTable: handleLocateActiveTabInSidebar,
    onScrollToTop: scrollV2ExplorerToTop,
    onOpenConnectionActions: (event: React.MouseEvent<HTMLElement>) => {
      if (activeConnection) {
        openV2ConnectionContextMenu(event, activeConnection);
      }
    },
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

  const {
    openSlowQueryWorkbench,
    openSqlAuditWorkbench,
    openDMLSnapshotWorkbench,
    sessionWorkbenchAction,
    userManagementAction,
  } = useSidebarWorkbenchLaunchers({
    activeTab, activeTabHasConnection, activeConnection, addTab,
  });

  const v2TitlebarQuickActions: TitleBarQuickAction[] = [
    {
      key: 'data-workflow',
      label: v2DataWorkflowLabel,
      icon: <TitlebarGraphIcon size="100%" />,
      menu: [
        {
          key: 'batch-connections',
          label: v2BatchConnectionsLabel,
          icon: <CloudOutlined aria-hidden="true" />,
          onClick: openBatchConnectionWorkbench,
        },
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
        {
          key: 'sync',
          label: t('app.tools.entry.sync.title'),
          icon: <UploadOutlined rotate={90} aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'workflow', action: 'sync' }),
        },
        {
          key: 'compare',
          label: t('app.tools.entry.compare.title'),
          icon: <SwitcherOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'workflow', action: 'compare' }),
        },
      ],
    },
    {
      key: 'sql-tools',
      label: v2SqlToolsLabel,
      dividerBefore: true, // 「数据工作流」与「SQL 工具」之间的分组竖线
      icon: <TitlebarSqlToolIcon size="100%" />,
      menu: [
        {
          key: 'slow-query',
          label: v2SlowQueryLabel,
          icon: <HistoryOutlined aria-hidden="true" />,
          onClick: openSlowQueryWorkbench,
          disabled: !activeTabHasConnection,
        },
        {
          key: 'sql-audit',
          label: v2SqlAuditLabel,
          icon: <AuditOutlined aria-hidden="true" />,
          onClick: openSqlAuditWorkbench,
        },
        {
          key: 'dml-snapshot',
          label: t('dml_snapshot.workbench.title'),
          icon: <SafetyCertificateOutlined aria-hidden="true" />,
          onClick: openDMLSnapshotWorkbench,
        },
      ],
    },
    sessionWorkbenchAction,
    userManagementAction,
  ];
  // 尾部操作：非 macOS 渲染到标题栏「设置 │ … │ 主题」胶囊中间，macOS 留在工具条 AI 之后。
  const v2TitlebarVisibleTrailingActions = buildTitlebarTrailingActions({
    t,
    activeSettingsCenterPaneKey,
    onOpenSettingsNavigation,
    onCheckUpdate,
    hideAbout: hideTitlebarAboutAction,
    hideDrivers: hideTitlebarDriverAction,
  });

  const { getCommandSearchCopyOptions, handleCopyCommandSearchItem } = useSidebarCommandSearchCopy({ connections, connectionIds });

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
      tabs: commandSearchDestinations.tabs,
      savedQueries: commandSearchDestinations.savedQueries,
      settings: commandSearchDestinations.settings,
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
      getCopyOptions: getCommandSearchCopyOptions,
      onCopyCommandSearchItem: handleCopyCommandSearchItem,
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
    },
    handlers: {
      openCreateTagModal: () => { setRenameViewTarget(null); createTagForm.resetFields(); setIsCreateTagModalOpen(true); },
      openBatchTableExport: openBatchTableWorkbench,
      openBatchDatabaseExport: openBatchDatabaseWorkbench,
      openDataImport: handleOpenDataImportWorkbench,
      openExternalSqlFile: handleOpenSQLFileFromToolbar,
      locateActiveTab: handleLocateActiveTabInSidebar,
    },
    canLocateActiveTab,
    showObjectActions: false,
    showLocateAction: false,
    // The session workbench is exposed as a titlebar action so it remains
    // reachable while the expanded explorer hides the fixed rail.
    showWorkbenchActions: false,
    sidebarExpandAction: !collapsedSidebarActionsTarget && !sidebarActionsInRail && onExpandSidebar && expandSidebarLabel ? {
      label: expandSidebarLabel,
      onClick: onExpandSidebar,
      buttonRef: expandSidebarButtonRef,
    } : undefined,
    explorerActions: sidebarActionsInRail ? (
      <V2RailExplorerActions
        label={v2RailSystemActionsLabel}
        searchAction={usePersistentSidebarFilter ? undefined : { label: v2CommandSearchLabel, onClick: () => openV2CommandSearch() }}
        toolbar={{ ...v2ExplorerToolbarActionProps, onScrollToTop: scrollV2ExplorerToTopExpanded }}
        collapseAction={onCollapseSidebar && collapseSidebarLabel
          ? { label: collapseSidebarLabel, onClick: onCollapseSidebar, buttonRef: collapseSidebarButtonRef }
          : undefined}
        expandAction={onExpandSidebar && expandSidebarLabel
          ? { label: expandSidebarLabel, onClick: onExpandSidebar, buttonRef: expandSidebarButtonRef }
          : undefined}
      />
    ) : undefined,
  };

  return (
    <div
        className="gn-v2-sidebar-redesign"
        data-sidebar-actions-rail={sidebarActionsInRail ? 'true' : undefined}
        style={{ display: 'flex', height: '100%', minHeight: 0 }}
    >
        {exportProgressModal}
        <SidebarConnectionRail {...v2ConnectionRailProps} />
        <div
            id="gonavi-sidebar-tree-panel"
            className="gn-v2-object-explorer"
            data-sidebar-tree-panel="true"
            style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, flex: 1 }}
        >
        <div
                className="gn-v2-explorer-actions"
                role="toolbar"
                aria-label={v2RailSystemActionsLabel}
                data-sidebar-explorer-actions="true"
            >
                {v2ExplorerContext && <V2ExplorerContextSummary context={v2ExplorerContext} />}
                {!collapsedSidebarActionsTarget && !sidebarActionsInRail && (
                    <>
                        {!usePersistentSidebarFilter && (
                            <V2ExplorerSearchAction
                                label={v2CommandSearchLabel}
                                onClick={() => {
                                    openV2CommandSearch();
                                    onFocusCommandSearch?.();
                                }}
                            />
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
                    </>
                )}
        </div>

        {usePersistentSidebarFilter && (
        <div className="gn-v2-explorer-search" style={{ padding: '8px 14px', borderBottom: `1px solid ${darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'}` }}>
            <div className="gn-v2-explorer-filter-row" data-v2-sidebar-search-mode="filter">
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
        </div>
        )}

        <SidebarFilterSlot
            activeConnection={activeConnection}
            treeData={displayTreeData}
            hasRelationalFilterConnection={hasRelationalObjectKindFilterConnection}
            activeFilter={v2ExplorerFilter}
            onFilterChange={setV2ExplorerFilter}
        />

        <div
            ref={treeContainerRef}
            className={`sidebar-tree-scroll-shell gn-v2-explorer-tree-shell${sidebarTreeDrag.isSidebarHostTreeNode({ type: sidebarTreeDragNodeType } as TreeNode) ? ' is-host-tree-dragging' : ''}${sidebarTreeDrag.isSidebarTreeOrderNode({ type: sidebarTreeDragNodeType } as TreeNode) ? ' is-object-tree-dragging' : ''}${sidebarTreeDropPreview ? ' has-host-group-drop-preview' : ''}`}
            onWheelCapture={handleTreeWheel}
            onTouchMoveCapture={markTreeScrollActivity}
            onMouseDownCapture={sidebarTreeDrag.markSidebarTreeMouseDownHandled}
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
                    key={`v2-tree-${v2ExplorerFilter}-${sidebarObjectVisibilitySignature}`}
                    ref={treeRef}
                    showIcon
                    draggable={{
                        icon: false,
                        nodeDraggable: (node: any) => node.type === 'connection'
                            || node.type === 'tag'
                            || sidebarTreeDrag.isSidebarTreeOrderNode(node)
                    }}
                    allowDrop={allowSidebarTreeDrop}
                    onDragStart={({ event, node }: any) => {
                        snapshotTreeSelectionBeforeDrag();
                        treeDragSelectSuppressUntilRef.current = Date.now() + 600;
                        sidebarTreeDragNodeRef.current = node;
                        setSidebarTreeDragNodeType(String(node?.type || '') || null);
                        updateSidebarTreeDropPreview(null);
                        sidebarTreeDragPreviewElementRef.current?.remove();
                        sidebarTreeDragPreviewElementRef.current = sidebarTreeDrag.createSidebarTreeDragPreview(event, node);
                        sidebarTreeDrag.setSidebarTreeSqlDragData(event, node);
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
                    treeData={v2VisibleTreeData}
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
                    // Expand/collapse animation re-renders the newly revealed rows on every
                    // frame (each with a Tooltip) and blocks scroll-to-key until it ends; on
                    // large databases that added ~0.7s to locating a table in WebKit.
                    motion={false}
                    height={effectiveTreeHeight}
                    itemHeight={30}
                    itemHeightResolver={resolveSidebarTreeRowHeight}
                    onContextMenu={handleV2TreeContextMenu}
                    onRightClick={onRightClick}
                />
            </div>
        </div>

        </div>
        <SidebarSearchPanel {...v2CommandSearchPanelProps} />

        {collapsedSidebarActionsTarget && createPortal(
          <>
            {!usePersistentSidebarFilter && (
              <V2ExplorerSearchAction label={v2CommandSearchLabel} onClick={() => openV2CommandSearch()} />
            )}
            <V2ExplorerToolbarActions
              {...v2ExplorerToolbarActionProps}
              onScrollToTop={scrollV2ExplorerToTopExpanded}
            />
          </>,
          collapsedSidebarActionsTarget,
        )}

        <TitleBarQuickActionsHost
          label={v2RailObjectActionsLabel}
          actions={v2TitlebarQuickActions}
          trailingActions={v2TitlebarVisibleTrailingActions}
        />

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
