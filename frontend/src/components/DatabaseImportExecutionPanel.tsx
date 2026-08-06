import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Progress, Typography } from 'antd';
import {
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';

import { CancelSQLFileExecution, ImportDatabaseSQL } from '../../wailsjs/go/app/App';
import { t as defaultTranslate } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';
import type { SavedConnection } from '../types';
import { confirmProductionRisk } from '../utils/productionRiskConfirm';
import {
  useSQLFileExecutionRunner,
  type SQLFileExecutionRunnerStatus,
} from './useSQLFileExecutionRunner';

const { Paragraph, Text, Title } = Typography;

type DatabaseImportExecutionPanelProps = {
  connection?: SavedConnection;
  connectionConfig: Record<string, unknown> | null;
  dbName?: string;
  filePath: string;
  fileSizeMB?: string;
  darkMode: boolean;
  onRunningChange?: (running: boolean) => void;
};

const getFileName = (filePath: string): string => {
  const parts = String(filePath || '').split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
};

const resolveProgressStatus = (
  status: SQLFileExecutionRunnerStatus,
): 'active' | 'success' | 'exception' | 'normal' => {
  if (status === 'done') return 'success';
  if (status === 'error') return 'exception';
  if (status === 'start' || status === 'running') return 'active';
  return 'normal';
};

const DatabaseImportExecutionPanel: React.FC<DatabaseImportExecutionPanelProps> = ({
  connection,
  connectionConfig,
  dbName = '',
  filePath,
  fileSizeMB,
  darkMode,
  onRunningChange,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? defaultTranslate;
  const [executionPending, setExecutionPending] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const lastReportedRunningRef = useRef<boolean | null>(null);
  const {
    state,
    reset,
    cancelExecution,
    runSQLFileExecutionWithProgress,
    isRunning,
  } = useSQLFileExecutionRunner({ showToast: false });

  const taskRunning = isRunning || executionPending;
  const progressPercent = Math.max(0, Math.min(100, Number(state.percent) || 0));
  const terminal = state.status === 'done'
    || state.status === 'cancelled'
    || state.status === 'error';
  const subtleBackground = darkMode ? 'rgba(255,255,255,0.04)' : '#f8fafc';
  const dividerColor = darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.08)';

  useEffect(() => {
    if (lastReportedRunningRef.current === taskRunning) return;
    lastReportedRunningRef.current = taskRunning;
    onRunningChange?.(taskRunning);
  }, [onRunningChange, taskRunning]);

  const startImport = useCallback(async () => {
    if (!connectionConfig || !String(filePath || '').trim() || taskRunning) return;
    const approved = await confirmProductionRisk({
      connection,
      action: t('connection.production_risk.action.execute_sql'),
      target: [dbName, getFileName(filePath)].filter(Boolean).join(' / '),
      translate: t,
    });
    if (!approved) return;
    setExecutionPending(true);
    setCancelRequested(false);
    try {
      await runSQLFileExecutionWithProgress({
        title: getFileName(filePath),
        filePath,
        fileSizeMB,
        run: (jobId) => ImportDatabaseSQL(
          connectionConfig as any,
          String(dbName || '').trim(),
          filePath,
          jobId,
        ),
        cancel: async (jobId) => {
          await CancelSQLFileExecution(jobId);
        },
      });
    } catch {
      // The shared runner already records and displays the RPC error state.
    } finally {
      setExecutionPending(false);
    }
  }, [
    connectionConfig,
    connection,
    dbName,
    filePath,
    fileSizeMB,
    runSQLFileExecutionWithProgress,
    taskRunning,
    t,
  ]);

  const requestCancel = useCallback(async () => {
    if (!taskRunning || cancelRequested) return;
    setCancelRequested(true);
    try {
      await cancelExecution();
    } catch {
      setCancelRequested(false);
    }
  }, [cancelExecution, cancelRequested, taskRunning]);

  const resetProgress = useCallback(() => {
    if (taskRunning) return;
    setCancelRequested(false);
    reset();
  }, [reset, taskRunning]);

  const statusText = useMemo(() => {
    if (cancelRequested && taskRunning) return t('data_import.workbench.state.cancelling');
    switch (state.status) {
      case 'start':
      case 'running':
        return t('data_import.workbench.state.running');
      case 'done':
        return t('data_import.workbench.state.completed');
      case 'error':
        return t('data_import.workbench.state.failed');
      case 'cancelled':
        return t('data_import.workbench.state.cancelled');
      default:
        return t('data_import.workbench.state.ready_sql_title');
    }
  }, [cancelRequested, state.status, t, taskRunning]);

  const resultAlertType = state.status === 'error'
    ? 'error'
    : state.status === 'cancelled'
      ? 'warning'
      : 'success';

  return (
    <div
      data-database-import-execution-panel="true"
      style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}
    >
      <Alert
        type="warning"
        showIcon
        message={t('data_import.workbench.notice.partial_execution')}
      />
      <Alert
        type="info"
        showIcon
        message={t('data_import.workbench.notice.gonavi_mysql_restore')}
      />

      <div
        style={{
          padding: 16,
          borderRadius: 8,
          border: `1px solid ${dividerColor}`,
          background: subtleBackground,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ minWidth: 0 }}>
            <Title level={5} style={{ margin: 0, letterSpacing: 0 }}>
              {statusText}
            </Title>
            <Paragraph
              type="secondary"
              title={filePath}
              style={{ margin: '6px 0 0', wordBreak: 'break-all' }}
            >
              {state.status === 'idle'
                ? t('data_import.workbench.state.ready_sql_description')
                : state.filePath || filePath}
            </Paragraph>
          </div>
          {fileSizeMB ? <Text type="secondary">{fileSizeMB} MB</Text> : null}
        </div>

        {state.status !== 'idle' ? (
          <div style={{ marginTop: 16 }}>
            <Progress
              data-database-import-progress="true"
              percent={Math.round(progressPercent)}
              status={resolveProgressStatus(state.status)}
              strokeColor={state.status === 'cancelled' ? '#faad14' : undefined}
            />
            <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <Text type="secondary">{state.stage || statusText}</Text>
              <Text type="secondary">
                {t('data_import.workbench.progress.statements', {
                  executed: state.executed,
                  failed: state.failed,
                  total: state.total,
                })}
              </Text>
            </div>
          </div>
        ) : null}

        {state.currentSQL ? (
          <div
            data-database-import-current-sql="true"
            style={{
              marginTop: 14,
              maxHeight: 112,
              overflow: 'auto',
              padding: '10px 12px',
              borderRadius: 6,
              border: `1px solid ${dividerColor}`,
              fontFamily: 'var(--gn-font-mono)',
              fontSize: 12,
              wordBreak: 'break-all',
            }}
          >
            {state.currentSQL}
          </div>
        ) : null}

        {terminal && state.message ? (
          <Alert
            data-database-import-result="true"
            style={{ marginTop: 14 }}
            type={resultAlertType}
            showIcon
            message={state.message}
          />
        ) : null}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
          {taskRunning ? (
            <Button
              data-database-import-cancel-action="true"
              danger
              icon={<StopOutlined />}
              loading={cancelRequested}
              disabled={cancelRequested}
              onClick={() => void requestCancel()}
            >
              {cancelRequested
                ? t('data_import.workbench.state.cancelling')
                : t('data_import.workbench.action.cancel_database_import')}
            </Button>
          ) : (
            <Button
              data-database-import-start-action="true"
              type="primary"
              icon={terminal ? <ReloadOutlined /> : <PlayCircleOutlined />}
              disabled={!connectionConfig || !String(filePath || '').trim()}
              onClick={() => void startImport()}
            >
              {terminal
                ? t('data_import.workbench.action.retry_database_import')
                : t('data_import.workbench.action.start_database_import')}
            </Button>
          )}
          {terminal ? (
            <Button
              data-database-import-clear-progress-action="true"
              icon={<ReloadOutlined />}
              onClick={resetProgress}
            >
              {t('data_export.action.clear_progress')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default DatabaseImportExecutionPanel;
