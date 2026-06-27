import React from 'react';
import { StarFilled, StarOutlined } from '@ant-design/icons';
import { t } from '../../i18n';
import { SIDEBAR_SQL_EDITOR_DRAG_MIME, encodeSidebarSqlEditorDragPayload } from '../../utils/sidebarSqlDrag';
import { sanitizeRedisDbAlias } from '../../utils/redisDbAlias';
import { resolveSidebarObjectDragText } from '../sidebarCoreUtils';
import { resolveV2ObjectGroupTitle } from './sidebarHelpers';

export const composeSidebarTableHoverTitle = (
  name: string,
  comment?: string | null,
): string => {
  const baseName = String(name ?? '');
  const trimmedComment = String(comment ?? '').trim();
  if (!trimmedComment) {
    return baseName;
  }
  return t('sidebar.tree.table_comment_tooltip', {
    name: baseName,
    comment: trimmedComment,
  });
};

type SidebarV2TreeTitleOptions = {
  node: any;
  hoverTitle: string;
  statusBadge: React.ReactNode;
  getV2TreeMetaText: (node: any) => string;
  toggleSidebarTablePinned: (node: any) => void;
  snapshotTreeSelectionBeforeDrag: () => void;
  restoreTreeSelectionAfterDrag: () => void;
  treeDragSelectSuppressUntilRef: React.MutableRefObject<number>;
  setIsTreeDragging: (dragging: boolean) => void;
};

export const renderSidebarV2TreeTitle = ({
  node,
  hoverTitle,
  statusBadge,
  getV2TreeMetaText,
  toggleSidebarTablePinned,
  snapshotTreeSelectionBeforeDrag,
  restoreTreeSelectionAfterDrag,
  treeDragSelectSuppressUntilRef,
  setIsTreeDragging,
}: SidebarV2TreeTitleOptions): React.ReactNode => {
  const rawTitle = String(node.title ?? '');
  const groupKey = String(node?.dataRef?.groupKey || '');
  const dragText = resolveSidebarObjectDragText(node);
  if (node.type === 'v2-table-section') {
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
    if (node.type === 'queries-folder') return t('sidebar.tree.saved_queries');
    if (node.type === 'external-sql-root') return t('sidebar.external_sql.root');
    if (node.type === 'object-group') {
      const objectGroupTitle = resolveV2ObjectGroupTitle(node);
      if (objectGroupTitle) return objectGroupTitle;
    }
    return rawTitle;
  })();
  const metaText = getV2TreeMetaText(node);
  const redisDbAlias = node.type === 'redis-db'
    ? sanitizeRedisDbAlias(node?.dataRef?.redisDbAlias)
    : '';
  const redisDbIndex = Number(node?.dataRef?.redisDB);
  const redisDbBaseTitle = Number.isFinite(redisDbIndex) ? `db${redisDbIndex}` : displayTitle;
  const isMono = node.type === 'table'
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
    node.type === 'object-group' ? 'is-group' : '',
    node.type === 'redis-db' ? 'is-redis-db' : '',
    node.type === 'table' && node?.dataRef?.pinnedSidebarTable ? 'is-pinned-table' : '',
  ].filter(Boolean).join(' ');
  const tablePinAction = node.type === 'table' ? (
    <button
      type="button"
      className={[
        'gn-v2-table-pin-action',
        node?.dataRef?.pinnedSidebarTable ? 'is-pinned' : '',
      ].filter(Boolean).join(' ')}
      title={node?.dataRef?.pinnedSidebarTable ? t('sidebar.action.unpin_table') : t('sidebar.action.pin_table')}
      aria-label={node?.dataRef?.pinnedSidebarTable ? t('sidebar.action.unpin_table') : t('sidebar.action.pin_table')}
      aria-pressed={node?.dataRef?.pinnedSidebarTable ? true : false}
      data-v2-sidebar-table-pin-action="true"
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleSidebarTablePinned(node);
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {node?.dataRef?.pinnedSidebarTable ? <StarFilled /> : <StarOutlined />}
    </button>
  ) : null;
  if (node.type === 'connection') {
    return (
      <span
        className={`${titleClassName} is-connection`}
        title={hoverTitle}
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
  return (
    <>
      <span
        className={titleClassName}
        title={hoverTitle}
        draggable={!!dragText}
        data-node-type={node.type}
        data-group-key={groupKey || undefined}
        data-sidebar-node-key={String(node.key || '')}
        data-sidebar-node-type={String(node.type || '')}
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
        {metaText && <span className="gn-v2-tree-count">{metaText}</span>}
      </span>
      {tablePinAction}
    </>
  );
};
