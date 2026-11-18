import { t } from '../../i18n';
import type { SidebarEntityHoverModel } from '../sidebar/sidebarEntityHoverModel';
import { formatSidebarTableTimestamp } from '../sidebar/sidebarHelpers';
import { formatRows, formatSize, type TableStatRow } from './tableOverviewModel';

type BuildTableOverviewHoverModelInput = {
  table: TableStatRow;
  displayName: string;
  connectionName?: string;
  hostSummary?: string;
  dbName?: string;
  schemaName?: string;
};

const addRow = (
  rows: SidebarEntityHoverModel['rows'],
  key: string,
  label: string,
  value: unknown,
) => {
  if (value === undefined || value === null || value === '') return;
  rows.push({ key, label, value: String(value) });
};

export const buildTableOverviewHoverModel = ({
  table,
  displayName,
  connectionName,
  hostSummary,
  dbName,
  schemaName,
}: BuildTableOverviewHoverModelInput): SidebarEntityHoverModel => {
  const rows: SidebarEntityHoverModel['rows'] = [];
  addRow(rows, 'type', t('tab_manager.hover.label.type'), t('tab_manager.hover.kind.table'));
  addRow(
    rows,
    'connection',
    t('tab_manager.hover.label.connection'),
    connectionName || t('tab_manager.hover.fallback.unbound_connection'),
  );
  addRow(
    rows,
    'host',
    'Host',
    hostSummary || t('tab_manager.hover.fallback.host_not_configured'),
  );
  addRow(
    rows,
    'database',
    t('tab_manager.hover.label.database'),
    dbName || t('tab_manager.hover.fallback.database_not_specified'),
  );
  addRow(rows, 'schema', 'Schema', schemaName);
  addRow(rows, 'object', t('tab_manager.hover.label.object'), displayName || table.name);
  addRow(rows, 'comment', t('table_designer.action.table_comment'), table.comment);
  addRow(rows, 'rows', t('table_overview.sort.rows'), formatRows(table.rows));
  addRow(rows, 'dataSize', t('table_overview.metric.data_size'), formatSize(table.dataSize));
  addRow(rows, 'indexSize', t('table_overview.metric.index_size'), formatSize(table.indexSize));
  addRow(rows, 'engine', t('table_overview.metric.engine'), table.engine);
  addRow(rows, 'charset', t('table_overview.metric.charset'), table.charset);
  addRow(rows, 'collation', t('table_overview.metric.collation'), table.collation);
  addRow(
    rows,
    'createdAt',
    t('table_overview.metric.created_at'),
    table.createTime ? formatSidebarTableTimestamp(table.createTime) || table.createTime : '',
  );
  addRow(
    rows,
    'updatedAt',
    t('table_overview.metric.updated_at'),
    table.updateTime ? formatSidebarTableTimestamp(table.updateTime) || table.updateTime : '',
  );

  return {
    badge: t('tab_manager.kind_badge.table'),
    dataKind: 'table',
    title: displayName || table.name,
    rows,
  };
};
