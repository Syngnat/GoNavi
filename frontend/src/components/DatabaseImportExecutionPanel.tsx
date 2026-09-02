import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Progress, Typography } from 'antd';
import {
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';

import {
  CancelSQLFileExecution,
  ImportDatabaseSQLWithOptions,
  PreflightDatabaseSQLImport,
} from '../../wailsjs/go/app/App';
import { t as defaultTranslate } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';
import type { SavedConnection } from '../types';
import { confirmProductionRisk } from '../utils/productionRiskConfirm';
import { invokeAppWithSignal } from '../utils/webRpc';
import { formatImportBytes, formatImportDuration } from './importProgressMetrics';
import Modal from './common/ResizableDraggableModal';
import {
  requestMySQLGTIDImportMode,
  type MySQLGTIDImportMode,
} from './MySQLGTIDImportModePrompt';
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
  fileName?: string;
  fileSizeMB?: string;
  darkMode: boolean;
  continueOnError: boolean;
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
  if (status === 'start' || status === 'running' || status === 'stopping') return 'active';
  return 'normal';
};

const DatabaseImportExecutionPanel: React.FC<DatabaseImportExecutionPanelProps> = ({
  connection,
  connectionConfig,
  dbName = '',
  filePath,
  fileName = '',
  fileSizeMB,
  darkMode,
  continueOnError,
  onRunningChange,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? defaultTranslate;
  const [executionPending, setExecutionPending] = useState(false);
  const [executionStarted, setExecutionStarted] = useState(false);
  const [preflightError, setPreflightError] = useState('');
  const [cancelRequested, setCancelRequested] = useState(false);
  const lastReportedRunningRef = useRef<boolean | null>(null);
  const executionRPCAbortRef = useRef<AbortController | null>(null);
  const {
    state,
    reset,
    cancelExecution,
    runSQLFileExecutionWithProgress,
    isRunning,
  } = useSQLFileExecutionRunner({ showToast: false });

  const taskRunning = isRunning || executionPending;
  const canCancelExecution = isRunning || executionStarted;
  const progressPercent = Math.max(0, Math.min(100, Number(state.percent) || 0));
  const terminal = state.status === 'done'
    || state.status === 'cancelled'
    || state.status === 'error';
  const completedWithErrors = state.status === 'done' && state.failed > 0;
  const subtleBackground = `var(--gn-bg-subtle, var(--gn-bg-panel-2, ${darkMode
    ? 'rgba(255,255,255,0.04)'
    : '#f8fafc'}))`;
  const dividerColor = `var(--gn-br-1, ${darkMode
    ? 'rgba(255,255,255,0.08)'
    : 'rgba(15,23,42,0.08)'})`;
  const warningColor = 'var(--gn-warn, #faad14)';
  const transferMetrics = useMemo(() => {
    if (state.bytesRead <= 0 && state.totalBytes <= 0) return '';
    const details = [t('data_import.workbench.progress.bytes', {
      processed: formatImportBytes(state.bytesRead),
      total: state.totalBytes > 0 ? formatImportBytes(state.totalBytes) : '—',
    })];
    if (state.bytesPerSecond > 0) {
      details.push(t('data_import.workbench.progress.throughput', {
        rate: formatImportBytes(state.bytesPerSecond),
      }));
    }
    if (state.etaSeconds > 0) {
      details.push(t('data_import.workbench.progress.eta', {
        duration: formatImportDuration(state.etaSeconds, i18n?.language),
      }));
    }
    return details.join(' · ');
  }, [i18n?.language, state.bytesPerSecond, state.bytesRead, state.etaSeconds, state.totalBytes, t]);

  useEffect(() => {
    if (lastReportedRunningRef.current === taskRunning) return;
    lastReportedRunningRef.current = taskRunning;
    onRunningChange?.(taskRunning);
  }, [onRunningChange, taskRunning]);

  useEffect(() => () => {
    executionRPCAbortRef.current?.abort();
    executionRPCAbortRef.current = null;
  }, []);

  const startImport = useCallback(async () => {
    if (!connectionConfig || !String(filePath || '').trim() || taskRunning) return;
    const approved = await confirmProductionRisk({
      connection,
      action: t('connection.production_risk.action.execute_sql'),
      target: [dbName, fileName || getFileName(filePath)].filter(Boolean).join(' / '),
      translate: t,
    });
    if (!approved) return;
    setExecutionPending(true);
    setCancelRequested(false);
    setPreflightError('');
    try {
      let mysqlGTIDMode: MySQLGTIDImportMode = 'reject';
      const preflightResult = await PreflightDatabaseSQLImport(
        connectionConfig as any,
        String(dbName || '').trim(),
        filePath,
      );
      if (!preflightResult?.success) {
        setPreflightError(
          preflightResult?.message || t('data_import.workbench.gtid.preflight_failed'),
        );
        return;
      }
      const preflightData = preflightResult.data as {
        requiresGTIDDecision?: unknown;
      } | undefined;
      if (preflightData?.requiresGTIDDecision === true) {
        const selectedMode = await requestMySQLGTIDImportMode(t);
        if (!selectedMode) return;
        mysqlGTIDMode = selectedMode;
      }

      setExecutionStarted(true);
      await runSQLFileExecutionWithProgress({
        title: fileName || getFileName(filePath),
        filePath,
        fileSizeMB,
        run: async (jobId) => {
          executionRPCAbortRef.current?.abort();
          const controller = new AbortController();
          executionRPCAbortRef.current = controller;
          const args = [
            connectionConfig,
            String(dbName || '').trim(),
            filePath,
            jobId,
            continueOnError,
            mysqlGTIDMode,
          ];
          const result = await invokeAppWithSignal(
            'ImportDatabaseSQLWithOptions',
            args,
            controller.signal,
            () => ImportDatabaseSQLWithOptions(
              connectionConfig as any,
              String(dbName || '').trim(),
              filePath,
              jobId,
              continueOnError,
              mysqlGTIDMode,
            ),
          ).finally(() => {
            if (executionRPCAbortRef.current === controller) {
              executionRPCAbortRef.current = null;
            }
          });
          // Reaching EOF with recorded statement errors is a completed import,
          // not a transport/fatal failure. Preserve the counters and render it
          // as a warning result instead of offering a misleading fatal retry.
          if (continueOnError && result.data?.completed === true) {
            return { ...result, success: true };
          }
          return result;
        },
        cancel: async (jobId) => {
          const result = await CancelSQLFileExecution(jobId);
          if (!result?.success) {
            throw new Error(result?.message || t('import_preview.error.stop_failed'));
          }
        },
      });
    } catch {
      // The shared runner already records and displays the RPC error state.
    } finally {
      setExecutionStarted(false);
      setExecutionPending(false);
    }
  }, [
    connectionConfig,
    connection,
    continueOnError,
    dbName,
    fileName,
    filePath,
    fileSizeMB,
    runSQLFileExecutionWithProgress,
    taskRunning,
    t,
  ]);

  const requestCancel = useCallback(async () => {
    if (!canCancelExecution || cancelRequested) return;
    setCancelRequested(true);
    try {
      await cancelExecution();
    } catch {
      setCancelRequested(false);
    }
  }, [canCancelExecution, cancelExecution, cancelRequested]);

  const resetProgress = useCallback(() => {
    if (taskRunning) return;
    setCancelRequested(false);
    reset();
  }, [reset, taskRunning]);

  const requestStartImport = useCallback(() => {
    if (!terminal) {
      void startImport();
      return;
    }
    Modal.confirm({
      title: t('data_import.workbench.confirm.rerun_title'),
      content: t('data_import.workbench.confirm.rerun_content'),
      okText: t('data_import.workbench.action.retry_database_import'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: startImport,
    });
  }, [startImport, t, terminal]);

  const statusText = useMemo(() => {
    if (cancelRequested && taskRunning) return t('data_import.workbench.state.cancelling');
    switch (state.status) {
      case 'start':
      case 'running':
        return t('data_import.workbench.state.running');
      case 'done':
        return state.failed > 0
          ? t('data_import.workbench.state.completed_with_errors')
          : t('data_import.workbench.state.completed');
      case 'error':
        return t('data_import.workbench.state.failed');
      case 'cancelled':
        return t('data_import.workbench.state.cancelled');
      default:
        return t('data_import.workbench.state.ready_sql_title');
    }
  }, [cancelRequested, state.failed, state.status, t, taskRunning]);

  const stageText = useMemo(() => {
    switch (state.stage) {
      case 'prepare':
        return t('import_preview.stage.prepare');
      case 'preflight':
        return t('import_preview.stage.preflight');
      case 'read':
        return t('import_preview.stage.read');
      case 'parse':
        return t('import_preview.stage.parse');
      case 'write':
        return t('import_preview.stage.write');
      case 'finalize':
        return t('import_preview.stage.finalize');
      default:
        return state.stage || statusText;
    }
  }, [state.stage, statusText, t]);

  const resultAlertType = state.status === 'error'
    ? 'error'
    : state.status === 'cancelled'
      ? 'warning'
      : completedWithErrors
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
        message={continueOnError
          ? t('data_import.workbench.notice.continue_on_error')
          : t('data_import.workbench.notice.stop_on_error')}
      />
      {preflightError ? (
        <Alert
          data-database-import-preflight-error="true"
          type="error"
          showIcon
          message={preflightError}
        />
      ) : null}
      <Alert
        type="info"
        showIcon
        message={t('data_import.workbench.notice.gonavi_mysql_restore')}
      />

      <div
        data-database-import-status-card="true"
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
              title={fileName || filePath}
              style={{ margin: '6px 0 0', wordBreak: 'break-all' }}
            >
              {state.status === 'idle'
                ? t('data_import.workbench.state.ready_sql_description')
                : fileName || state.filePath || filePath}
            </Paragraph>
          </div>
          {fileSizeMB ? <Text type="secondary">{fileSizeMB} MB</Text> : null}
        </div>

        {state.status !== 'idle' ? (
          <div style={{ marginTop: 16 }}>
            <Progress
              data-database-import-progress="true"
              percent={Math.round(progressPercent)}
              status={completedWithErrors ? 'normal' : resolveProgressStatus(state.status)}
              strokeColor={state.status === 'cancelled' || completedWithErrors ? warningColor : undefined}
            />
            <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <Text data-database-import-stage="true" type="secondary">{stageText}</Text>
              <Text type="secondary">
                {t('data_import.workbench.progress.statements', {
                  executed: state.executed,
                  failed: state.failed,
                  total: state.total,
                })}
              </Text>
            </div>
            {transferMetrics ? (
              <Text
                data-database-import-transfer-metrics="true"
                type="secondary"
                style={{ display: 'block', marginTop: 6, fontSize: 12 }}
              >
                {transferMetrics}
              </Text>
            ) : null}
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
            message={<div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{state.message}</div>}
          />
        ) : null}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
          {canCancelExecution ? (
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
              loading={executionPending}
              disabled={executionPending || !connectionConfig || !String(filePath || '').trim()}
              onClick={requestStartImport}
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
