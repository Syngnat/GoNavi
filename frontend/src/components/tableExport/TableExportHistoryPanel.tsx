import { Button } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { t } from '../../i18n';
import { Text, formatDateTime, Paragraph } from './tableExportWorkbenchOptions';
import { renderStatusPill, resolveStatusMeta } from './tableExportStatusMeta';
import { formatWorkbenchProgressSummary } from './tableExportWorkbenchModel';
import { formatExportElapsed, resolveExportElapsedMs } from '../../utils/exportProgress';
import type { TableExportStateApi } from './hooks/useTableExportState';
import type { TableExportBatchTableActionsApi } from './hooks/useTableExportBatchTableActions';

export interface TableExportHistoryPanelProps {
  dividerColor: TableExportStateApi['dividerColor'];
  headingColor: TableExportStateApi['headingColor'];
  secondaryTextColor: TableExportStateApi['secondaryTextColor'];
  historyEntries: TableExportBatchTableActionsApi['historyEntries'];
  workbenchMode: TableExportStateApi['workbenchMode'];
  nowTick: TableExportStateApi['nowTick'];
  isBatchDatabasesWorkbench: TableExportStateApi['isBatchDatabasesWorkbench'];
  openBackupRestoreWorkbench: TableExportBatchTableActionsApi['openBackupRestoreWorkbench'];
}

export const TableExportHistoryPanel = ({
  dividerColor, headingColor, secondaryTextColor, historyEntries, workbenchMode, nowTick,
  isBatchDatabasesWorkbench, openBackupRestoreWorkbench,
}: TableExportHistoryPanelProps) => (
  <section
    data-export-workbench-history="true"
    style={{
      padding: '14px 20px 18px',
      borderRadius: 0,
      background: 'transparent',
      border: 'none',
      borderTop: `0.5px solid ${dividerColor}`,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: headingColor }}>{t('data_export.workbench.section.history')}</div>
        <div style={{ marginTop: 4, fontSize: 12, color: secondaryTextColor }}>
          {t('data_export.workbench.description.history')}
        </div>
      </div>
      <div style={{ color: secondaryTextColor, fontSize: 12 }}>
        {t('data_export.workbench.history.count', { count: historyEntries.length })}
      </div>
    </div>

    {historyEntries.length > 0 ? (
      <div data-export-workbench-history-list="true" style={{ display: 'flex', flexDirection: 'column' }}>
        {historyEntries.map((entry, index) => (
          <div
            key={entry.jobId}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1.15fr) minmax(280px, 0.85fr)',
              gap: 18,
              padding: '14px 0',
              borderTop: index === 0 ? 'none' : `1px solid ${dividerColor}`,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <Text strong>{entry.targetName}</Text>
                {renderStatusPill(entry.status)}
                <span style={{ fontSize: 12, color: secondaryTextColor }}>
                  {entry.scopeLabel} · {entry.format || '-'}
                </span>
              </div>
              <div style={{ marginTop: 6, fontSize: 13, color: headingColor }}>
                {entry.stage || resolveStatusMeta(entry.status).label}
              </div>
              <div style={{ marginTop: 4, fontSize: 12, color: secondaryTextColor }}>
                {formatWorkbenchProgressSummary(workbenchMode, entry.current, entry.total, entry.totalRowsKnown)}
              </div>
              {entry.message ? (
                <div style={{ marginTop: 8, fontSize: 12, color: '#dc2626' }}>{entry.message}</div>
              ) : null}
            </div>

            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '80px minmax(0, 1fr)', rowGap: 6, columnGap: 10 }}>
                <Text type="secondary">{t('data_export.label.started_at')}</Text>
                <Text>{formatDateTime(entry.startedAt)}</Text>

                <Text type="secondary">{t('data_export.label.elapsed')}</Text>
                <Text>{formatExportElapsed(resolveExportElapsedMs(entry.startedAt, entry.finishedAt, nowTick))}</Text>

                <Text type="secondary">{isBatchDatabasesWorkbench ? t('data_export.label.directory') : t('data_export.label.file')}</Text>
                <Paragraph style={{ marginBottom: 0, wordBreak: 'break-all' }}>
                  {entry.filePath || '-'}
                </Paragraph>
              </div>
              {entry.status === 'done'
                && !isBatchDatabasesWorkbench
                && String(entry.filePath || '').trim().toLowerCase().endsWith('.sql') ? (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                    <Button
                      size="small"
                      data-export-history-restore={entry.jobId}
                      icon={<ReloadOutlined />}
                      onClick={() => openBackupRestoreWorkbench(entry.filePath)}
                    >
                      {t('data_export.action.restore_backup')}
                    </Button>
                  </div>
                ) : null}
            </div>
          </div>
        ))}
      </div>
    ) : (
      <div style={{ padding: '6px 0 2px', color: secondaryTextColor, fontSize: 13 }}>
        {t('data_export.workbench.empty.history')}
      </div>
    )}
  </section>
);
