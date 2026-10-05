import { ClockCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Alert, Empty } from 'antd';
import { t } from '../../i18n';
import { renderStatusPill, resolveStatusMeta } from './tableExportStatusMeta';
import { Title, formatDateTime, Text, Paragraph } from './tableExportWorkbenchOptions';
import { formatExportElapsed } from '../../utils/exportProgress';
import ExportProgressBar from '../ExportProgressBar';
import type { TableExportStateApi } from './hooks/useTableExportState';
import type { TableExportBatchTableActionsApi } from './hooks/useTableExportBatchTableActions';
import type { TableExportWorkbenchBodyProps } from '../TableExportWorkbench';

export interface TableExportProgressPanelProps {
  headingColor: TableExportStateApi['headingColor'];
  progressState: TableExportStateApi['progressState'];
  tab: TableExportWorkbenchBodyProps['tab'];
  secondaryTextColor: TableExportStateApi['secondaryTextColor'];
  fallbackTargetName: TableExportBatchTableActionsApi['fallbackTargetName'];
  currentScopeLabel: TableExportBatchTableActionsApi['currentScopeLabel'];
  fallbackFormat: TableExportBatchTableActionsApi['fallbackFormat'];
  currentElapsedMs: TableExportBatchTableActionsApi['currentElapsedMs'];
  currentStrategyLabel: TableExportBatchTableActionsApi['currentStrategyLabel'];
  isRunning: TableExportStateApi['isRunning'];
  cancelExport: TableExportStateApi['cancelExport'];
  currentProgressSummary: TableExportBatchTableActionsApi['currentProgressSummary'];
  currentProgressHint: TableExportBatchTableActionsApi['currentProgressHint'];
  progressOutputLabel: TableExportBatchTableActionsApi['progressOutputLabel'];
  progressLogs: TableExportStateApi['progressLogs'];
  dividerColor: TableExportStateApi['dividerColor'];
  isSingleFileBackup: TableExportBatchTableActionsApi['isSingleFileBackup'];
  openBackupRestoreWorkbench: TableExportBatchTableActionsApi['openBackupRestoreWorkbench'];
  reset: TableExportStateApi['reset'];
}

export const TableExportProgressPanel = ({
  headingColor, progressState, tab, secondaryTextColor, fallbackTargetName, currentScopeLabel,
  fallbackFormat, currentElapsedMs, currentStrategyLabel, isRunning, cancelExport,
  currentProgressSummary, currentProgressHint, progressOutputLabel, progressLogs, dividerColor,
  isSingleFileBackup, openBackupRestoreWorkbench, reset,
}: TableExportProgressPanelProps) => (
  <section
    data-export-workbench-progress-panel="true"
    style={{
      padding: '16px 20px 18px',
      borderRadius: 0,
      background: 'transparent',
      border: 'none',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      flex: '0 0 auto',
      minHeight: 0,
    }}
  >
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: headingColor }}>{t('data_export.workbench.section.current_task')}</div>
          {renderStatusPill(progressState.status)}
        </div>
        <Title level={5} style={{ margin: '10px 0 0', color: headingColor }}>
          {progressState.title || tab.title || t('data_export.progress.value.task_fallback')}
        </Title>
        <div style={{ marginTop: 6, color: secondaryTextColor, fontSize: 13 }}>
          {progressState.jobId
            ? `${progressState.targetName || fallbackTargetName} · ${currentScopeLabel} · ${progressState.format || fallbackFormat}`
            : t('data_export.workbench.description.current_task_empty')}
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(120px, auto))',
          gap: '12px 18px',
          alignSelf: 'stretch',
        }}
      >
        <div>
          <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 4 }}>{t('data_export.label.elapsed')}</div>
          <div style={{ color: headingColor, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <ClockCircleOutlined />
            {progressState.startedAt ? formatExportElapsed(currentElapsedMs) : '--:--'}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 4 }}>{t('data_export.label.started_at')}</div>
          <div style={{ color: headingColor, fontWeight: 600 }}>{formatDateTime(progressState.startedAt)}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 4 }}>{t('data_export.label.export_scope')}</div>
          <div style={{ color: headingColor, fontWeight: 600 }}>{progressState.jobId ? currentScopeLabel : '-'}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 4 }}>{t('data_export.label.strategy')}</div>
          <div style={{ color: headingColor, fontWeight: 600 }}>{progressState.jobId ? currentStrategyLabel : '-'}</div>
        </div>
      </div>
    </div>

    {progressState.jobId ? (
      <>
        <div data-export-workbench-main-progress="true">
          <ExportProgressBar
            status={progressState.status}
            current={progressState.current}
            total={progressState.total}
            totalRowsKnown={progressState.totalRowsKnown}
          />
        </div>

        {isRunning ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              danger
              size="small"
              disabled={progressState.status === 'cancelling'}
              onClick={() => { void cancelExport(); }}
            >
              {progressState.status === 'cancelling'
                ? t('data_export.progress.cancelling')
                : t('data_export.progress.cancel')}
            </Button>
          </div>
        ) : null}

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(260px, 0.9fr)', gap: 18 }}>
          <div>
            <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 6 }}>{t('data_export.label.current_stage')}</div>
            <Text data-export-workbench-stage="true">
              {progressState.stage || resolveStatusMeta(progressState.status).label || t('data_export.value.waiting_to_start')}
            </Text>
            <div style={{ fontSize: 12, color: secondaryTextColor, margin: '12px 0 6px' }}>{t('data_export.label.progress_summary')}</div>
            <Text>{currentProgressSummary}</Text>
            {currentProgressHint ? (
              <div style={{ marginTop: 6, fontSize: 12, color: secondaryTextColor }}>
                {currentProgressHint}
              </div>
            ) : null}
          </div>
          <div>
            <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 6 }}>{progressOutputLabel}</div>
            {progressState.filePath ? (
              <Paragraph style={{ marginBottom: 0, wordBreak: 'break-all' }}>{progressState.filePath}</Paragraph>
            ) : (
              <Text type="secondary">{t('data_export.value.waiting_target_path')}</Text>
            )}
          </div>
        </div>

        {progressState.message ? (
          <Alert
            type={progressState.status === 'error' ? 'error' : 'info'}
            showIcon
            message={progressState.message}
          />
        ) : null}

        {progressLogs.length > 0 ? (
          <div data-export-workbench-logs="true">
            <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 8 }}>
              {t('data_export.workbench.section.logs')}
            </div>
            <div
              style={{
                maxHeight: 180,
                overflow: 'auto',
                padding: '4px 0',
                borderRadius: 0,
                background: 'transparent',
                border: 'none',
                borderTop: `0.5px solid ${dividerColor}`,
              }}
            >
              {progressLogs.slice(-50).map((entry, index) => (
                <div
                  key={`${entry.jobId}-${entry.sequence}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '72px minmax(0, 1fr)',
                    gap: 10,
                    padding: '8px 0',
                    borderTop: index === 0 ? 'none' : `1px solid ${dividerColor}`,
                    fontSize: 12,
                  }}
                >
                  <Text type="secondary">
                    {new Date(entry.timestamp).toLocaleTimeString(undefined, { hour12: false })}
                  </Text>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: headingColor, wordBreak: 'break-word' }}>
                      {entry.stage || resolveStatusMeta(entry.status).label}
                    </div>
                    {entry.message ? (
                      <div style={{ marginTop: 3, color: entry.status === 'error' ? '#dc2626' : secondaryTextColor, wordBreak: 'break-word' }}>
                        {entry.message}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {(progressState.status === 'done' || progressState.status === 'error') ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
            {isSingleFileBackup ? (
              <Button
                data-export-restore-backup={true}
                icon={<ReloadOutlined />}
                onClick={() => openBackupRestoreWorkbench()}
              >
                {t('data_export.action.restore_backup')}
              </Button>
            ) : null}
            <Button icon={<ReloadOutlined />} onClick={reset}>{t('data_export.action.clear_progress')}</Button>
          </div>
        ) : null}
      </>
    ) : (
      <div data-export-workbench-current-empty="true">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t('data_export.workbench.empty.not_started')}
        />
      </div>
    )}
  </section>
);
