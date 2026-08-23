import React, { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { Badge, Button } from 'antd';
import { PlusOutlined } from '@ant-design/icons';

import type { SavedConnection } from '../../types';
import { t } from '../../i18n';
import JVMModeBadge from '../jvm/JVMModeBadge';
import { SIDEBAR_SQL_EDITOR_DRAG_MIME, encodeSidebarSqlEditorDragPayload } from '../../utils/sidebarSqlDrag';
import {
  resolveSidebarObjectDragText,
} from '../sidebarCoreUtils';
import type { SidebarConnectionState } from '../sidebarV2Utils';
import {
  shouldHideSchemaPrefix,
  splitQualifiedName,
} from './sidebarMetadataLoaders';
import { resolveV2ObjectGroupTitle } from './sidebarHelpers';
import { normalizeOracleObjectCompileStatus } from './oracleObjectCompilation';

type UseSidebarTitleRenderArgs = {
  connectionStates: Record<string, SidebarConnectionState>;
  isV2Ui: boolean;
  renderV2TreeTitle: (node: any, hoverTitle: string, statusBadge: React.ReactNode) => React.ReactNode;
  handleAddExternalSQLDirectory: (node: any) => Promise<void>;
  snapshotTreeSelectionBeforeDrag: () => void;
  restoreTreeSelectionAfterDrag: () => void;
  treeDragSelectSuppressUntilRef: MutableRefObject<number>;
  setIsTreeDragging: Dispatch<SetStateAction<boolean>>;
};

export const useSidebarTitleRender = ({
  connectionStates,
  isV2Ui,
  renderV2TreeTitle,
  handleAddExternalSQLDirectory,
  snapshotTreeSelectionBeforeDrag,
  restoreTreeSelectionAfterDrag,
  treeDragSelectSuppressUntilRef,
  setIsTreeDragging,
}: UseSidebarTitleRenderArgs) => {
  const handleAddExternalSQLDirectoryRef = useRef(handleAddExternalSQLDirectory);
  handleAddExternalSQLDirectoryRef.current = handleAddExternalSQLDirectory;

  return useCallback((node: any) => {
  let status: 'loading' | 'success' | 'error' | 'default' = 'default';
  if (node.type === 'connection' || node.type === 'database') {
    if (connectionStates[node.key] === 'loading') status = 'loading';
    else if (connectionStates[node.key] === 'success') status = 'success';
    else if (connectionStates[node.key] === 'error') status = 'error';
  }
  const legacyBadgeStatus = status === 'loading' ? 'processing' : status;

  const statusBadge = node.type === 'connection' || node.type === 'database' ? (
    isV2Ui
      ? <span className={`gn-v2-tree-status is-${status}`} aria-hidden="true" />
      : <Badge status={legacyBadgeStatus} style={{ marginLeft: 4, marginRight: 8 }} />
  ) : null;

  const displayTitle = String(node.title ?? '');
  const dragText = resolveSidebarObjectDragText(node);
  let hoverTitle = displayTitle;
  if (node.type === 'table' || node.type === 'view' || node.type === 'materialized-view' || node.type === 'sequence' || node.type === 'package' || node.type === 'db-event') {
    const rawTableName = String(node?.dataRef?.tableName || node?.dataRef?.viewName || node?.dataRef?.sequenceName || node?.dataRef?.packageName || node?.dataRef?.eventName || '').trim();
    const conn = node?.dataRef as SavedConnection | undefined;
    if (rawTableName && shouldHideSchemaPrefix(conn)) {
      if (splitQualifiedName(rawTableName).schemaName) {
        hoverTitle = rawTableName;
      }
    }
    const tableComment = node.type === 'table' ? String(node?.dataRef?.tableComment || '').trim() : '';
    if (tableComment) {
      hoverTitle = `${hoverTitle}\n${t('sidebar.v2_table_group_menu.table_comment_tooltip', { comment: tableComment })}`;
    }
  } else if (node.type === 'object-group') {
    const objectGroupTitle = resolveV2ObjectGroupTitle(node);
    if (objectGroupTitle) {
      hoverTitle = objectGroupTitle;
    }
  } else if (node.type === 'external-sql-directory' || node.type === 'external-sql-folder' || node.type === 'external-sql-file') {
    hoverTitle = String(node?.dataRef?.path || displayTitle);
  }
  const objectCompileStatus = (node.type === 'routine' || node.type === 'db-trigger')
    ? normalizeOracleObjectCompileStatus(node?.dataRef?.objectStatus)
    : '';
  const objectCompileStatusLabel = objectCompileStatus
    ? t(`sidebar.object_status.${objectCompileStatus.toLowerCase()}`)
    : '';
  if (objectCompileStatusLabel) {
    hoverTitle = `${hoverTitle}\n${t('sidebar.object_status.tooltip', { status: objectCompileStatusLabel })}`;
  }
  const objectCompileStatusBadge = !isV2Ui && objectCompileStatus ? (
    <span
      className={`gonavi-sidebar-object-status is-${objectCompileStatus.toLowerCase()}`}
      data-sidebar-object-status={objectCompileStatus}
      title={t('sidebar.object_status.tooltip', { status: objectCompileStatusLabel })}
    >
      {objectCompileStatusLabel}
    </span>
  ) : null;

  if (node.type === 'jvm-mode') {
    return (
      <span
        title={hoverTitle}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}
      >
        <JVMModeBadge
          mode={String(node?.dataRef?.providerMode || displayTitle)}
          label={displayTitle}
          reason={String(node?.dataRef?.reason || '').trim() || undefined}
        />
      </span>
    );
  }

  if (node.type === 'external-sql-root') {
    const externalSqlRootTitle = t('sidebar.external_sql.root');
    const addSqlDirectoryLabel = t('sidebar.menu.add_sql_directory');
    return (
      <span
        title={externalSqlRootTitle}
        className="gn-v2-tree-external-root"
      >
        <span
          className="gn-v2-tree-title"
          data-node-type={node.type}
          data-sidebar-node-key={String(node.key || '')}
          data-sidebar-node-type={String(node.type || '')}
        >
          <span className="gn-v2-tree-label">
            {statusBadge}
            {externalSqlRootTitle}
          </span>
        </span>
        <Button
          size="small"
          type="text"
          icon={<PlusOutlined />}
          title={addSqlDirectoryLabel}
          aria-label={addSqlDirectoryLabel}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void handleAddExternalSQLDirectoryRef.current(node);
          }}
          className="gn-v2-tree-external-root-action"
        />
      </span>
    );
  }

  if (isV2Ui) {
    return renderV2TreeTitle(node, hoverTitle, statusBadge);
  }

  if (dragText) {
    return (
      <span
        title={hoverTitle}
        draggable
        onDragStart={(event) => {
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
        }}
        onDragEnd={() => {
          restoreTreeSelectionAfterDrag();
          setIsTreeDragging(false);
        }}
      >
        {statusBadge}{displayTitle}{objectCompileStatusBadge}
      </span>
    );
  }

  return <span title={hoverTitle}>{statusBadge}{displayTitle}{objectCompileStatusBadge}</span>;
}, [
  connectionStates,
  isV2Ui,
  renderV2TreeTitle,
  restoreTreeSelectionAfterDrag,
  setIsTreeDragging,
  snapshotTreeSelectionBeforeDrag,
  treeDragSelectSuppressUntilRef,
]);
};
