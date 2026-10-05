import { Title } from './tableExportWorkbenchOptions';
import { t } from '../../i18n';
import type { TableExportStateApi } from './hooks/useTableExportState';
import type { TableExportRunActionsApi } from './hooks/useTableExportRunActions';

export interface TableExportWorkbenchHeaderProps {
  dividerColor: TableExportStateApi['dividerColor'];
  headingColor: TableExportStateApi['headingColor'];
  isBatchTablesWorkbench: TableExportStateApi['isBatchTablesWorkbench'];
  isBatchDatabasesWorkbench: TableExportStateApi['isBatchDatabasesWorkbench'];
  secondaryTextColor: TableExportStateApi['secondaryTextColor'];
  isBatchDeleteIntent: TableExportStateApi['isBatchDeleteIntent'];
  headerBadges: TableExportRunActionsApi['headerBadges'];
  pillBg: TableExportStateApi['pillBg'];
}

export const TableExportWorkbenchHeader = ({
  dividerColor, headingColor, isBatchTablesWorkbench, isBatchDatabasesWorkbench, secondaryTextColor,
  isBatchDeleteIntent, headerBadges, pillBg,
}: TableExportWorkbenchHeaderProps) => (
  <div
    style={{
      padding: '16px 20px 14px',
      borderBottom: `0.5px solid ${dividerColor}`,
      background: 'transparent',
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 16,
      flexWrap: 'wrap',
    }}
  >
    <div style={{ minWidth: 0 }}>
      <Title level={4} style={{ margin: 0, color: headingColor }}>
        {isBatchTablesWorkbench
          ? t('sidebar.action.batch_tables')
          : isBatchDatabasesWorkbench
            ? t('sidebar.action.batch_databases')
            : t('data_export.workbench.title')}
      </Title>
      <div style={{ marginTop: 6, color: secondaryTextColor, fontSize: 13 }}>
        {isBatchTablesWorkbench
          ? (isBatchDeleteIntent
            ? t('data_export.workbench.intent.batch_tables_delete_description')
            : t('sidebar.modal.batch_tables.description'))
          : isBatchDatabasesWorkbench
            ? (isBatchDeleteIntent
              ? t('data_export.workbench.intent.batch_databases_delete_description')
              : t('sidebar.modal.batch_databases.description'))
            : t('data_export.workbench.subtitle')}
      </div>
    </div>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {headerBadges.map((label) => (
        <span
          key={label}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '6px 10px',
            borderRadius: 999,
            background: pillBg,
            color: headingColor,
            fontSize: 12,
            fontWeight: 500,
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
      ))}
    </div>
  </div>
);
