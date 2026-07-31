import Modal from './common/ResizableDraggableModal';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Dropdown, message, Tabs, Tooltip } from 'antd';
import { CloseOutlined, ConsoleSqlOutlined, DatabaseOutlined, FileTextOutlined, FolderOpenOutlined, HistoryOutlined, PlusOutlined, PushpinOutlined, RightOutlined, RobotOutlined, SearchOutlined, SettingOutlined } from '@ant-design/icons';
import type { MenuProps, TabsProps } from 'antd';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, DragMoveEvent, DragStartEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStore, type RecentConnectionTarget, type RecentSQLFile } from '../store';
import type { ExternalSQLDirectory, SavedConnection, SavedQuery, TabData } from '../types';
import { t } from '../i18n';
import {
  buildTabDisplayModel,
  resolveConnectionHostSummary,
  type TabDisplayPart,
  type TabDisplayModel,
} from '../utils/tabDisplay';
import { ReadSQLFile, WriteSQLFile } from '../../wailsjs/go/app/App';
import {
  getSQLFileTabPath,
  hasSQLFileTabUnsavedChanges,
  isSQLFileMissingErrorMessage,
  isSQLFileMissingReadResult,
  isSQLFileQueryTab,
  normalizeSQLFileReadContent,
} from '../utils/sqlFileTabDirty';
import { clearSQLFileTabDraft, getSQLFileTabDraft } from '../utils/sqlFileTabDrafts';
import { buildExternalSQLTabId } from '../utils/externalSqlTree';
import { buildSQLFileExecutionWorkbenchTab } from '../utils/sqlFileExecutionTab';
import { getDataSourceCapabilities } from '../utils/dataSourceCapabilities';
import { CLOSE_ACTIVE_WORKSPACE_TAB_EVENT, resolveDockedActiveTabId } from '../utils/closeTabShortcut';
import WorkbenchTabContent from './WorkbenchTabContent';
import DetachDragPreview, {
  buildDetachDragPreviewState,
  type DetachDragPreviewState,
} from './DetachDragPreview';
import {
  type NativeDetachTerminalPointer,
  resolveNativeDetachDragRelease,
  resolveNativeDetachPreferredBounds,
  shouldDetachAfterNativePointerCancel,
  shouldDetachAtScreenPoint,
  shouldDetachTabByDrag,
} from '../utils/detachedWindow';
import { openNativeWorkbenchTabWindow } from '../utils/nativeDetachedWindowHost';
import { useWorkbenchTabs } from '../hooks/useWorkbenchTabs';
import { resolveConnectionEnvironmentPresentation } from '../utils/connectionEnvironment';

const getTabKindLabel = (tab: TabData): string => {
  if (tab.type === 'query') return t('tab_manager.kind_badge.query');
  if (tab.type === 'table') return t('tab_manager.kind_badge.table');
  if (tab.type === 'design') return t('tab_manager.kind_badge.design');
  if (tab.type === 'table-overview') return t('tab_manager.kind_badge.table_overview');
  if (tab.type === 'table-export') return t('tab_manager.kind_badge.table_export');
  if (tab.type === 'data-import') return t('tab_manager.kind_badge.data_import');
  if (tab.type === 'data-sync') return t('app.tools.entry.sync.title');
  if (tab.type === 'sql-file-execution') return t('sidebar.sql_file_exec.title');
  if (tab.type === 'sql-analysis') return t('tab_manager.kind_badge.sql_analysis');
  if (tab.type === 'sql-audit') return t('tab_manager.kind_badge.sql_audit');
  if (tab.type.startsWith('redis')) return t('tab_manager.kind_badge.redis');
  if (tab.type.startsWith('jvm')) return t('tab_manager.kind_badge.jvm');
  if (tab.type === 'trigger') return t('tab_manager.kind_badge.trigger');
  if (tab.type === 'view-def') {
    return tab.viewKind === 'materialized'
      ? t('tab_manager.kind_badge.materialized_view')
      : t('tab_manager.kind_badge.view');
  }
  if (tab.type === 'event-def') return t('tab_manager.kind_badge.event');
  if (tab.type === 'routine-def') return t('tab_manager.kind_badge.routine');
  if (tab.type === 'sequence-def') return t('tab_manager.kind_badge.sequence');
  if (tab.type === 'package-def') return t('tab_manager.kind_badge.package');
  return t('tab_manager.kind_badge.fallback');
};

export const isBackgroundTaskWorkbenchTab = (tab: Pick<TabData, 'type'>): boolean => (
  tab.type === 'table-export' || tab.type === 'data-import' || tab.type === 'data-sync'
);

export const isRunningDataImportWorkbenchTab = (
  tab: Pick<TabData, 'type' | 'dataImportRunning'>,
): boolean => tab.type === 'data-import' && tab.dataImportRunning === true;

export const TAB_WORKBENCH_CLASS_NAME = 'tab-workbench';

export const V2_WORKBENCH_TAB_MIN_WIDTH = 112;
export const V2_WORKBENCH_TAB_MAX_WIDTH = 260;
const V2_WORKBENCH_TAB_WIDTH_GUARD = 1;

export const resolveV2WorkbenchTabWidth = (availableWidth: number, tabCount: number): number => {
  const normalizedTabCount = Number.isFinite(tabCount) ? Math.floor(tabCount) : 0;
  if (!Number.isFinite(availableWidth) || availableWidth <= 0 || normalizedTabCount <= 0) {
    return V2_WORKBENCH_TAB_MAX_WIDTH;
  }

  const equalShare = Math.floor(
    (availableWidth - V2_WORKBENCH_TAB_WIDTH_GUARD) / normalizedTabCount,
  );
  return Math.min(
    V2_WORKBENCH_TAB_MAX_WIDTH,
    Math.max(V2_WORKBENCH_TAB_MIN_WIDTH, equalShare),
  );
};

type RecentConnectionShortcut = {
  connection: SavedConnection;
  dbName?: string;
};

export type PinnedTableShortcut = {
  connection: SavedConnection;
  dbName: string;
  schemaName?: string;
  tableName: string;
};

type LinkedExternalSQLDirectoryShortcut = {
  connection: SavedConnection;
  dbName?: string;
  directory: ExternalSQLDirectory;
};

const RECENT_WORKBENCH_ITEM_LIMIT = 6;

export const buildRecentConnectionShortcuts = (
  connections: SavedConnection[],
  recentTargets: RecentConnectionTarget[],
): RecentConnectionShortcut[] => {
  const queryCapableConnections = connections.filter((connection) =>
    getDataSourceCapabilities(connection.config).supportsQueryEditor,
  );
  const connectionById = new Map(queryCapableConnections.map((connection) => [connection.id, connection]));
  const seen = new Set<string>();
  const seenConnectionIds = new Set<string>();
  const result: RecentConnectionShortcut[] = [];

  const append = (connection: SavedConnection, preferredDbName?: string) => {
    const dbName = String(preferredDbName || connection.config.database || '').trim() || undefined;
    const key = `${connection.id}::${dbName || ''}`;
    if (seen.has(key) || result.length >= RECENT_WORKBENCH_ITEM_LIMIT) return;
    seen.add(key);
    seenConnectionIds.add(connection.id);
    result.push({ connection, ...(dbName ? { dbName } : {}) });
  };

  recentTargets.forEach((target) => {
    const connection = connectionById.get(target.connectionId);
    if (connection) {
      append(connection, target.dbName);
    }
  });
  queryCapableConnections.forEach((connection) => {
    if (!seenConnectionIds.has(connection.id)) {
      append(connection);
    }
  });
  return result;
};

export const buildPinnedTableShortcuts = (
  connections: SavedConnection[],
  pinnedTableKeys: string[],
): PinnedTableShortcut[] => {
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  const seen = new Set<string>();
  const result: PinnedTableShortcut[] = [];

  for (const rawKey of pinnedTableKeys) {
    if (result.length >= RECENT_WORKBENCH_ITEM_LIMIT) break;
    try {
      const parsed = JSON.parse(rawKey);
      if (!Array.isArray(parsed) || parsed.length !== 4) continue;
      const [rawConnectionId, rawDbName, rawSchemaName, rawTableName] = parsed;
      const connectionId = String(rawConnectionId || '').trim();
      const dbName = String(rawDbName || '').trim();
      const schemaName = String(rawSchemaName || '').trim();
      const tableName = String(rawTableName || '').trim();
      const connection = connectionById.get(connectionId);
      const key = `${connectionId}::${dbName}::${schemaName}::${tableName}`;
      if (!connection || !dbName || !tableName || seen.has(key)) continue;
      seen.add(key);
      result.push({
        connection,
        dbName,
        ...(schemaName ? { schemaName } : {}),
        tableName,
      });
    } catch {
      // 旧版本或损坏的本地偏好不应阻塞工作台首页。
    }
  }
  return result;
};

const buildLinkedExternalSQLDirectoryShortcuts = (
  connections: SavedConnection[],
  directories: ExternalSQLDirectory[],
): LinkedExternalSQLDirectoryShortcut[] => {
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  return [...directories]
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
    .flatMap((directory) => {
      const connectionId = String(directory.connectionId || '').trim();
      const connection = connectionById.get(connectionId);
      if (!connection) return [];
      const dbName = String(directory.dbName || connection.config.database || '').trim() || undefined;
      return [{ connection, ...(dbName ? { dbName } : {}), directory }];
    })
    .slice(0, RECENT_WORKBENCH_ITEM_LIMIT);
};

const buildWorkbenchQueryTabId = (): string =>
  `query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const getTabKindTooltipLabel = (tab: TabData): string => {
  if (tab.type === 'query') return t('tab_manager.hover.kind.query');
  if (tab.type === 'table') return t('tab_manager.hover.kind.table');
  if (tab.type === 'design') return t('tab_manager.hover.kind.design');
  if (tab.type === 'table-overview') return t('tab_manager.hover.kind.table_overview');
  if (tab.type === 'table-export') return t('tab_manager.hover.kind.table_export');
  if (tab.type === 'data-import') return t('tab_manager.hover.kind.data_import');
  if (tab.type === 'data-sync') return t('app.tools.entry.sync.title');
  if (tab.type === 'sql-file-execution') return t('sidebar.sql_file_exec.title');
  if (tab.type === 'sql-analysis') return t('tab_manager.hover.kind.sql_analysis');
  if (tab.type === 'sql-audit') return t('tab_manager.hover.kind.sql_audit');
  if (tab.type === 'redis-keys') return t('tab_manager.hover.kind.redis_keys');
  if (tab.type === 'redis-command') return t('tab_manager.hover.kind.redis_command');
  if (tab.type === 'redis-monitor') return t('tab_manager.hover.kind.redis_monitor');
  if (tab.type === 'nacos-config') return t('tab_manager.hover.kind.nacos_config');
  if (tab.type === 'nacos-services') return t('tab_manager.hover.kind.nacos_services');
  if (tab.type === 'jvm-overview') return t('tab_manager.hover.kind.jvm_overview');
  if (tab.type === 'jvm-resource') return t('tab_manager.hover.kind.jvm_resource');
  if (tab.type === 'jvm-audit') return t('tab_manager.hover.kind.jvm_audit');
  if (tab.type === 'jvm-diagnostic') return t('tab_manager.hover.kind.jvm_diagnostic');
  if (tab.type === 'jvm-monitoring') return t('tab_manager.hover.kind.jvm_monitoring');
  if (tab.type === 'trigger') return t('tab_manager.hover.kind.trigger');
  if (tab.type === 'view-def') {
    return tab.viewKind === 'materialized'
      ? t('tab_manager.hover.kind.materialized_view')
      : t('tab_manager.hover.kind.view');
  }
  if (tab.type === 'event-def') return t('tab_manager.hover.kind.event');
  if (tab.type === 'routine-def') return t('tab_manager.hover.kind.routine');
  if (tab.type === 'sequence-def') return t('tab_manager.hover.kind.sequence');
  if (tab.type === 'package-def') return t('tab_manager.hover.kind.package');
  return t('tab_manager.hover.kind.fallback');
};

const getTabObjectLabel = (tab: TabData): string => {
  if (tab.tableName) return tab.tableName;
  if (tab.viewName) return tab.viewName;
  if (tab.eventName) return tab.eventName;
  if (tab.routineName) return tab.routineName;
  if (tab.sequenceName) return tab.sequenceName;
  if (tab.packageName) return tab.packageName;
  if (tab.triggerName) return tab.triggerName;
  if (tab.resourcePath) return tab.resourcePath;
  if (tab.filePath) return tab.filePath;
  if (tab.type === 'sql-analysis' || tab.type === 'sql-audit') return tab.title;
  if (tab.type.startsWith('redis')) return `db${tab.redisDB ?? 0}`;
  return '';
};

const getCloseOtherTabIds = (tabs: TabData[], id: string): string[] =>
  tabs.filter((tab) => tab.id !== id).map((tab) => tab.id);

const getCloseTabsToLeftIds = (tabs: TabData[], id: string): string[] => {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index <= 0) return [];
  return tabs.slice(0, index).map((tab) => tab.id);
};

const getCloseTabsToRightIds = (tabs: TabData[], id: string): string[] => {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0 || index >= tabs.length - 1) return [];
  return tabs.slice(index + 1).map((tab) => tab.id);
};

export const stopTabHoverDragPropagation = (event: React.SyntheticEvent<HTMLElement>) => {
  event.stopPropagation();
};

export const resolveTabHoverOpen = (isHoverInfoOpen: boolean, isTabMenuOpen: boolean) =>
  isHoverInfoOpen && !isTabMenuOpen;

export const openTabDisplaySettings = () => {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new CustomEvent('gonavi:open-tab-display-settings'));
};

export const shouldShowV2ConnectionLabel = (displayTitle: string, connectionLabel?: string): boolean => {
  const normalizedConnectionLabel = String(connectionLabel || '').trim();
  if (!normalizedConnectionLabel) {
    return false;
  }

  const normalizedDisplayTitle = String(displayTitle || '').trim();
  if (!normalizedDisplayTitle) {
    return true;
  }

  const escapedConnectionLabel = normalizedConnectionLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefixedConnectionPattern = new RegExp(`^\\[${escapedConnectionLabel}(?:\\s*[|\\]])`, 'i');
  return !prefixedConnectionPattern.test(normalizedDisplayTitle);
};

export const resolveTabHoverTitle = (displayModel: TabDisplayModel | undefined, fallbackTitle: string): string => {
  if (!displayModel) {
    return fallbackTitle;
  }

  const objectPart = [...displayModel.primaryParts, ...displayModel.secondaryParts]
    .find((part) => part.key === 'object');
  if (objectPart?.text) {
    return objectPart.text;
  }

  const primaryText = displayModel.primaryParts
    .filter((part) => part.key !== 'kind')
    .map((part) => part.text)
    .join(' ')
    .trim();
  return primaryText || displayModel.primaryText || fallbackTitle;
};

type TabHoverInfoProps = {
  tab: TabData;
  displayModel?: TabDisplayModel;
  displayTitle: string;
  connectionLabel?: string;
  hostSummary?: string;
};

export const TabHoverInfo: React.FC<TabHoverInfoProps> = ({
  tab,
  displayModel,
  displayTitle,
  connectionLabel,
  hostSummary,
}) => {
  const objectLabel = getTabObjectLabel(tab);
  const hoverTitle = resolveTabHoverTitle(displayModel, displayTitle);
  const schemaPart = displayModel
    ? [...displayModel.primaryParts, ...displayModel.secondaryParts].find((part) => part.key === 'schema')
    : undefined;
  const rows = [
    [t('tab_manager.hover.label.type'), getTabKindTooltipLabel(tab)],
    [t('tab_manager.hover.label.connection'), connectionLabel || t('tab_manager.hover.fallback.unbound_connection')],
    ['Host', hostSummary || t('tab_manager.hover.fallback.host_not_configured')],
    [t('tab_manager.hover.label.database'), tab.dbName || t('tab_manager.hover.fallback.database_not_specified')],
    ['Schema', schemaPart?.value],
    [t('tab_manager.hover.label.object'), objectLabel],
  ].filter(([, value]) => Boolean(value));

  return (
    <div
      className="gn-v2-tab-hover-card"
      data-tab-hover-info="true"
      onPointerDown={stopTabHoverDragPropagation}
      onPointerMove={stopTabHoverDragPropagation}
      onPointerUp={stopTabHoverDragPropagation}
      onPointerDownCapture={stopTabHoverDragPropagation}
      onPointerUpCapture={stopTabHoverDragPropagation}
      onMouseDown={stopTabHoverDragPropagation}
      onMouseMove={stopTabHoverDragPropagation}
      onMouseUp={stopTabHoverDragPropagation}
      onClick={stopTabHoverDragPropagation}
      onClickCapture={stopTabHoverDragPropagation}
      onTouchStart={stopTabHoverDragPropagation}
      onTouchMove={stopTabHoverDragPropagation}
      onTouchEnd={stopTabHoverDragPropagation}
    >
      <div className="gn-v2-tab-hover-head">
        <span>{getTabKindLabel(tab)}</span>
        <strong>{hoverTitle}</strong>
      </div>
      <div className="gn-v2-tab-hover-rows">
        {rows.map(([label, value]) => (
          <div className="gn-v2-tab-hover-row" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
};

type SortableTabLabelProps = {
  tab: TabData;
  displayModel: TabDisplayModel;
  displayTitle: string;
  menuItems: MenuProps['items'];
  connectionLabel?: string;
  hostSummary?: string;
  environmentColor?: string;
  environmentLabel?: string;
  environmentType?: string;
  isV2Ui?: boolean;
  onClose?: () => void;
};

export const isMiddleMouseButton = (button: number): boolean => button === 1;

const renderV2TabDisplayPart = (part: TabDisplayPart) => {
  if (part.key === 'kind') {
    return (
      <span className="gn-v2-tab-kind" key={part.key}>
        {part.text}
      </span>
    );
  }
  return (
    <span className={`gn-v2-tab-label-part gn-v2-tab-label-part-${part.key}`} key={part.key}>
      {part.text}
    </span>
  );
};

const renderV2TabSecondaryParts = (parts: TabDisplayPart[]) => parts.map((part, index) => (
  <React.Fragment key={part.key}>
    {index > 0 ? <span className="gn-v2-tab-label-separator" aria-hidden="true">·</span> : null}
    {renderV2TabDisplayPart(part)}
  </React.Fragment>
));

const SortableTabLabel: React.FC<SortableTabLabelProps> = ({
  tab,
  displayModel,
  displayTitle,
  menuItems,
  connectionLabel,
  hostSummary,
  environmentColor,
  environmentLabel,
  environmentType,
  isV2Ui,
  onClose,
}) => {
  const [isHoverInfoOpen, setIsHoverInfoOpen] = useState(false);
  const [isTabMenuOpen, setIsTabMenuOpen] = useState(false);

  const handleTabLabelContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    setIsHoverInfoOpen(false);
    setIsTabMenuOpen(true);
  };

  const handleTabLabelMouseDown = (event: React.MouseEvent<HTMLElement>) => {
    if (!onClose || !isMiddleMouseButton(event.button)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const handleTabLabelAuxClick = (event: React.MouseEvent<HTMLElement>) => {
    if (!onClose || !isMiddleMouseButton(event.button)) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  const handleTabMenuOpenChange = (open: boolean) => {
    setIsTabMenuOpen(open);
    setIsHoverInfoOpen(false);
  };

  const handleHoverInfoOpenChange = (open: boolean) => {
    setIsHoverInfoOpen(open && !isTabMenuOpen);
  };

  const tabDisplayPartCount = displayModel.primaryParts.length + displayModel.secondaryParts.length;
  const showSecondaryLine = isV2Ui && displayModel.layout === 'double' && Boolean(displayModel.secondaryText);
  const labelNode = (
    <span
      className={`tab-dnd-label${isV2Ui ? ' gn-v2-tab-label' : ''}${showSecondaryLine ? ' gn-v2-tab-label-double' : ''}${tabDisplayPartCount >= 4 ? ' gn-v2-tab-label-rich' : ''}${environmentColor ? ' gn-tab-label-has-environment' : ''}`}
      data-connection-environment={environmentType}
      onContextMenu={handleTabLabelContextMenu}
      onMouseDown={handleTabLabelMouseDown}
      onAuxClick={handleTabLabelAuxClick}
      title={isV2Ui ? undefined : displayTitle}
    >
      {environmentColor ? (
        <span
          className="gn-tab-environment-accent"
          style={{
            '--gn-tab-environment-color': environmentColor,
          } as React.CSSProperties}
          title={environmentLabel}
          aria-label={environmentLabel}
        />
      ) : null}
      {isV2Ui ? (
        <span className="gn-v2-tab-label-content">
          <span className="gn-v2-tab-label-main tab-title-text">
            {displayModel.primaryParts.length > 0
              ? displayModel.primaryParts.map(renderV2TabDisplayPart)
              : displayModel.primaryText}
          </span>
          {showSecondaryLine ? (
            <span
              className="gn-v2-tab-label-secondary"
              title={displayModel.secondaryText}
              aria-label={displayModel.secondaryText}
            >
              {renderV2TabSecondaryParts(displayModel.secondaryParts)}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="tab-title-text">{displayTitle}</span>
      )}
      {isV2Ui && onClose ? (
        <button
          type="button"
          className="gn-v2-tab-close"
          aria-label={t('tab_manager.close_aria', { title: displayTitle })}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }}
        >
          <CloseOutlined />
        </button>
      ) : null}
    </span>
  );

  const wrappedLabel = isV2Ui ? (
    <Tooltip
      title={(
        <TabHoverInfo
          tab={tab}
          displayModel={displayModel}
          displayTitle={displayTitle}
          connectionLabel={connectionLabel}
          hostSummary={hostSummary}
        />
      )}
      placement="bottomLeft"
      mouseEnterDelay={1.2}
      open={resolveTabHoverOpen(isHoverInfoOpen, isTabMenuOpen)}
      onOpenChange={handleHoverInfoOpenChange}
      destroyOnHidden
      rootClassName="gn-v2-tab-hover-tooltip"
    >
      {labelNode}
    </Tooltip>
  ) : labelNode;

  return (
    <Dropdown
      menu={{ items: menuItems }}
      trigger={['contextMenu']}
      onOpenChange={handleTabMenuOpenChange}
      rootClassName={isV2Ui ? 'gn-v2-tab-context-menu-popup' : undefined}
    >
      {wrappedLabel}
    </Dropdown>
  );
};

type DraggableTabNodeProps = {
  node: React.ReactElement;
};

const TAB_DRAG_INTERACTIVE_SELECTOR = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="menuitem"]',
  '[data-tab-drag-ignore="true"]',
  '.ant-dropdown-menu',
  '.ant-tabs-tab-remove',
  '.gn-v2-tab-close',
].join(', ');

export const shouldActivateTabDragPointer = (event: {
  button: number;
  ctrlKey?: boolean;
  isPrimary?: boolean;
  target: EventTarget | null;
}): boolean => {
  if (event.button !== 0 || event.ctrlKey || event.isPrimary === false) return false;
  const target = event.target as { closest?: (selector: string) => Element | null } | null;
  return typeof target?.closest !== 'function'
    || target.closest(TAB_DRAG_INTERACTIVE_SELECTOR) === null;
};

export const handleTabDragPointerDown = (
  event: React.PointerEvent<HTMLElement>,
  handlePointerDown?: React.PointerEventHandler<HTMLElement>,
): void => {
  if (!shouldActivateTabDragPointer(event)) return;
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture is not exposed by every embedded WebView build.
  }
  handlePointerDown?.(event);
};

type TabDetachDragGuardOptions = {
  windowTarget: EventTarget;
  captureTarget: EventTarget | null;
  rootClassList: Pick<DOMTokenList, 'add' | 'remove'>;
  pointerId: number | null;
  isCurrent: () => boolean;
  onTerminalPointer: (pointer: NativeDetachTerminalPointer) => void;
  onInterrupted: () => void;
  cancelDndDrag: () => void;
};

export const installTabDetachDragGuards = ({
  windowTarget,
  captureTarget,
  rootClassList,
  pointerId,
  isCurrent,
  onTerminalPointer,
  onInterrupted,
  cancelDndDrag,
}: TabDetachDragGuardOptions): (() => void) => {
  let removed = false;
  const matchesPointer = (event: PointerEvent) => (
    pointerId === null || event.pointerId === pointerId
  );
  const interrupt = () => {
    if (removed || !isCurrent()) return;
    try {
      onInterrupted();
    } finally {
      cancelDndDrag();
    }
  };
  const recordTerminalPointer = (event: Event) => {
    const pointerEvent = event as PointerEvent;
    if (removed || !isCurrent() || !matchesPointer(pointerEvent)) return;
    onTerminalPointer({
      type: event.type === 'pointercancel' ? 'pointercancel' : 'pointerup',
      clientX: pointerEvent.clientX,
      clientY: pointerEvent.clientY,
      screenX: pointerEvent.screenX,
      screenY: pointerEvent.screenY,
    });
  };
  const handlePointerMove = (event: Event) => {
    const pointerEvent = event as PointerEvent;
    if (matchesPointer(pointerEvent) && pointerEvent.buttons === 0) {
      interrupt();
    }
  };
  const handleLostPointerCapture = (event: Event) => {
    if (matchesPointer(event as PointerEvent)) {
      interrupt();
    }
  };
  const handleWindowBlur = () => interrupt();

  windowTarget.addEventListener('pointermove', handlePointerMove, true);
  windowTarget.addEventListener('pointerup', recordTerminalPointer, true);
  windowTarget.addEventListener('pointercancel', recordTerminalPointer, true);
  windowTarget.addEventListener('blur', handleWindowBlur);
  captureTarget?.addEventListener('lostpointercapture', handleLostPointerCapture);
  rootClassList.add('gn-workbench-tab-detaching');

  return () => {
    if (removed) return;
    removed = true;
    windowTarget.removeEventListener('pointermove', handlePointerMove, true);
    windowTarget.removeEventListener('pointerup', recordTerminalPointer, true);
    windowTarget.removeEventListener('pointercancel', recordTerminalPointer, true);
    windowTarget.removeEventListener('blur', handleWindowBlur);
    captureTarget?.removeEventListener('lostpointercapture', handleLostPointerCapture);
    if (captureTarget && pointerId !== null) {
      const pointerCaptureTarget = captureTarget as HTMLElement;
      try {
        if (pointerCaptureTarget.hasPointerCapture?.(pointerId)) {
          pointerCaptureTarget.releasePointerCapture(pointerId);
        }
      } catch {
        // Pointer capture may already be gone after blur, cancellation, or unmount.
      }
    }
    rootClassList.remove('gn-workbench-tab-detaching');
  };
};

const DraggableTabNode: React.FC<DraggableTabNodeProps> = ({ node }) => {
  const tabId = String(node.key || '').trim();
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tabId });
  const style: React.CSSProperties = {
    ...(node.props.style || {}),
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)',
    opacity: isDragging ? 0.88 : 1,
    cursor: isDragging ? 'grabbing' : 'grab',
    touchAction: 'none',
    zIndex: isDragging ? 2 : node.props.style?.zIndex,
  };
  const handlePointerDown = listeners?.onPointerDown as React.PointerEventHandler<HTMLElement> | undefined;

  return React.cloneElement(node, {
    ref: setNodeRef,
    style,
    ...listeners,
    onPointerDown: (event: React.PointerEvent<HTMLElement>) =>
      handleTabDragPointerDown(event, handlePointerDown),
    className: `${node.props.className || ''} tab-dnd-node${isDragging ? ' is-dragging' : ''}`,
  });
};

type TabManagerProps = {
  onFocusSidebarSearch?: () => void;
};

const TabManager: React.FC<TabManagerProps> = React.memo<TabManagerProps>(({ onFocusSidebarSearch }) => {
  const tabs = useWorkbenchTabs();
  const detachedWorkbenchWindows = useStore(state => state.detachedWorkbenchWindows);
  const connections = useStore(state => state.connections);
  const connectionTags = useStore(state => state.connectionTags);
  const savedQueries = useStore(state => state.savedQueries);
  const externalSQLDirectories = useStore(state => state.externalSQLDirectories);
  const recentConnectionTargets = useStore(state => state.recentConnectionTargets);
  const recentSQLFiles = useStore(state => state.recentSQLFiles);
  const pinnedSidebarTables = useStore(state => state.pinnedSidebarTables);
  const theme = useStore(state => state.theme);
  const appearance = useStore(state => state.appearance);
  const languagePreference = useStore(state => state.languagePreference);
  const activeTabId = useStore(state => state.activeTabId);
  const setActiveTab = useStore(state => state.setActiveTab);
  const addTab = useStore(state => state.addTab);
  const closeTab = useStore(state => state.closeTab);
  const closeOtherTabs = useStore(state => state.closeOtherTabs);
  const closeTabsToLeft = useStore(state => state.closeTabsToLeft);
  const closeTabsToRight = useStore(state => state.closeTabsToRight);
  const closeAllTabs = useStore(state => state.closeAllTabs);
  const moveTab = useStore(state => state.moveTab);
  const setAIPanelVisible = useStore(state => state.setAIPanelVisible);
  const detachedTabIdSet = useMemo(
    () => new Set(detachedWorkbenchWindows.map((windowState) => windowState.tabId)),
    [detachedWorkbenchWindows],
  );
  const dockedTabs = useMemo(
    () => tabs.filter((tab) => !detachedTabIdSet.has(tab.id)),
    [detachedTabIdSet, tabs],
  );
  const tabsNavBorderColor = theme === 'dark' ? 'rgba(255, 255, 255, 0.09)' : 'rgba(0, 0, 0, 0.08)';
  const tabWorkbenchRef = useRef<HTMLDivElement>(null);
  const [v2TabWidth, setV2TabWidth] = useState(V2_WORKBENCH_TAB_MAX_WIDTH);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [detachDragPreview, setDetachDragPreview] = useState<DetachDragPreviewState | null>(null);
  const [openingRecentSQLFileKey, setOpeningRecentSQLFileKey] = useState<string | null>(null);
  const detachDragSessionRef = useRef<{
    tabId: string;
    title: string;
    startX: number;
    startY: number;
    startScreenX: number;
    startScreenY: number;
    pointerId: number | null;
    captureTarget: HTMLElement | null;
    terminalPointer: NativeDetachTerminalPointer | null;
    removeDragGuards: (() => void) | null;
  } | null>(null);
  const suppressClickUntilRef = useRef<number>(0);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );
  const isV2Ui = appearance.uiVersion === 'v2';
  const hasTabs = tabs.length > 0;
  const hasDockedTabs = dockedTabs.length > 0;
  useLayoutEffect(() => {
    if (!isV2Ui || dockedTabs.length === 0) {
      setV2TabWidth(V2_WORKBENCH_TAB_MAX_WIDTH);
      return;
    }

    const target = tabWorkbenchRef.current;
    if (!target) return;

    const updateWidth = (availableWidth: number) => {
      const nextWidth = resolveV2WorkbenchTabWidth(availableWidth, dockedTabs.length);
      setV2TabWidth((currentWidth) => currentWidth === nextWidth ? currentWidth : nextWidth);
    };
    const measure = () => updateWidth(target.getBoundingClientRect().width);

    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }

    const observer = new ResizeObserver((entries) => {
      updateWidth(entries[0]?.contentRect.width ?? target.getBoundingClientRect().width);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [dockedTabs.length, isV2Ui]);

  const tabWorkbenchStyle = isV2Ui
    ? ({ '--gn-v2-tab-width': `${v2TabWidth}px` } as React.CSSProperties)
    : undefined;
  const detachTabToWindow = useCallback((tabId: string, preferred?: { x?: number; y?: number; width?: number; height?: number }) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (tab && isBackgroundTaskWorkbenchTab(tab)) {
      void message.warning(t('tab_manager.message.background_task_window_unavailable'));
      return;
    }
    void openNativeWorkbenchTabWindow(tabId, preferred).catch((error) => {
      message.error(error instanceof Error ? error.message : String(error));
    });
  }, [tabs]);
  const dockedActiveTabId = useMemo(() => {
    return resolveDockedActiveTabId(tabs, activeTabId, detachedWorkbenchWindows);
  }, [activeTabId, detachedWorkbenchWindows, tabs]);
  const pendingCloseTabIdsRef = useRef<Set<string>>(new Set());

  const onChange = (newActiveKey: string) => {
    setActiveTab(newActiveKey);
  };

  const requestCloseSQLFileTabs = useCallback(async (
    targetTabs: TabData[],
    closeConfirmedTabs: () => void,
  ) => {
    const candidateTabs = targetTabs.filter(isSQLFileQueryTab);
    if (candidateTabs.length === 0) {
      closeConfirmedTabs();
      return;
    }

    const closeConfirmedTabsAndClearDrafts = () => {
      closeConfirmedTabs();
      candidateTabs.forEach((tab) => clearSQLFileTabDraft(tab.id));
    };

    const dirtyTabs: Array<{ tab: TabData; draft: string }> = [];
    const missingFileTabs: Array<{ tab: TabData; filePath: string }> = [];
    for (const tab of candidateTabs) {
      const filePath = getSQLFileTabPath(tab);
      if (!filePath) continue;
      try {
        const res = await ReadSQLFile(filePath);
        if (!res.success) {
          if (isSQLFileMissingReadResult(res)) {
            missingFileTabs.push({ tab, filePath });
            continue;
          }
          message.error(t('tab_manager.sql_file_close.read_failed_cancel_close', { detail: res.message || filePath }));
          return;
        }
        const latestTab = useStore.getState().tabs.find((candidate) => candidate.id === tab.id);
        const draft = getSQLFileTabDraft(
          tab.id,
          String(latestTab?.query ?? tab.query ?? ''),
        );
        if (hasSQLFileTabUnsavedChanges({ ...tab, query: draft }, normalizeSQLFileReadContent(res.data))) {
          dirtyTabs.push({ tab, draft });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (isSQLFileMissingErrorMessage(errorMessage)) {
          missingFileTabs.push({ tab, filePath });
          continue;
        }
        message.error(t('tab_manager.sql_file_close.read_failed_cancel_close', { detail: errorMessage }));
        return;
      }
    }

    const confirmDirtyTabsOrClose = () => {
      if (dirtyTabs.length === 0) {
        closeConfirmedTabsAndClearDrafts();
        return;
      }

      const firstDirtyTab = dirtyTabs[0].tab;
      const dirtyFilePath = getSQLFileTabPath(firstDirtyTab);
      const dirtyLabel = dirtyTabs.length === 1
        ? t('tab_manager.sql_file_close.dirty_single_label', { title: firstDirtyTab.title || dirtyFilePath })
        : t('tab_manager.sql_file_close.dirty_multiple_label', { count: dirtyTabs.length });

      let destroyConfirm: (() => void) | null = null;
      const confirmRef = Modal.confirm({
        title: t('tab_manager.sql_file_close.save_confirm_title'),
        content: t('tab_manager.sql_file_close.save_confirm_content', { label: dirtyLabel }),
        okText: t('tab_manager.sql_file_close.save_and_close'),
        cancelText: t('common.cancel'),
        closable: true,
        maskClosable: true,
        okButtonProps: { type: 'primary' },
        footer: (_, { OkBtn, CancelBtn }) => (
          <>
            <Button
              onClick={() => {
                destroyConfirm?.();
                closeConfirmedTabsAndClearDrafts();
              }}
            >
              {t('tab_manager.sql_file_close.discard')}
            </Button>
            <CancelBtn />
            <OkBtn />
          </>
        ),
        onOk: async () => {
          try {
            for (const { tab, draft } of dirtyTabs) {
              const filePath = getSQLFileTabPath(tab);
              if (!filePath) continue;
              const res = await WriteSQLFile(filePath, draft);
              if (!res.success) {
                throw new Error(t('tab_manager.sql_file_close.save_failed', {
                  title: tab.title || filePath,
                  detail: res.message || t('tab_manager.sql_file_close.unknown_error'),
                }));
              }
            }
            message.success(t('tab_manager.sql_file_close.saved'));
            closeConfirmedTabsAndClearDrafts();
          } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
            throw error;
          }
        },
      });
      destroyConfirm = confirmRef.destroy;
    };

    if (missingFileTabs.length > 0) {
      const firstMissing = missingFileTabs[0];
      const missingLabel = missingFileTabs.length === 1
        ? t('tab_manager.sql_file_close.missing_single_label', { title: firstMissing.tab.title || firstMissing.filePath })
        : t('tab_manager.sql_file_close.missing_multiple_label', { count: missingFileTabs.length });
      Modal.confirm({
        title: t('tab_manager.sql_file_close.missing_confirm_title'),
        content: t('tab_manager.sql_file_close.missing_confirm_content', { label: missingLabel }),
        okText: dirtyTabs.length > 0 ? t('tab_manager.sql_file_close.continue_close') : t('tab_manager.sql_file_close.close_tabs'),
        cancelText: t('common.cancel'),
        closable: true,
        maskClosable: true,
        okButtonProps: { danger: true },
        onOk: () => {
          confirmDirtyTabsOrClose();
        },
      });
      return;
    }

    confirmDirtyTabsOrClose();
  }, []);

  const closeTabsWithSQLFilePrompt = useCallback((targetIds: string[], closeConfirmedTabs: () => void) => {
    const uniqueIds = Array.from(new Set(targetIds.map((id) => String(id || '').trim()).filter(Boolean)));
    if (uniqueIds.length === 0) return;
    const targetIdSet = new Set(uniqueIds);
    // Query text is intentionally excluded from the chrome subscription. Resolve
    // close/save candidates from the live store so SQL-file dirty checks never
    // fall back to the render snapshot after an editor-only update.
    const targetTabs = useStore.getState().tabs.filter((tab) => targetIdSet.has(tab.id));
    const runningImportTabs = targetTabs.filter(isRunningDataImportWorkbenchTab);
    if (runningImportTabs.length > 0) {
      void message.warning(t('tab_manager.message.data_import_running_close_blocked'));
    }
    const closableTabs = targetTabs.filter((tab) => !isRunningDataImportWorkbenchTab(tab));
    if (closableTabs.length === 0) return;
    const dedupeKey = closableTabs.map((tab) => tab.id).sort().join('\n');
    if (pendingCloseTabIdsRef.current.has(dedupeKey)) return;
    pendingCloseTabIdsRef.current.add(dedupeKey);
    void requestCloseSQLFileTabs(closableTabs, closeConfirmedTabs).finally(() => {
      pendingCloseTabIdsRef.current.delete(dedupeKey);
    });
  }, [requestCloseSQLFileTabs]);

  const requestCloseActiveWorkspaceTab = useCallback(() => {
    if (!dockedActiveTabId) return;
    closeTabsWithSQLFilePrompt(
      [dockedActiveTabId],
      () => closeTab(dockedActiveTabId),
    );
  }, [closeTab, closeTabsWithSQLFilePrompt, dockedActiveTabId]);

  useEffect(() => {
    window.addEventListener(CLOSE_ACTIVE_WORKSPACE_TAB_EVENT, requestCloseActiveWorkspaceTab);
    return () => {
      window.removeEventListener(CLOSE_ACTIVE_WORKSPACE_TAB_EVENT, requestCloseActiveWorkspaceTab);
    };
  }, [requestCloseActiveWorkspaceTab]);

  const onEdit = (targetKey: React.MouseEvent | React.KeyboardEvent | string, action: 'add' | 'remove') => {
    if (action === 'remove') {
      const id = String(targetKey || '');
      closeTabsWithSQLFilePrompt([id], () => closeTab(id));
    }
  };

  const dispatchDndPointerCancel = useCallback(() => {
    document.dispatchEvent(new Event('pointercancel', {
      bubbles: true,
      cancelable: true,
    }));
  }, []);

  const clearDetachDragSession = useCallback(() => {
    const session = detachDragSessionRef.current;
    session?.removeDragGuards?.();
    if (session?.captureTarget && session.pointerId !== null) {
      try {
        if (session.captureTarget.hasPointerCapture?.(session.pointerId)) {
          session.captureTarget.releasePointerCapture(session.pointerId);
        }
      } catch {
        // Pointer capture may already have been released by the native WebView.
      }
    }
    detachDragSessionRef.current = null;
    setDetachDragPreview(null);
    document.documentElement.classList.remove('gn-workbench-tab-detaching');
  }, []);

  useEffect(() => () => {
    const hadActiveSession = detachDragSessionRef.current !== null;
    clearDetachDragSession();
    if (hadActiveSession) {
      dispatchDndPointerCancel();
    }
  }, [clearDetachDragSession, dispatchDndPointerCancel]);

  const handleDragStart = (event: DragStartEvent) => {
    clearDetachDragSession();
    const sourceId = String(event.active.id || '').trim();
    setDraggingTabId(sourceId || null);
    const tab = dockedTabs.find((item) => item.id === sourceId);
    const connection = connections.find((conn) => conn.id === tab?.connectionId);
    const displayModel = tab
      ? buildTabDisplayModel(tab, connection, appearance.tabDisplay, t)
      : null;
    const title = displayModel?.fullTitle || tab?.title || t('tab_manager.detached.title_fallback');
    const pointerEvent = event.activatorEvent as PointerEvent | MouseEvent | undefined;
    const startX = typeof pointerEvent?.clientX === 'number' ? pointerEvent.clientX : 0;
    const startY = typeof pointerEvent?.clientY === 'number' ? pointerEvent.clientY : 0;
    const startScreenX = typeof pointerEvent?.screenX === 'number'
      ? pointerEvent.screenX
      : window.screenX + startX;
    const startScreenY = typeof pointerEvent?.screenY === 'number'
      ? pointerEvent.screenY
      : window.screenY + startY;
    const pointerId = typeof (pointerEvent as PointerEvent | undefined)?.pointerId === 'number'
      ? (pointerEvent as PointerEvent).pointerId
      : null;
    const activatorTarget = pointerEvent?.target;
    const captureTarget = typeof Element !== 'undefined' && activatorTarget instanceof Element
      ? activatorTarget.closest<HTMLElement>('.tab-dnd-node')
      : null;
    const session = sourceId
      ? {
          tabId: sourceId,
          title,
          startX,
          startY,
          startScreenX,
          startScreenY,
          pointerId,
          captureTarget,
          terminalPointer: null as NativeDetachTerminalPointer | null,
          removeDragGuards: null as (() => void) | null,
        }
      : null;
    detachDragSessionRef.current = session;
    if (session) {
      session.removeDragGuards = installTabDetachDragGuards({
        windowTarget: window,
        captureTarget: session.captureTarget,
        rootClassList: document.documentElement.classList,
        pointerId: session.pointerId,
        isCurrent: () => detachDragSessionRef.current === session,
        onTerminalPointer: (terminalPointer) => {
          session.terminalPointer = terminalPointer;
        },
        onInterrupted: () => {
          setDraggingTabId(null);
          clearDetachDragSession();
        },
        cancelDndDrag: dispatchDndPointerCancel,
      });
    }
  };

  const handleDragMove = (event: DragMoveEvent) => {
    const session = detachDragSessionRef.current;
    if (!session) return;
    const deltaX = Number(event.delta?.x || 0);
    const deltaY = Number(event.delta?.y || 0);
    setDetachDragPreview(buildDetachDragPreviewState({
      title: session.title,
      clientX: session.startX + deltaX,
      clientY: session.startY + deltaY,
      deltaY,
    }));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const sourceId = String(event.active.id || '').trim();
    const targetId = String(event.over?.id || '').trim();
    const deltaX = Number(event.delta?.x || 0);
    const deltaY = Number(event.delta?.y || 0);
    const session = detachDragSessionRef.current;
    const release = resolveNativeDetachDragRelease({
      startClientX: session?.startX ?? 0,
      startClientY: session?.startY ?? 0,
      startScreenX: session?.startScreenX ?? window.screenX,
      startScreenY: session?.startScreenY ?? window.screenY,
      fallbackDeltaX: deltaX,
      fallbackDeltaY: deltaY,
      terminalPointer: session?.terminalPointer,
    });
    setDraggingTabId(null);
    clearDetachDragSession();
    if (!sourceId) {
      return;
    }
    const releasedOutsideHost = shouldDetachAtScreenPoint(release.screenX, release.screenY, {
      x: window.screenX,
      y: window.screenY,
      width: window.outerWidth || window.innerWidth,
      height: window.outerHeight || window.innerHeight,
    });
    if (shouldDetachTabByDrag(release.deltaY, targetId || null) || releasedOutsideHost) {
      suppressClickUntilRef.current = Date.now() + 120;
      const preferred = resolveNativeDetachPreferredBounds(release.screenX, release.screenY);
      detachTabToWindow(sourceId, preferred);
      return;
    }
    if (!targetId || sourceId === targetId) {
      return;
    }
    suppressClickUntilRef.current = Date.now() + 120;
    moveTab(sourceId, targetId);
  };

  const handleDragCancel = () => {
    const session = detachDragSessionRef.current;
    const release = resolveNativeDetachDragRelease({
      startClientX: session?.startX ?? 0,
      startClientY: session?.startY ?? 0,
      startScreenX: session?.startScreenX ?? window.screenX,
      startScreenY: session?.startScreenY ?? window.screenY,
      fallbackDeltaX: 0,
      fallbackDeltaY: 0,
      terminalPointer: session?.terminalPointer,
    });
    const shouldDetach = Boolean(session) && shouldDetachAfterNativePointerCancel(release, {
      x: window.screenX,
      y: window.screenY,
      width: window.outerWidth || window.innerWidth,
      height: window.outerHeight || window.innerHeight,
    });
    setDraggingTabId(null);
    clearDetachDragSession();
    if (shouldDetach && session) {
      suppressClickUntilRef.current = Date.now() + 120;
      detachTabToWindow(
        session.tabId,
        resolveNativeDetachPreferredBounds(release.screenX, release.screenY),
      );
    }
  };

  React.useEffect(() => {
    const handleGlobalInsertSql = (e: any) => {
      const { sql, runImmediately, connectionId: eventConnId, dbName: eventDbName } = e.detail;
      if (!sql) return;

      const activeTab = tabs.find(t => t.id === activeTabId);
      
      // 🔧 runImmediately（点击"执行"）始终新建独立 tab，避免追加到已有 tab 导致 SQL 重复
      if (runImmediately) {
        const newTabId = 'tab-' + Date.now();
        const resolvedConnId = eventConnId || activeTab?.connectionId || (connections.length > 0 ? connections[0].id : '');
        const resolvedDbName = eventConnId ? (eventDbName || '') : (activeTab?.dbName || '');
        addTab({
            id: newTabId,
            type: 'query',
            title: t('query.new'),
            query: sql,
            connectionId: resolvedConnId,
            dbName: resolvedDbName
        });
        setActiveTab(newTabId);
        setTimeout(() => {
            window.dispatchEvent(new CustomEvent('gonavi:insert-sql-to-tab', {
                detail: { tabId: newTabId, sql, runImmediately: true, connectionId: resolvedConnId, dbName: resolvedDbName }
            }));
        }, 300);
        return;
      }
      
      // 插入模式：追加到已有 tab 或新建 tab
      if (activeTab && activeTab.type === 'query') {
        window.dispatchEvent(new CustomEvent('gonavi:insert-sql-to-tab', {
          detail: { tabId: activeTab.id, sql, runImmediately: false, connectionId: eventConnId, dbName: eventDbName }
        }));
      } else {
        const newTabId = 'tab-' + Date.now();
        const resolvedConnId = eventConnId || activeTab?.connectionId || (connections.length > 0 ? connections[0].id : '');
        const resolvedDbName = eventConnId ? (eventDbName || '') : (activeTab?.dbName || '');
        addTab({
            id: newTabId,
            type: 'query',
            title: t('query.new'),
            query: sql,
            connectionId: resolvedConnId,
            dbName: resolvedDbName
        });
        setActiveTab(newTabId);
      }
    };
    window.addEventListener('gonavi:insert-sql', handleGlobalInsertSql);
    return () => window.removeEventListener('gonavi:insert-sql', handleGlobalInsertSql);
  }, [tabs, activeTabId, addTab, setActiveTab, connections]);

  const tabIds = useMemo(() => dockedTabs.map((tab) => tab.id), [dockedTabs]);
  const hasDoubleLineTabLabel = useMemo(() => (
    dockedTabs.some((tab) => {
      const connection = connections.find((conn) => conn.id === tab.connectionId);
      const displayModel = buildTabDisplayModel(tab, connection, appearance.tabDisplay, t);
      return displayModel.layout === 'double' && Boolean(displayModel.secondaryText);
    })
  ), [appearance.tabDisplay, connections, dockedTabs]);

  const renderTabBar: TabsProps['renderTabBar'] = (tabBarProps, DefaultTabBar) => (
    <DefaultTabBar {...tabBarProps}>
      {(node) => <DraggableTabNode key={node.key} node={node} />}
    </DefaultTabBar>
  );

  const items = useMemo(() => dockedTabs.map((tab, index) => {
    const connection = connections.find((conn) => conn.id === tab.connectionId);
    const displayModel = buildTabDisplayModel(tab, connection, appearance.tabDisplay, t);
    const environment = connection
      ? resolveConnectionEnvironmentPresentation(connection, connectionTags, t)
      : undefined;
    const displayTitle = displayModel.fullTitle;
    const hostSummary = resolveConnectionHostSummary(connection?.config);
    const tabIsActive = tab.id === dockedActiveTabId;

    const menuItems: MenuProps['items'] = [
      {
        key: 'tab-display-settings',
        icon: <SettingOutlined />,
        label: t('tab_manager.menu.tab_display_settings'),
        onClick: openTabDisplaySettings,
      },
      {
        key: 'open-in-window',
        label: t('tab_manager.menu.open_in_window'),
        disabled: isBackgroundTaskWorkbenchTab(tab),
        onClick: () => detachTabToWindow(tab.id),
      },
      { type: 'divider' },
      {
        key: 'close-other',
        label: t('tab_manager.menu.close_other'),
        disabled: tabs.length <= 1,
        onClick: () => closeTabsWithSQLFilePrompt(getCloseOtherTabIds(tabs, tab.id), () => closeOtherTabs(tab.id)),
      },
      {
        key: 'close-left',
        label: t('tab_manager.menu.close_left'),
        disabled: index === 0,
        onClick: () => closeTabsWithSQLFilePrompt(getCloseTabsToLeftIds(dockedTabs, tab.id), () => closeTabsToLeft(tab.id)),
      },
      {
        key: 'close-right',
        label: t('tab_manager.menu.close_right'),
        disabled: index === dockedTabs.length - 1,
        onClick: () => closeTabsWithSQLFilePrompt(getCloseTabsToRightIds(dockedTabs, tab.id), () => closeTabsToRight(tab.id)),
      },
      { type: 'divider' },
      {
        key: 'close-all',
        label: t('tab_manager.menu.close_all'),
        disabled: tabs.length === 0,
        onClick: () => closeTabsWithSQLFilePrompt(tabs.map((item) => item.id), () => closeAllTabs()),
      },
    ];
    
    return {
      label: (
        <SortableTabLabel
          tab={tab}
          displayModel={displayModel}
          displayTitle={displayTitle}
          menuItems={menuItems}
          connectionLabel={connection?.name}
          hostSummary={hostSummary}
          environmentColor={environment?.color}
          environmentLabel={environment?.label}
          environmentType={environment?.type}
          isV2Ui={isV2Ui}
          onClose={() => closeTabsWithSQLFilePrompt([tab.id], () => closeTab(tab.id))}
        />
      ),
      key: tab.id,
      closable: !isV2Ui,
      children: <WorkbenchTabContent tab={tab} isActive={tabIsActive} />,
    };
  }), [dockedTabs, dockedActiveTabId, tabs, connections, connectionTags, appearance.tabDisplay, closeOtherTabs, closeTabsToLeft, closeTabsToRight, closeAllTabs, closeTab, closeTabsWithSQLFilePrompt, detachTabToWindow, isV2Ui, languagePreference]);

  const queryCapableConnections = useMemo(
    () => connections.filter((connection) => getDataSourceCapabilities(connection.config).supportsQueryEditor),
    [connections],
  );
  const connectionById = useMemo(
    () => new Map(queryCapableConnections.map((connection) => [connection.id, connection])),
    [queryCapableConnections],
  );
  const recentConnectionShortcuts = useMemo(
    () => buildRecentConnectionShortcuts(connections, recentConnectionTargets),
    [connections, recentConnectionTargets],
  );
  const recentSavedQueries = useMemo(
    () => [...savedQueries]
      .filter((query) => connectionById.has(query.connectionId))
      .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
      .slice(0, RECENT_WORKBENCH_ITEM_LIMIT),
    [connectionById, savedQueries],
  );
  const recentSQLFileShortcuts = useMemo(
    () => [...recentSQLFiles]
      .filter((file) => connectionById.has(file.connectionId))
      .sort((left, right) => right.openedAt - left.openedAt)
      .slice(0, RECENT_WORKBENCH_ITEM_LIMIT),
    [connectionById, recentSQLFiles],
  );
  const pinnedTableShortcuts = useMemo(
    () => buildPinnedTableShortcuts(queryCapableConnections, pinnedSidebarTables),
    [pinnedSidebarTables, queryCapableConnections],
  );
  const linkedExternalSQLDirectoryShortcuts = useMemo(
    () => buildLinkedExternalSQLDirectoryShortcuts(queryCapableConnections, externalSQLDirectories),
    [externalSQLDirectories, queryCapableConnections],
  );

  const handleOpenConnectionModal = () => {
    const target = document.querySelector<HTMLButtonElement>('[data-gonavi-create-connection-action="true"]');
    target?.click();
  };

  const handleOpenAI = () => {
    setAIPanelVisible(true);
  };

  const handleFocusObjectSearch = () => {
    if (onFocusSidebarSearch) {
      onFocusSidebarSearch();
      return;
    }
    window.dispatchEvent(new CustomEvent('gonavi:focus-sidebar-search'));
  };

  const handleAddExternalSQLDirectory = () => {
    window.dispatchEvent(new CustomEvent('gonavi:add-external-sql-directory'));
  };

  const handleOpenRecentConnection = useCallback((shortcut: RecentConnectionShortcut) => {
    addTab({
      id: buildWorkbenchQueryTabId(),
      title: t('query.new'),
      type: 'query',
      connectionId: shortcut.connection.id,
      dbName: shortcut.dbName,
      query: '',
    });
  }, [addTab]);

  const handleOpenPinnedTable = useCallback((shortcut: PinnedTableShortcut) => {
    const displayName = shortcut.schemaName
      ? `${shortcut.schemaName}.${shortcut.tableName}`
      : shortcut.tableName;
    addTab({
      id: `pinned-table:${[shortcut.connection.id, shortcut.dbName, shortcut.schemaName || '', shortcut.tableName]
        .map(encodeURIComponent)
        .join(':')}`,
      title: displayName,
      type: 'table',
      connectionId: shortcut.connection.id,
      dbName: shortcut.dbName,
      tableName: shortcut.tableName,
      ...(shortcut.schemaName ? { schemaName: shortcut.schemaName } : {}),
      objectType: 'table',
    });
  }, [addTab]);

  const handleOpenSavedQuery = useCallback((query: SavedQuery) => {
    if (!connectionById.has(query.connectionId)) {
      message.error(t('sidebar.message.connection_config_not_found'));
      return;
    }
    addTab({
      id: query.id,
      title: query.name || t('sidebar.tree.untitled_query'),
      type: 'query',
      connectionId: query.connectionId,
      dbName: query.dbName,
      query: query.sql,
      savedQueryId: query.id,
    });
  }, [addTab, connectionById]);

  const handleOpenRecentSQLFile = useCallback(async (file: RecentSQLFile) => {
    const connectionId = String(file.connectionId || '').trim();
    const dbName = String(file.dbName || '').trim();
    const filePath = String(file.filePath || '').trim();
    if (!connectionId || !connectionById.has(connectionId)) {
      message.error(t('sidebar.message.connection_config_not_found'));
      return;
    }
    if (!filePath) {
      message.error(t('sidebar.message.sql_file_path_incomplete'));
      return;
    }

    const openKey = `${connectionId}::${dbName}::${filePath}`;
    setOpeningRecentSQLFileKey(openKey);
    try {
      const res = await ReadSQLFile(filePath);
      if (!res.success) {
        message.error(t('sidebar.message.read_sql_file_failed', { error: res.message }));
        return;
      }

      const data = res.data;
      if (data && typeof data === 'object' && (data as Record<string, unknown>).isLargeFile === true) {
        const payload = data as Record<string, unknown>;
        addTab(buildSQLFileExecutionWorkbenchTab({
          connectionId,
          dbName: dbName || undefined,
          filePath: String(payload.filePath || '').trim() || filePath,
          fileName: file.fileName,
          fileSizeMB: String(payload.fileSizeMB || '').trim() || undefined,
        }));
        return;
      }

      addTab({
        id: buildExternalSQLTabId(connectionId, dbName, filePath),
        title: file.fileName,
        type: 'query',
        connectionId,
        dbName: dbName || undefined,
        query: normalizeSQLFileReadContent(data),
        filePath,
      });
    } catch (error) {
      message.error(t('sidebar.message.read_sql_file_failed', {
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setOpeningRecentSQLFileKey((current) => current === openKey ? null : current);
    }
  }, [addTab, connectionById]);

  const EmptyWorkbench = (
    <div className="gn-v2-empty-workbench">
      <section className="gn-v2-empty-hero" aria-label={t('tab_manager.empty.aria.start_workbench')}>
        <div className="gn-v2-empty-eyebrow">
          <span>{t('tab_manager.empty.eyebrow.workbench')}</span>
          <span>{t('tab_manager.empty.eyebrow.connections', { count: connections.length })}</span>
        </div>
        <h1>{t('tab_manager.empty.hero.title')}</h1>
        <p>{t('tab_manager.empty.hero.description')}</p>
        <div className="gn-v2-empty-actions">
          <Button type="primary" icon={<PlusOutlined />} onClick={handleOpenConnectionModal}>
            {t('connection.new')}
          </Button>
          <Button icon={<ConsoleSqlOutlined />} onClick={() => window.dispatchEvent(new CustomEvent('gonavi:create-query-tab'))}>
            {t('query.new')}
          </Button>
          <Tooltip title={t('tab_manager.empty.quick.search.description')}>
            <Button icon={<SearchOutlined />} onClick={handleFocusObjectSearch}>
              {t('tab_manager.empty.quick.search.title')}
            </Button>
          </Tooltip>
          <Button icon={<RobotOutlined />} onClick={handleOpenAI}>
            {t('tab_manager.empty.action.open_ai')}
          </Button>
        </div>
      </section>
      <section className="gn-v2-empty-recent" aria-label={t('tab_manager.empty.recent.aria')}>
        <section className="gn-v2-empty-recent-card">
          <div className="gn-v2-empty-recent-heading">
            <span><HistoryOutlined />{t('tab_manager.empty.recent.connection.heading')}</span>
            <em>{recentConnectionShortcuts.length}</em>
          </div>
          {recentConnectionShortcuts.length > 0 ? (
            <div className="gn-v2-empty-recent-list">
              {recentConnectionShortcuts.map((shortcut) => (
                <button
                  key={`${shortcut.connection.id}::${shortcut.dbName || ''}`}
                  type="button"
                  className="gn-v2-empty-recent-item"
                  onClick={() => handleOpenRecentConnection(shortcut)}
                >
                  <DatabaseOutlined />
                  <span>
                    <strong title={shortcut.connection.name}>{shortcut.connection.name}</strong>
                    <small>{shortcut.dbName || t('tab_manager.empty.recent.connection.default_database')}</small>
                  </span>
                  <RightOutlined className="gn-v2-empty-recent-arrow" />
                </button>
              ))}
            </div>
          ) : (
            <p className="gn-v2-empty-recent-empty">{t('tab_manager.empty.recent.connection.empty')}</p>
          )}
        </section>
        <section className="gn-v2-empty-recent-card">
          <div className="gn-v2-empty-recent-heading">
            <span><FileTextOutlined />{t('tab_manager.empty.recent.saved_query.heading')}</span>
            <em>{recentSavedQueries.length}</em>
          </div>
          {recentSavedQueries.length > 0 ? (
            <div className="gn-v2-empty-recent-list">
              {recentSavedQueries.map((query) => {
                const connection = connectionById.get(query.connectionId);
                return (
                  <button
                    key={query.id}
                    type="button"
                    className="gn-v2-empty-recent-item"
                    onClick={() => handleOpenSavedQuery(query)}
                  >
                    <FileTextOutlined />
                    <span>
                      <strong title={query.name || t('sidebar.tree.untitled_query')}>
                        {query.name || t('sidebar.tree.untitled_query')}
                      </strong>
                      <small>{`${connection?.name || query.connectionId} · ${query.dbName || t('tab_manager.empty.recent.connection.default_database')}`}</small>
                    </span>
                    <RightOutlined className="gn-v2-empty-recent-arrow" />
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="gn-v2-empty-recent-empty">{t('tab_manager.empty.recent.saved_query.empty')}</p>
          )}
        </section>
        <section className="gn-v2-empty-recent-card">
          <div className="gn-v2-empty-recent-heading">
            <span><ConsoleSqlOutlined />{t('tab_manager.empty.recent.sql_file.heading')}</span>
            <em>{recentSQLFileShortcuts.length}</em>
          </div>
          {recentSQLFileShortcuts.length > 0 ? (
            <div className="gn-v2-empty-recent-list">
              {recentSQLFileShortcuts.map((file) => {
                const connection = connectionById.get(file.connectionId);
                const openKey = `${file.connectionId}::${file.dbName || ''}::${file.filePath}`;
                return (
                  <button
                    key={openKey}
                    type="button"
                    className="gn-v2-empty-recent-item"
                    disabled={openingRecentSQLFileKey === openKey}
                    onClick={() => void handleOpenRecentSQLFile(file)}
                  >
                    <FileTextOutlined />
                    <span>
                      <strong title={file.fileName}>{file.fileName}</strong>
                      <small>{`${connection?.name || file.connectionId} · ${file.dbName || t('tab_manager.empty.recent.connection.default_database')}`}</small>
                    </span>
                    <RightOutlined className="gn-v2-empty-recent-arrow" />
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="gn-v2-empty-recent-empty">{t('tab_manager.empty.recent.sql_file.empty')}</p>
          )}
        </section>
      </section>
      <section className="gn-v2-empty-resources" aria-label={t('tab_manager.empty.recent.aria')}>
        <section className="gn-v2-empty-resource-card">
          <div className="gn-v2-empty-recent-heading">
            <span><PushpinOutlined />{t('sidebar.action.pin_table')}</span>
            <em>{pinnedTableShortcuts.length}</em>
          </div>
          {pinnedTableShortcuts.length > 0 ? (
            <div className="gn-v2-empty-recent-list">
              {pinnedTableShortcuts.map((shortcut) => {
                const displayName = shortcut.schemaName
                  ? `${shortcut.schemaName}.${shortcut.tableName}`
                  : shortcut.tableName;
                return (
                  <button
                    key={`${shortcut.connection.id}::${shortcut.dbName}::${shortcut.schemaName || ''}::${shortcut.tableName}`}
                    type="button"
                    className="gn-v2-empty-recent-item"
                    onClick={() => handleOpenPinnedTable(shortcut)}
                  >
                    <DatabaseOutlined />
                    <span>
                      <strong title={displayName}>{displayName}</strong>
                      <small>{`${shortcut.connection.name} · ${shortcut.dbName}`}</small>
                    </span>
                    <RightOutlined className="gn-v2-empty-recent-arrow" />
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="gn-v2-empty-resource-empty">
              <PushpinOutlined />
              <p>{t('tab_manager.empty.resource.pinned_tables.empty')}</p>
              <Button type="link" onClick={handleFocusObjectSearch}>{t('sidebar.command_search.label')}</Button>
            </div>
          )}
        </section>
        <section className="gn-v2-empty-resource-card">
          <div className="gn-v2-empty-recent-heading">
            <span><FolderOpenOutlined />{t('sidebar.external_sql.root')}</span>
            <em>{linkedExternalSQLDirectoryShortcuts.length}</em>
          </div>
          {linkedExternalSQLDirectoryShortcuts.length > 0 ? (
            <div className="gn-v2-empty-recent-list">
              {linkedExternalSQLDirectoryShortcuts.map((shortcut) => (
                <button
                  key={shortcut.directory.id}
                  type="button"
                  className="gn-v2-empty-recent-item"
                  onClick={() => handleOpenRecentConnection(shortcut)}
                >
                  <FolderOpenOutlined />
                  <span>
                    <strong title={shortcut.directory.name}>{shortcut.directory.name}</strong>
                    <small>{`${shortcut.connection.name} · ${shortcut.dbName || t('tab_manager.empty.recent.connection.default_database')}`}</small>
                  </span>
                  <RightOutlined className="gn-v2-empty-recent-arrow" />
                </button>
              ))}
            </div>
          ) : (
            <div className="gn-v2-empty-resource-empty">
              <FolderOpenOutlined />
              <p>{t('tab_manager.empty.resource.sql_directory.empty')}</p>
              <Button type="link" onClick={handleAddExternalSQLDirectory}>{t('sidebar.menu.add_sql_directory')}</Button>
            </div>
          )}
        </section>
      </section>
    </div>
  );

  return (
    <div
      ref={tabWorkbenchRef}
      className={`${TAB_WORKBENCH_CLASS_NAME}${isV2Ui ? ' gn-v2-tab-workbench' : ''}`}
      style={tabWorkbenchStyle}
    >
        <style>{`
            .${TAB_WORKBENCH_CLASS_NAME} {
              height: 100%;
              flex: 1 1 auto;
              min-height: 0;
              min-width: 0;
              display: flex;
              flex-direction: column;
              overflow: hidden;
            }
            .main-tabs {
              height: 100%;
              flex: 1 1 auto;
              min-height: 0;
              min-width: 0;
              display: flex;
              flex-direction: column;
              overflow: hidden;
            }
            .main-tabs .ant-tabs-nav {
              flex: 0 0 auto;
              margin: 0;
            }
            .main-tabs .ant-tabs-content-holder {
              flex: 1 1 auto;
              min-height: 0;
              min-width: 0;
              overflow: hidden;
              display: flex;
              flex-direction: column;
            }
            .main-tabs .ant-tabs-content {
              flex: 1 1 auto;
              min-height: 0;
              min-width: 0;
              display: flex;
              flex-direction: column;
            }
            .main-tabs .ant-tabs-tabpane {
              flex: 1 1 auto;
              min-height: 0;
              min-width: 0;
              display: flex;
              flex-direction: column;
              overflow: hidden;
            }
            .main-tabs .ant-tabs-tabpane > div {
              flex: 1 1 auto;
              min-height: 0;
              min-width: 0;
            }
            .main-tabs .ant-tabs-tabpane-hidden {
              display: none !important;
            }
            .main-tabs .ant-tabs-nav::before {
                border-bottom: 1px solid ${tabsNavBorderColor} !important;
            }
            .main-tabs .ant-tabs-tab {
              transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1), background-color 120ms ease;
            }
            .main-tabs .tab-dnd-label {
              position: relative;
              user-select: none;
              -webkit-user-select: none;
              display: inline-flex;
              align-items: center;
              gap: 7px;
              max-width: 100%;
            }
            .main-tabs .gn-tab-environment-accent {
              position: absolute;
              z-index: 1;
              right: 8px;
              bottom: 0;
              left: 8px;
              height: 4px;
              box-sizing: border-box;
              border-radius: 4px 4px 0 0;
              background: var(--gn-tab-environment-color);
              pointer-events: none;
              transition: opacity 140ms ease;
            }
            .main-tabs .ant-tabs-tab:not(:hover):not(.ant-tabs-tab-active) .gn-tab-environment-accent {
              opacity: 0.86;
            }
            .main-tabs .tab-title-text {
              min-width: 0;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }
            .main-tabs .tab-dnd-node.is-dragging,
            .main-tabs .tab-dnd-node.is-dragging .tab-dnd-label {
              cursor: grabbing !important;
            }
            body[data-theme='dark'] .main-tabs .ant-tabs-tab-btn:focus-visible {
              outline: none !important;
              border-radius: 6px;
              box-shadow: 0 0 0 2px rgba(255, 214, 102, 0.72);
              background: rgba(255, 214, 102, 0.16);
            }
            body[data-theme='light'] .main-tabs .ant-tabs-tab-btn:focus-visible {
              outline: none !important;
              border-radius: 6px;
              box-shadow: 0 0 0 2px rgba(9, 109, 217, 0.32);
              background: rgba(9, 109, 217, 0.08);
            }
            body[data-theme='light'] .main-tabs .ant-tabs-tab.ant-tabs-tab-active {
              background: rgba(24, 144, 255, 0.10) !important;
              border-color: rgba(24, 144, 255, 0.28) !important;
            }
body[data-theme='dark'] .main-tabs .ant-tabs-tab.ant-tabs-tab-active {
              background: rgba(255, 214, 102, 0.12) !important;
              border-color: rgba(255, 214, 102, 0.4) !important;
            }
            body[data-ui-version='v2'] .main-tabs .ant-tabs-tab.ant-tabs-tab-active {
              background: var(--gn-bg-panel) !important;
              border-color: var(--gn-br-2) !important;
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-tooltip .ant-tooltip-inner {
              min-width: 260px;
              padding: 0;
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-tooltip {
              pointer-events: auto;
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-card {
              --gn-v2-tab-hover-grid-columns: 56px minmax(0, 1fr);
              display: flex;
              flex-direction: column;
              gap: 8px;
              padding: 10px;
              color: var(--gn-fg-2);
              cursor: text;
              user-select: text;
              -webkit-user-select: text;
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-card * {
              user-select: text;
              -webkit-user-select: text;
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-head {
              display: grid;
              grid-template-columns: var(--gn-v2-tab-hover-grid-columns);
              align-items: start;
              gap: 8px;
              min-width: 0;
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-head > span {
              justify-self: start;
              padding: 2px 6px;
              border-radius: 5px;
              background: var(--gn-bg-active);
              color: var(--gn-accent-2);
              font-family: var(--gn-font-mono);
              font-size: 10px;
              font-weight: 700;
              line-height: 14px;
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-head > strong {
              min-width: 0;
              overflow-wrap: anywhere;
              color: var(--gn-fg-1);
              font-size: var(--gn-font-size-sm, 12px);
              font-weight: 700;
              line-height: 18px;
              white-space: normal;
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-rows {
              display: grid;
              gap: 5px;
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-row {
              display: grid;
              grid-template-columns: var(--gn-v2-tab-hover-grid-columns);
              align-items: start;
              gap: 8px;
              font-size: var(--gn-font-size-sm, 12px);
              line-height: 18px;
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-row > span {
              color: var(--gn-fg-5);
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-row > strong {
              min-width: 0;
              overflow-wrap: anywhere;
              color: var(--gn-fg-2);
              font-weight: 600;
            }
            html.gn-workbench-tab-detaching,
            html.gn-workbench-tab-detaching body,
            html.gn-workbench-tab-detaching * {
              user-select: none !important;
              -webkit-user-select: none !important;
            }
        `}</style>
        {isV2Ui && !hasTabs ? (
          EmptyWorkbench
        ) : !hasDockedTabs ? (
          // All tabs are floating: keep empty docked area; floating host still shows content.
          <div className="gn-detached-only-workbench" style={{ flex: 1, minHeight: 0 }} />
        ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragMove={handleDragMove}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
            <Tabs
                className={`main-tabs${isV2Ui ? ' gn-v2-main-tabs' : ''}${hasDoubleLineTabLabel ? ' gn-v2-main-tabs-double' : ''}`}
                type="editable-card"
                destroyOnHidden={false}
                onChange={(newActiveKey) => {
                  if (Date.now() < suppressClickUntilRef.current) return;
                  onChange(newActiveKey);
                }}
                activeKey={dockedActiveTabId || undefined}
                onEdit={onEdit}
                items={items}
                hideAdd
                renderTabBar={renderTabBar}
            />
          </SortableContext>
        </DndContext>
        )}
        <DetachDragPreview
          preview={detachDragPreview}
          darkMode={theme === 'dark'}
          readyHint={t('tab_manager.menu.open_in_window')}
        />
    </div>
  );
});

export default TabManager;
