import React from 'react';
import { Tooltip } from 'antd';
import { StarFilled } from '@ant-design/icons';
import { t } from '../../i18n';
import {
  type SidebarTableMetadataField,
} from '../../utils/sidebarTableMetadata';
import { sanitizeRedisDbAlias } from '../../utils/redisDbAlias';
import { resolveConnectionHostSummary } from '../../utils/tabDisplay';
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
import NacosGroupHealthBadge from './NacosGroupHealthBadge';

/** Connection / database state, expressed by the row icon via CSS (no status dot). */
export type SidebarTreeConnectionStatus = 'loading' | 'success' | 'error' | 'default';

type SidebarV2TreeTitleOptions = {
  node: any;
  hoverTitle: string;
  connectionStatus?: SidebarTreeConnectionStatus;
  getV2TreeMetaText: (node: any) => string;
  sidebarTableMetadataFields: SidebarTableMetadataField[];
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

type SidebarTableHoverInfoProps = {
  node: any;
  displayTitle: string;
};

/**
 * Keep the table hover card out of the tree-row render path.  rc-tree asks
 * titleRender for every row that enters the virtual window while scrolling;
 * constructing the complete eleven-row card there made a fast scroll spend
 * most of its frame budget creating DOM trees that stay hidden in Tooltip.
 * The card is now a memoized child and is only reconciled when its row data
 * changes (or when the tooltip actually mounts it).
 */
const SidebarTableHoverInfo = React.memo(({
  node,
  displayTitle,
}: SidebarTableHoverInfoProps) => {
  const metadata = React.useMemo(
    () => buildSidebarTableMetadataSnapshot(node?.dataRef),
    [node],
  );
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
});

SidebarTableHoverInfo.displayName = 'SidebarTableHoverInfo';

type SidebarTableHoverTooltipProps = SidebarTableHoverInfoProps & {
  children: React.ReactElement;
};

const SidebarTableHoverTooltip = ({
  node,
  displayTitle,
  children,
}: SidebarTableHoverTooltipProps): React.ReactElement => {
  const renderHoverInfo = React.useCallback(
    () => <SidebarTableHoverInfo node={node} displayTitle={displayTitle} />,
    [displayTitle, node],
  );
  return (
    <Tooltip
      title={renderHoverInfo}
      placement="right"
      mouseEnterDelay={1.2}
      destroyOnHidden
      rootClassName="gn-v2-tab-hover-tooltip gn-v2-sidebar-table-hover-tooltip"
    >
      {children}
    </Tooltip>
  );
};

export const renderSidebarV2TreeTitle = ({
  node,
  hoverTitle,
  connectionStatus,
  getV2TreeMetaText,
  sidebarTableMetadataFields,
  sidebarDropPlacement,
}: SidebarV2TreeTitleOptions): React.ReactNode => {
  const rawTitle = String(node.title ?? '');
  const groupKey = String(node?.dataRef?.groupKey || '');
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
  const tableMetadata = node.type === 'table' && sidebarTableMetadataFields.length > 0
    ? buildSidebarTableMetadataSnapshot(node?.dataRef)
    : null;
  const tableMetadataItems = tableMetadata
    ? buildSidebarTableMetadataDisplayItems(sidebarTableMetadataFields, tableMetadata)
    : [];
  const effectiveHoverTitle = hoverTitle;
  const hasTableHoverInfo = node.type === 'table';
  const metaText = node.type === 'table' ? '' : getV2TreeMetaText(node);
  // Nacos service groups carry their own trailing metadata: how many services live
  // in the group and how much of it is actually healthy. Both come from the service
  // list scan the sidebar already performs, so neither costs an extra request.
  const nacosServiceCount = node.type === 'nacos-service-group'
    ? Number(node?.dataRef?.nacosServiceCount)
    : NaN;
  const hasNacosServiceCount = Number.isFinite(nacosServiceCount) && nacosServiceCount > 0;
  const nacosHealthEntry = node.type === 'nacos-service-group'
    ? node?.dataRef?.nacosGroupHealth
    : null;
  // The "all" row (nacosGroup === '') spans every group in the namespace. It shows
  // the service total only: a health aggregate there would have to sum the whole
  // namespace, and rendering "unknown" for it would be pure noise.
  const isNacosAggregateRow = node.type === 'nacos-service-group'
    && !String(node?.dataRef?.nacosGroup || '').trim();
  const nacosHealthAvailable = node.type === 'nacos-service-group'
    && !isNacosAggregateRow
    && Boolean(node?.dataRef?.nacosHealthAvailable);
  const nacosServiceCountTitle = hasNacosServiceCount
    ? t('nacos_service.group.tooltip.services', { count: nacosServiceCount })
    : '';
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
    || node.type === 'database-link'
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
    : (node.type === 'database' || node.type === 'nacos-namespace' || node.type === 'nacos-config-group') && node?.dataRef?.pinnedSidebarDatabase
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
  const connectionStatusAttr = node.type === 'connection' || node.type === 'database'
    ? (connectionStatus ?? 'default')
    : undefined;
  // Right-pinned status dot (CSS positions it); hidden while idle.
  const statusDot = connectionStatusAttr && connectionStatusAttr !== 'default'
    ? <span className={`gn-v2-tree-status is-${connectionStatusAttr}`} aria-hidden="true" />
    : null;
  if (node.type === 'connection') {
    return (
      <span
        className={`${titleClassName} is-connection`}
        title={effectiveHoverTitle}
        data-node-type={node.type}
        data-sidebar-node-key={String(node.key || '')}
        data-sidebar-node-type={String(node.type || '')}
        data-sidebar-connection-status={connectionStatusAttr}
      >
        <span className="gn-v2-tree-connection-copy">
          <span className="gn-v2-tree-label">{displayTitle}</span>
        </span>
        {statusDot}
      </span>
    );
  }
  const titleNode = (
    <span
      ref={hasTableHoverInfo ? clearSidebarTableNativeHoverTitleRef : undefined}
      className={titleClassName}
      title={hasTableHoverInfo ? undefined : effectiveHoverTitle}
      data-node-type={node.type}
      data-group-key={groupKey || undefined}
      data-sidebar-node-key={String(node.key || '')}
      data-sidebar-node-type={String(node.type || '')}
      data-sidebar-drop-placement={sidebarDropPlacement || undefined}
      data-sidebar-connection-status={connectionStatusAttr}
      onPointerOverCapture={hasTableHoverInfo ? clearSidebarTableNativeHoverTitle : undefined}
      onMouseOverCapture={hasTableHoverInfo ? clearSidebarTableNativeHoverTitle : undefined}
    >
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
      {hasNacosServiceCount && (
        <span className="gn-v2-tree-nacos-count" title={nacosServiceCountTitle}>
          {nacosServiceCount}
        </span>
      )}
      {nacosHealthEntry || nacosHealthAvailable ? (
        <NacosGroupHealthBadge
          entry={nacosHealthEntry}
          statisticsAvailable={nacosHealthAvailable}
        />
      ) : null}
      {metaText && <span className="gn-v2-tree-count">{metaText}</span>}
      {statusDot}
    </span>
  );

  const wrappedTitleNode = hasTableHoverInfo ? (
    <SidebarTableHoverTooltip node={node} displayTitle={displayTitle}>
      {titleNode}
    </SidebarTableHoverTooltip>
  ) : titleNode;

  return (
    <>
      {wrappedTitleNode}
      {pinIndicator}
    </>
  );
};
