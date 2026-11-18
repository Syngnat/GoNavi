import type { ReactNode } from 'react';
import { t } from '../../i18n';
import type { MetadataHoverRow } from '../common/MetadataHoverCard';
import {
  buildSidebarTableMetadataSnapshot,
  formatSidebarRowCount,
  formatSidebarTableSize,
  formatSidebarTableTimestamp,
} from './sidebarHelpers';
import { resolveConnectionHostSummary } from '../../utils/tabDisplay';

export type SidebarEntityHoverModel = {
  badge: string;
  dataKind: 'connection' | 'database' | 'table';
  title: string;
  rows: MetadataHoverRow[];
};

const countSidebarNodes = (
  nodes: unknown,
  predicate: (node: any) => boolean,
): number => {
  if (!Array.isArray(nodes)) return 0;
  return nodes.reduce((total, node) => {
    const childTotal = countSidebarNodes(node?.children, predicate);
    return total + (predicate(node) ? 1 : 0) + childTotal;
  }, 0);
};

const pushRow = (
  rows: MetadataHoverRow[],
  key: string,
  label: string,
  value: ReactNode,
) => {
  if (value === undefined || value === null || value === '') return;
  rows.push({ key, label, value });
};

export const buildSidebarEntityHoverModel = (
  node: any,
  displayTitle: string,
  connectionStatus?: string,
): SidebarEntityHoverModel | null => {
  const dataRef = node?.dataRef || {};
  const kind = node?.type === 'connection' || node?.type === 'database' || node?.type === 'table'
    ? node.type
    : null;
  if (!kind) return null;

  const connectionLabel = String(
    dataRef.name
    || (kind === 'connection' ? displayTitle : '')
    || '',
  ).trim();
  const config = dataRef.config || {};
  const hostSummary = resolveConnectionHostSummary(config);
  const dbName = String(
    dataRef.dbName
    || (kind === 'database' ? displayTitle : '')
    || config.database
    || '',
  ).trim();
  const schemaName = String(dataRef.schemaName || '').trim();
  const driverLabel = String(config.driver || config.type || dataRef.iconType || '').trim();
  const statusLabel = connectionStatus === 'loading'
    ? t('common.loading')
    : connectionStatus === 'success'
      ? t('common.success')
      : connectionStatus === 'error'
        ? t('common.error')
        : '';
  const loadedDatabaseCount = countSidebarNodes(node?.children, (child) => child?.type === 'database');
  const loadedTableCount = countSidebarNodes(node?.children, (child) => child?.type === 'table');
  const hasLoadedChildren = Array.isArray(node?.children) && node.children.length > 0;

  if (kind === 'connection') {
    const rows: MetadataHoverRow[] = [];
    pushRow(rows, 'type', t('tab_manager.hover.label.type'), t('sidebar.entity_hover.kind.connection'));
    pushRow(rows, 'driver', t('sidebar.entity_hover.label.driver'), driverLabel);
    pushRow(rows, 'host', 'Host', hostSummary || t('tab_manager.hover.fallback.host_not_configured'));
    pushRow(rows, 'database', t('tab_manager.hover.label.database'), dbName || t('tab_manager.hover.fallback.database_not_specified'));
    if (hasLoadedChildren) {
      pushRow(rows, 'databaseCount', t('sidebar.entity_hover.label.database_count'), loadedDatabaseCount.toLocaleString());
      pushRow(rows, 'tableCount', t('sidebar.entity_hover.label.table_count'), loadedTableCount.toLocaleString());
    }
    pushRow(rows, 'status', t('sidebar.entity_hover.label.status'), statusLabel);
    return {
      badge: t('tab_manager.kind_badge.connection'),
      dataKind: 'connection',
      title: connectionLabel || displayTitle,
      rows,
    };
  }

  if (kind === 'database') {
    const rows: MetadataHoverRow[] = [];
    pushRow(rows, 'type', t('tab_manager.hover.label.type'), t('sidebar.entity_hover.kind.database'));
    pushRow(rows, 'connection', t('tab_manager.hover.label.connection'), connectionLabel || t('tab_manager.hover.fallback.unbound_connection'));
    pushRow(rows, 'driver', t('sidebar.entity_hover.label.driver'), driverLabel);
    pushRow(rows, 'host', 'Host', hostSummary || t('tab_manager.hover.fallback.host_not_configured'));
    pushRow(rows, 'database', t('tab_manager.hover.label.database'), dbName || displayTitle);
    pushRow(rows, 'schema', 'Schema', schemaName);
    if (hasLoadedChildren) {
      pushRow(rows, 'tableCount', t('sidebar.entity_hover.label.table_count'), loadedTableCount.toLocaleString());
    }
    pushRow(rows, 'status', t('sidebar.entity_hover.label.status'), statusLabel);
    return {
      badge: t('tab_manager.kind_badge.database'),
      dataKind: 'database',
      title: dbName || displayTitle,
      rows,
    };
  }

  const metadata = buildSidebarTableMetadataSnapshot(dataRef);
  const tableName = String(dataRef.tableName || displayTitle || node?.title || '').trim();
  const rows: MetadataHoverRow[] = [];
  pushRow(rows, 'type', t('tab_manager.hover.label.type'), t('tab_manager.hover.kind.table'));
  pushRow(rows, 'connection', t('tab_manager.hover.label.connection'), connectionLabel || t('tab_manager.hover.fallback.unbound_connection'));
  pushRow(rows, 'host', 'Host', hostSummary || t('tab_manager.hover.fallback.host_not_configured'));
  pushRow(rows, 'database', t('tab_manager.hover.label.database'), dbName || t('tab_manager.hover.fallback.database_not_specified'));
  pushRow(rows, 'schema', 'Schema', schemaName);
  pushRow(rows, 'object', t('tab_manager.hover.label.object'), tableName);
  pushRow(rows, 'comment', t('table_designer.action.table_comment'), metadata.tableComment || '');
  pushRow(
    rows,
    'rows',
    t('sidebar.v2_table_group_menu.display_table_rows'),
    metadata.rowCount !== undefined ? formatSidebarRowCount(metadata.rowCount) : '',
  );
  pushRow(
    rows,
    'size',
    t('sidebar.v2_table_group_menu.display_table_size'),
    metadata.tableSize !== undefined ? formatSidebarTableSize(metadata.tableSize) : '',
  );
  pushRow(
    rows,
    'createdAt',
    t('sidebar.v2_table_group_menu.display_create_time'),
    metadata.createdAt ? formatSidebarTableTimestamp(metadata.createdAt) : '',
  );
  pushRow(
    rows,
    'updatedAt',
    t('sidebar.v2_table_group_menu.display_update_time'),
    metadata.updatedAt ? formatSidebarTableTimestamp(metadata.updatedAt) : '',
  );
  return {
    badge: t('tab_manager.kind_badge.table'),
    dataKind: 'table',
    title: tableName || displayTitle,
    rows,
  };
};
