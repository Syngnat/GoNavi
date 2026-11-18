import React from 'react';
import { StarFilled } from '@ant-design/icons';
import { t } from '../../i18n';
import {
  type SidebarTableMetadataField,
} from '../../utils/sidebarTableMetadata';
import { sanitizeRedisDbAlias } from '../../utils/redisDbAlias';
import {
  buildSidebarTableMetadataDisplayItems,
  buildSidebarTableMetadataSnapshot,
  resolveSidebarQueriesFolderTitle,
  resolveV2ObjectGroupTitle,
} from './sidebarHelpers';
import { normalizeOracleObjectCompileStatus } from './oracleObjectCompilation';
import NacosGroupHealthBadge from './NacosGroupHealthBadge';
import { MetadataHoverCard, MetadataHoverTooltip } from '../common/MetadataHoverCard';
import { buildSidebarEntityHoverModel } from './sidebarEntityHoverModel';

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

const clearSidebarMetadataNativeHoverTitleElement = (element: HTMLElement | null) => {
  element?.closest(SIDEBAR_TREE_NODE_CONTENT_SELECTOR)?.removeAttribute('title');
};

const clearSidebarMetadataNativeHoverTitleRef: React.RefCallback<HTMLSpanElement> = (element) => {
  clearSidebarMetadataNativeHoverTitleElement(element);
};

const clearSidebarMetadataNativeHoverTitle = (event: React.SyntheticEvent<HTMLElement>) => {
  clearSidebarMetadataNativeHoverTitleElement(event.currentTarget);
};

export const renderSidebarV2TreeTitle = ({
  node,
  hoverTitle,
  connectionStatus,
  getV2TreeMetaText,
  sidebarTableMetadataFields,
  sidebarDropPlacement,
}: SidebarV2TreeTitleOptions): React.ReactNode => {
  const renderMetadataHoverContent = (
    targetNode: any,
    targetTitle: string,
  ) => () => {
    const model = buildSidebarEntityHoverModel(targetNode, targetTitle, connectionStatus);
    return model ? (
      <MetadataHoverCard
        badge={model.badge}
        title={model.title}
        rows={model.rows}
        dataKind={model.dataKind}
      />
    ) : null;
  };
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
  const hasMetadataHoverInfo = node.type === 'table' || node.type === 'database' || node.type === 'connection';
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
    || node.type === 'db-job'
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
    const connectionTitleNode = (
      <span
        className={`${titleClassName} is-connection`}
        ref={clearSidebarMetadataNativeHoverTitleRef}
        title={undefined}
        data-node-type={node.type}
        data-sidebar-node-key={String(node.key || '')}
        data-sidebar-node-type={String(node.type || '')}
        data-sidebar-connection-status={connectionStatusAttr}
        onPointerOverCapture={clearSidebarMetadataNativeHoverTitle}
        onMouseOverCapture={clearSidebarMetadataNativeHoverTitle}
      >
        <span className="gn-v2-tree-connection-copy">
          <span className="gn-v2-tree-label">{displayTitle}</span>
        </span>
        {statusDot}
      </span>
    );
    return (
      <MetadataHoverTooltip
        content={renderMetadataHoverContent(node, displayTitle)}
        mouseEnterDelay={1.2}
        rootClassName="gn-v2-tab-hover-tooltip gn-v2-sidebar-table-hover-tooltip"
      >
        {connectionTitleNode}
      </MetadataHoverTooltip>
    );
  }
  const titleNode = (
    <span
      ref={hasMetadataHoverInfo ? clearSidebarMetadataNativeHoverTitleRef : undefined}
      className={titleClassName}
      title={hasMetadataHoverInfo ? undefined : effectiveHoverTitle}
      data-node-type={node.type}
      data-group-key={groupKey || undefined}
      data-sidebar-node-key={String(node.key || '')}
      data-sidebar-node-type={String(node.type || '')}
      data-sidebar-drop-placement={sidebarDropPlacement || undefined}
      data-sidebar-connection-status={connectionStatusAttr}
      onPointerOverCapture={hasMetadataHoverInfo ? clearSidebarMetadataNativeHoverTitle : undefined}
      onMouseOverCapture={hasMetadataHoverInfo ? clearSidebarMetadataNativeHoverTitle : undefined}
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

  const wrappedTitleNode = hasMetadataHoverInfo ? (
    <MetadataHoverTooltip
      content={renderMetadataHoverContent(node, displayTitle)}
      mouseEnterDelay={1.2}
      rootClassName="gn-v2-tab-hover-tooltip gn-v2-sidebar-table-hover-tooltip"
    >
      {titleNode}
    </MetadataHoverTooltip>
  ) : titleNode;

  return (
    <>
      {wrappedTitleNode}
      {pinIndicator}
    </>
  );
};
