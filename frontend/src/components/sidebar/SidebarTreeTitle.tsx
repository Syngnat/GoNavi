import React from 'react';
import { Tooltip } from 'antd';
import { StarFilled } from '@ant-design/icons';
import { t } from '../../i18n';
import { SIDEBAR_SQL_EDITOR_DRAG_MIME, encodeSidebarSqlEditorDragPayload } from '../../utils/sidebarSqlDrag';
import {
  type SidebarTableMetadataField,
  type SidebarTableMetadataSnapshot,
} from '../../utils/sidebarTableMetadata';
import { sanitizeRedisDbAlias } from '../../utils/redisDbAlias';
import { resolveConnectionHostSummary } from '../../utils/tabDisplay';
import { resolveSidebarObjectDragText } from '../sidebarCoreUtils';
import {
  buildSidebarTableMetadataDisplayItems,
  buildSidebarTableMetadataSnapshot,
  formatSidebarRowCount,
  formatSidebarTableSize,
  formatSidebarTableTimestamp,
  resolveSidebarQueriesFolderTitle,
  resolveV2ObjectGroupTitle,
} from './sidebarHelpers';
import { normalizeOracleObjectCompileStatus } from './oracleObjectCompilation';

type SidebarV2TreeTitleOptions = {
  node: any;
  hoverTitle: string;
  statusBadge: React.ReactNode;
  getV2TreeMetaText: (node: any) => string;
  sidebarTableMetadataFields: SidebarTableMetadataField[];
  snapshotTreeSelectionBeforeDrag: () => void;
  restoreTreeSelectionAfterDrag: () => void;
  treeDragSelectSuppressUntilRef: React.MutableRefObject<number>;
  setIsTreeDragging: (dragging: boolean) => void;
  sidebarDropPlacement?: 'before' | 'inside' | 'after' | null;
};

const SIDEBAR_TREE_NODE_CONTENT_SELECTOR = '.ant-tree-node-content-wrapper';

const stopSidebarTableHoverPropagation = (event: React.SyntheticEvent<HTMLElement>) => {
  event.stopPropagation();
};

const clearSidebarTableNativeHoverTitleElement = (element: HTMLElement | null) => {
  element?.closest(SIDEBAR_TREE_NODE_CONTENT_SELECTOR)?.removeAttribute('title');
};

const clearSidebarTableNativeHoverTitleRef: React.RefCallback<HTMLSpanElement> = (element) => {
  clearSidebarTableNativeHoverTitleElement(element);
};

const clearSidebarTableNativeHoverTitle = (event: React.SyntheticEvent<HTMLElement>) => {
  clearSidebarTableNativeHoverTitleElement(event.currentTarget);
};

const renderSidebarTableHoverInfo = (
  node: any,
  displayTitle: string,
  metadata: SidebarTableMetadataSnapshot,
): React.ReactNode => {
  const dataRef = node?.dataRef || {};
  const tableName = String(dataRef.tableName || displayTitle || node?.title || '').trim();
  const schemaName = String(dataRef.schemaName || '').trim();
  const dbName = String(dataRef.dbName || dataRef?.config?.database || '').trim();
  const connectionLabel = String(dataRef.name || '').trim();
  const hostSummary = resolveConnectionHostSummary(dataRef.config);
  const rows = [
    [t('tab_manager.hover.label.type'), t('tab_manager.hover.kind.table')],
    [t('tab_manager.hover.label.connection'), connectionLabel || t('tab_manager.hover.fallback.unbound_connection')],
    ['Host', hostSummary || t('tab_manager.hover.fallback.host_not_configured')],
    [t('tab_manager.hover.label.database'), dbName || t('tab_manager.hover.fallback.database_not_specified')],
    ['Schema', schemaName],
    [t('tab_manager.hover.label.object'), tableName],
    [t('table_designer.action.table_comment'), metadata.tableComment || ''],
    [t('sidebar.v2_table_group_menu.display_table_rows'), metadata.rowCount !== undefined ? formatSidebarRowCount(metadata.rowCount) : ''],
    [t('sidebar.v2_table_group_menu.display_table_size'), metadata.tableSize !== undefined ? formatSidebarTableSize(metadata.tableSize) : ''],
    [t('sidebar.v2_table_group_menu.display_create_time'), metadata.createdAt ? formatSidebarTableTimestamp(metadata.createdAt) : ''],
    [t('sidebar.v2_table_group_menu.display_update_time'), metadata.updatedAt ? formatSidebarTableTimestamp(metadata.updatedAt) : ''],
  ].filter(([, value]) => Boolean(value));

  return (
    <div
      className="gn-v2-tab-hover-card"
      data-tab-hover-info="true"
      data-sidebar-table-hover-info="true"
      onPointerDown={stopSidebarTableHoverPropagation}
      onPointerMove={stopSidebarTableHoverPropagation}
      onPointerUp={stopSidebarTableHoverPropagation}
      onPointerDownCapture={stopSidebarTableHoverPropagation}
      onPointerUpCapture={stopSidebarTableHoverPropagation}
      onMouseDown={stopSidebarTableHoverPropagation}
      onMouseMove={stopSidebarTableHoverPropagation}
      onMouseUp={stopSidebarTableHoverPropagation}
      onClick={stopSidebarTableHoverPropagation}
      onClickCapture={stopSidebarTableHoverPropagation}
      onTouchStart={stopSidebarTableHoverPropagation}
      onTouchMove={stopSidebarTableHoverPropagation}
      onTouchEnd={stopSidebarTableHoverPropagation}
    >
      <div className="gn-v2-tab-hover-head">
        <span>{t('tab_manager.kind_badge.table')}</span>
        <strong>{tableName || displayTitle}</strong>
      </div>
      <div className="gn-v2-tab-hover-rows">
        {rows.map(([label, value], index) => (
          <div className="gn-v2-tab-hover-row" key={`${String(label)}-${index}`}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
};

export const renderSidebarV2TreeTitle = ({
  node,
  hoverTitle,
  statusBadge,
  getV2TreeMetaText,
  sidebarTableMetadataFields,
  snapshotTreeSelectionBeforeDrag,
  restoreTreeSelectionAfterDrag,
  treeDragSelectSuppressUntilRef,
  setIsTreeDragging,
  sidebarDropPlacement,
}: SidebarV2TreeTitleOptions): React.ReactNode => {
  const rawTitle = String(node.title ?? '');
  const groupKey = String(node?.dataRef?.groupKey || '');
  const dragText = resolveSidebarObjectDragText(node);
  if (node.type === 'v2-table-section' || node.type === 'v2-database-section') {
    return (
      <span
        className="gn-v2-tree-section-title"
        data-section-kind={node?.dataRef?.sectionKind || undefined}
        title={rawTitle}
      >
        {rawTitle}
      </span>
    );
  }
  const displayTitle = (() => {
    const queriesFolderTitle = resolveSidebarQueriesFolderTitle(node);
    if (queriesFolderTitle) return queriesFolderTitle;
    if (node.type === 'external-sql-root') return t('sidebar.external_sql.root');
    if (node.type === 'object-group') {
      const objectGroupTitle = resolveV2ObjectGroupTitle(node);
      if (objectGroupTitle) return objectGroupTitle;
    }
    return rawTitle;
  })();
  const objectCompileStatus = (node.type === 'routine' || node.type === 'db-trigger')
    ? normalizeOracleObjectCompileStatus(node?.dataRef?.objectStatus)
    : '';
  const objectCompileStatusLabel = objectCompileStatus
    ? t(`sidebar.object_status.${objectCompileStatus.toLowerCase()}`)
    : '';
  const objectCompileStatusBadge = objectCompileStatus ? (
    <span
      className={`gn-v2-tree-object-status is-${objectCompileStatus.toLowerCase()}`}
      data-sidebar-object-status={objectCompileStatus}
      title={t('sidebar.object_status.tooltip', { status: objectCompileStatusLabel })}
    >
      {objectCompileStatusLabel}
    </span>
  ) : null;
  const tableMetadata = node.type === 'table'
    ? buildSidebarTableMetadataSnapshot(node?.dataRef)
    : null;
  const tableMetadataItems = tableMetadata
    ? buildSidebarTableMetadataDisplayItems(sidebarTableMetadataFields, tableMetadata)
    : [];
  const effectiveHoverTitle = hoverTitle;
  const tableHoverInfo = node.type === 'table'
    ? renderSidebarTableHoverInfo(node, displayTitle, tableMetadata ?? {})
    : null;
  const metaText = node.type === 'table' ? '' : getV2TreeMetaText(node);
  const redisDbAlias = node.type === 'redis-db'
    ? sanitizeRedisDbAlias(node?.dataRef?.redisDbAlias)
    : '';
  const redisDbIndex = Number(node?.dataRef?.redisDB);
  const redisDbBaseTitle = Number.isFinite(redisDbIndex) ? `db${redisDbIndex}` : displayTitle;
  const isMono = node.type === 'message-object'
    || node.type === 'table'
    || node.type === 'view'
    || node.type === 'materialized-view'
    || node.type === 'sequence'
    || node.type === 'db-trigger'
    || node.type === 'db-event'
    || node.type === 'routine'
    || node.type === 'package'
    || node.type === 'saved-query'
    || node.type === 'external-sql-file';
  const titleClassName = [
    'gn-v2-tree-title',
    isMono ? 'is-mono' : '',
    node.type === 'object-group' || node.type === 'message-object-group' ? 'is-group' : '',
    node.type === 'tag' ? 'is-connection-group' : '',
    sidebarDropPlacement ? `is-drop-${sidebarDropPlacement}` : '',
    node.type === 'redis-db' ? 'is-redis-db' : '',
    node.type === 'table' && node?.dataRef?.pinnedSidebarTable ? 'is-pinned-table' : '',
  ].filter(Boolean).join(' ');
  const pinnedNodeType = node.type === 'table' && node?.dataRef?.pinnedSidebarTable
    ? 'table'
    : node.type === 'database' && node?.dataRef?.pinnedSidebarDatabase
      ? 'database'
      : null;
  const pinIndicator = pinnedNodeType ? (
    <span
      className={`gn-v2-table-pin-indicator${pinnedNodeType === 'database' ? ' gn-v2-database-pin-indicator' : ''}`}
      title={t('sidebar.status.pinned')}
      role="img"
      aria-label={t('sidebar.status.pinned')}
      data-v2-sidebar-table-pin-indicator={pinnedNodeType === 'table' ? 'true' : undefined}
      data-v2-sidebar-database-pin-indicator={pinnedNodeType === 'database' ? 'true' : undefined}
    >
      <StarFilled aria-hidden="true" />
    </span>
  ) : null;
  if (node.type === 'connection') {
    return (
      <span
        className={`${titleClassName} is-connection`}
        title={effectiveHoverTitle}
        data-node-type={node.type}
        data-sidebar-node-key={String(node.key || '')}
        data-sidebar-node-type={String(node.type || '')}
      >
        {statusBadge}
        <span className="gn-v2-tree-connection-copy">
          <span className="gn-v2-tree-label">{displayTitle}</span>
        </span>
      </span>
    );
  }
  const titleNode = (
    <span
      ref={tableHoverInfo ? clearSidebarTableNativeHoverTitleRef : undefined}
      className={titleClassName}
      title={tableHoverInfo ? undefined : effectiveHoverTitle}
      draggable={!!dragText}
      data-node-type={node.type}
      data-group-key={groupKey || undefined}
      data-sidebar-node-key={String(node.key || '')}
      data-sidebar-node-type={String(node.type || '')}
      data-sidebar-drop-placement={sidebarDropPlacement || undefined}
      onPointerOverCapture={tableHoverInfo ? clearSidebarTableNativeHoverTitle : undefined}
      onMouseOverCapture={tableHoverInfo ? clearSidebarTableNativeHoverTitle : undefined}
      onDragStart={dragText ? (event) => {
        snapshotTreeSelectionBeforeDrag();
        treeDragSelectSuppressUntilRef.current = Date.now() + 600;
        setIsTreeDragging(true);
        event.stopPropagation();
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData('text/plain', dragText);
        event.dataTransfer.setData(
          SIDEBAR_SQL_EDITOR_DRAG_MIME,
          encodeSidebarSqlEditorDragPayload({
            text: dragText,
            nodeType: node.type,
            connectionId: String(node?.dataRef?.id || ''),
            dbName: String(node?.dataRef?.dbName || ''),
          }),
        );
      } : undefined}
      onDragEnd={dragText ? () => {
        restoreTreeSelectionAfterDrag();
        setIsTreeDragging(false);
      } : undefined}
    >
      {statusBadge}
      <span className="gn-v2-tree-label">
        {redisDbAlias ? (
          <>
            <span className="gn-v2-redis-db-name">{redisDbBaseTitle}</span>
            <span className="gn-v2-redis-db-alias">{redisDbAlias}</span>
          </>
        ) : displayTitle}
      </span>
      {tableMetadataItems.map((item) => (
        <span key={item.key} className={item.className}>{item.text}</span>
      ))}
      {objectCompileStatusBadge}
      {metaText && <span className="gn-v2-tree-count">{metaText}</span>}
    </span>
  );

  const wrappedTitleNode = tableHoverInfo ? (
    <Tooltip
      title={tableHoverInfo}
      placement="right"
      mouseEnterDelay={1.2}
      destroyOnHidden
      rootClassName="gn-v2-tab-hover-tooltip gn-v2-sidebar-table-hover-tooltip"
    >
      {titleNode}
    </Tooltip>
  ) : titleNode;

  return (
    <>
      {wrappedTitleNode}
      {pinIndicator}
    </>
  );
};
