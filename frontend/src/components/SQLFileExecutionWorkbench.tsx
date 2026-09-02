import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Progress, Typography } from 'antd';
import {
  ClockCircleOutlined,
  FileTextOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';

import {
  CancelSQLFileExecution,
  DataImportCapability as LoadDataImportCapability,
  ImportDatabaseSQLWithOptions,
  PreflightDatabaseSQLImport,
} from '../../wailsjs/go/app/App';
import { useStore } from '../store';
import type { TabData } from '../types';
import { t as defaultTranslate } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { confirmProductionRisk } from '../utils/productionRiskConfirm';
import { invokeAppWithSignal } from '../utils/webRpc';
import { resolveConnectionHostSummary } from '../utils/tabDisplay';
import { formatExportElapsed, resolveExportElapsedMs } from '../utils/exportProgress';
import { resolveDataImportCapabilityReasonKey } from './dataImportCapability';
import {
  loadDataImportPreferences,
  saveDataImportPreferences,
} from './dataImportPreferences';
import {
  useSQLFileExecutionRunner,
  type SQLFileExecutionRunnerStatus,
  type SQLFileExecutionState,
} from './useSQLFileExecutionRunner';
import Modal from './common/ResizableDraggableModal';
import {
  requestMySQLGTIDImportMode,
  type MySQLGTIDImportMode,
} from './MySQLGTIDImportModePrompt';

const { Paragraph, Text, Title } = Typography;
const t = defaultTranslate;

type SQLFileExecutionHistoryEntry = SQLFileExecutionState & {
  requestKey: string;
};

const EMPTY_HISTORY: SQLFileExecutionHistoryEntry[] = [];
const LOCALIZED_IMPORT_STAGES = new Set([
  'prepare',
  'preflight',
  'read',
  'parse',
  'write',
  'finalize',
]);

const formatDateTime = (timestamp: number, locale: string): string => {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return '-';
  }
  return new Date(timestamp).toLocaleString(locale, { hour12: false });
};

const getFileName = (filePath: string): string => {
  const parts = String(filePath || '').split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
};

type SQLFileExecutionStatusMeta = {
  label: string;
  border: string;
  bg: string;
  text: string;
};

const resolvePreferenceStorage = (): Storage | null => {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
};

const resolveStatusMeta = (status: SQLFileExecutionRunnerStatus): SQLFileExecutionStatusMeta => {
  const meta: Record<SQLFileExecutionRunnerStatus, SQLFileExecutionStatusMeta> = {
    idle: {
      label: t('sidebar.sql_file_exec.workbench.empty.not_started'),
      border: 'var(--gn-br-2, rgba(148, 163, 184, 0.35))',
      bg: 'var(--gn-bg-subtle, rgba(148, 163, 184, 0.12))',
      text: 'var(--gn-fg-2, #475467)',
    },
    start: {
      label: t('sidebar.sql_file_exec.workbench.stage.preparing'),
      border: 'color-mix(in srgb, var(--gn-info, #3b82f6) 30%, transparent)',
      bg: 'var(--gn-info-soft, rgba(59, 130, 246, 0.12))',
      text: 'var(--gn-info, #1d4ed8)',
    },
    running: {
      label: t('sidebar.sql_file_exec.status.running'),
      border: 'color-mix(in srgb, var(--gn-status-connected, #10b981) 30%, transparent)',
      bg: 'color-mix(in srgb, var(--gn-status-connected, #10b981) 14%, transparent)',
      text: 'var(--gn-status-connected, #047857)',
    },
    stopping: {
      label: t('sidebar.sql_file_exec.status.stopping'),
      border: 'color-mix(in srgb, var(--gn-warn, #f97316) 30%, transparent)',
      bg: 'var(--gn-warn-soft, rgba(249, 115, 22, 0.12))',
      text: 'var(--gn-warn, #c2410c)',
    },
    done: {
      label: t('sidebar.sql_file_exec.status.done'),
      border: 'color-mix(in srgb, var(--gn-status-connected, #22c55e) 30%, transparent)',
      bg: 'color-mix(in srgb, var(--gn-status-connected, #22c55e) 14%, transparent)',
      text: 'var(--gn-status-connected, #15803d)',
    },
    cancelled: {
      label: t('sidebar.sql_file_exec.status.cancelled'),
      border: 'color-mix(in srgb, var(--gn-warn, #f97316) 30%, transparent)',
      bg: 'var(--gn-warn-soft, rgba(249, 115, 22, 0.12))',
      text: 'var(--gn-warn, #c2410c)',
    },
    error: {
      label: t('sidebar.sql_file_exec.status.error'),
      border: 'color-mix(in srgb, var(--gn-danger, #ef4444) 32%, transparent)',
      bg: 'color-mix(in srgb, var(--gn-danger, #ef4444) 12%, transparent)',
      text: 'var(--gn-danger, #dc2626)',
    },
  };
  return meta[status];
};

const renderStatusPill = (meta: SQLFileExecutionStatusMeta) => {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '4px 10px',
        borderRadius: 999,
        border: `1px solid ${meta.border}`,
        background: meta.bg,
        color: meta.text,
        fontSize: 12,
        lineHeight: 1.2,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {meta.label}
    </span>
  );
};

const formatExecutionSummary = (executed: number, failed: number): string =>
  `${t('sidebar.sql_file_exec.executed_label')}${executed.toLocaleString()}${t('sidebar.sql_file_exec.statements_separator')}${failed.toLocaleString()}${t('sidebar.sql_file_exec.statements_suffix')}`;

const resolveProgressStatus = (status: SQLFileExecutionRunnerStatus): 'active' | 'success' | 'exception' | 'normal' => {
  if (status === 'done') return 'success';
  if (status === 'error') return 'exception';
  if (status === 'start' || status === 'running' || status === 'stopping') return 'active';
  return 'normal';
};

const resolveStageLabel = (
  stage: string,
  status: SQLFileExecutionRunnerStatus,
): string => {
  const normalizedStage = String(stage || '').trim();
  if (LOCALIZED_IMPORT_STAGES.has(normalizedStage)) {
    return t(`import_preview.stage.${normalizedStage}`);
  }
  return normalizedStage || resolveStatusMeta(status).label;
};

const SQLFileExecutionWorkbench: React.FC<{ tab: TabData }> = ({ tab }) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? defaultTranslate;
  const locale = i18n?.language ?? 'zh-CN';
  const connections = useStore((state) => state.connections);
  const theme = useStore((state) => state.theme);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [historyEntries, setHistoryEntries] = useState<SQLFileExecutionHistoryEntry[]>(EMPTY_HISTORY);
  const [capabilityRequestToken, setCapabilityRequestToken] = useState(0);
  const [executionPending, setExecutionPending] = useState(false);
  const [preflightError, setPreflightError] = useState('');
  const executionRPCAbortRef = useRef<AbortController | null>(null);
  const [capabilityState, setCapabilityState] = useState<{
    status: 'idle' | 'loading' | 'ready' | 'error';
    supported: boolean;
    supportsContinue: boolean;
    reason: string;
  }>({ status: 'idle', supported: false, supportsContinue: false, reason: '' });
  const [continueOnErrorPreference, setContinueOnErrorPreference] = useState(() => (
    loadDataImportPreferences(resolvePreferenceStorage(), 'database').continueOnError
  ));
  const lastRequestKeyRef = useRef('');
  const darkMode = theme === 'dark';
  const shellBg = `var(--gn-bg-panel-2, ${darkMode ? '#101319' : '#f5f7fb'})`;
  const panelBg = `var(--gn-bg-panel, ${darkMode ? '#161b22' : '#ffffff'})`;
  const panelBorder = `1px solid var(--gn-br-1, ${darkMode
    ? 'rgba(255,255,255,0.08)'
    : 'rgba(15,23,42,0.08)'})`;
  const dividerColor = `var(--gn-br-1, ${darkMode
    ? 'rgba(255,255,255,0.08)'
    : 'rgba(15,23,42,0.08)'})`;
  const headingColor = `var(--gn-fg-1, ${darkMode ? 'rgba(255,255,255,0.96)' : '#101828'})`;
  const secondaryTextColor = `var(--gn-fg-3, ${darkMode ? 'rgba(255,255,255,0.68)' : '#667085'})`;
  const subtleBg = `var(--gn-bg-subtle, var(--gn-bg-panel-2, ${darkMode
    ? 'rgba(255,255,255,0.04)'
    : '#f8fafc'}))`;
  const connection = useMemo(
    () => connections.find((item) => item.id === String(tab.connectionId || '').trim()),
    [connections, tab.connectionId],
  );
  const connectionConfig = useMemo(
    () => (connection ? buildRpcConnectionConfig(connection.config) : null),
    [connection],
  );
  const connectionConfigKey = useMemo(
    () => JSON.stringify(connectionConfig || null),
    [connectionConfig],
  );
  const hostSummary = useMemo(
    () => resolveConnectionHostSummary(connection?.config),
    [connection?.config],
  );
  const displayFileName = String(tab.sqlFileExecutionFileName || '').trim()
    || getFileName(String(tab.filePath || '').trim());
  const { state, reset, cancelExecution, runSQLFileExecutionWithProgress, isRunning } = useSQLFileExecutionRunner({
    showToast: true,
  });
  const displayFileReference = String(tab.sqlFileExecutionFileName || '').trim()
    || state.filePath
    || tab.filePath
    || '-';
  const terminal = state.status === 'done'
    || state.status === 'cancelled'
    || state.status === 'error';

  useEffect(() => () => {
    executionRPCAbortRef.current?.abort();
    executionRPCAbortRef.current = null;
  }, []);
  const completedWithErrors = state.status === 'done' && state.failed > 0;
  const capabilityAllowsExecution = capabilityState.status === 'ready'
    && capabilityState.supported;
  const capabilityAllowsContinue = capabilityAllowsExecution && capabilityState.supportsContinue;
  const continueOnError = capabilityAllowsContinue && continueOnErrorPreference;
  const capabilityReason = capabilityState.status === 'loading'
    ? 'loading'
    : capabilityState.status === 'error'
      ? 'rpc_failed'
      : capabilityState.status === 'ready' && !capabilityState.supported
        ? (capabilityState.reason || 'capability_unavailable')
        : '';
  const capabilityMessageKey = capabilityReason === 'loading'
    ? 'data_import.capability.loading'
    : capabilityReason === 'rpc_failed'
      ? 'data_import.capability.rpc_failed'
      : capabilityReason
        ? resolveDataImportCapabilityReasonKey(capabilityReason)
        : '';

  useEffect(() => {
    if (!connectionConfig) {
      setCapabilityState({ status: 'idle', supported: false, supportsContinue: false, reason: '' });
      return undefined;
    }
    let active = true;
    setCapabilityState({ status: 'loading', supported: false, supportsContinue: false, reason: '' });
    void Promise.resolve()
      .then(() => LoadDataImportCapability(connectionConfig as any))
      .then((capability) => {
        if (!active) return;
        const sqlFileImport = capability?.sqlFileImport;
        setCapabilityState({
          status: 'ready',
          supported: sqlFileImport?.supported === true,
          supportsContinue: sqlFileImport?.supportsContinue === true,
          reason: String(sqlFileImport?.reason || ''),
        });
      })
      .catch(() => {
        if (!active) return;
        setCapabilityState({ status: 'error', supported: false, supportsContinue: false, reason: 'capability_unavailable' });
      });
    return () => {
      active = false;
    };
  }, [capabilityRequestToken, connectionConfigKey]);

  useEffect(() => {
    if (!state.startedAt || state.finishedAt > 0) {
      return undefined;
    }
    const timer = globalThis.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);
    return () => {
      globalThis.clearInterval(timer);
    };
  }, [state.finishedAt, state.startedAt]);

  useEffect(() => {
    if (!state.jobId) {
      return;
    }
    if (state.status !== 'done' && state.status !== 'cancelled' && state.status !== 'error') {
      return;
    }
    setHistoryEntries((prev) => [
      {
        ...state,
        requestKey: String(tab.sqlFileExecutionRequestKey || '').trim(),
      },
      ...prev.filter((entry) => entry.jobId !== state.jobId),
    ].slice(0, 10));
  }, [state, tab.sqlFileExecutionRequestKey]);

  const updateContinueOnError = useCallback((nextValue: boolean) => {
    setContinueOnErrorPreference(nextValue);
    const storage = resolvePreferenceStorage();
    const preferences = loadDataImportPreferences(storage, 'database');
    saveDataImportPreferences(storage, 'database', {
      ...preferences,
      continueOnError: nextValue,
    });
  }, []);

  const statusMeta = (status: SQLFileExecutionRunnerStatus, failed: number): SQLFileExecutionStatusMeta => {
    if (status === 'done' && failed > 0) {
      return {
        label: t('data_import.workbench.state.completed_with_errors'),
        border: 'color-mix(in srgb, var(--gn-warn, #f97316) 30%, transparent)',
        bg: 'var(--gn-warn-soft, rgba(249, 115, 22, 0.12))',
        text: 'var(--gn-warn, #c2410c)',
      };
    }
    return resolveStatusMeta(status);
  };

  const startExecution = React.useCallback(async () => {
    const filePath = String(tab.filePath || '').trim();
    if (!connectionConfig || !filePath || !capabilityAllowsExecution || executionPending || isRunning) {
      return;
    }
    setExecutionPending(true);
    setPreflightError('');
    try {
      const approved = await confirmProductionRisk({
        connection,
        action: t('connection.production_risk.action.execute_sql'),
        target: [tab.dbName, displayFileName].filter(Boolean).join(' / '),
        translate: t,
      });
      if (!approved) return;

      let mysqlGTIDMode: MySQLGTIDImportMode = 'reject';
      const preflightResult = await PreflightDatabaseSQLImport(
        connectionConfig as any,
        String(tab.dbName || '').trim(),
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

      await runSQLFileExecutionWithProgress({
        title: tab.title || t('sidebar.sql_file_exec.title'),
        filePath,
        fileSizeMB: tab.sqlFileExecutionFileSizeMB,
        run: async (jobId) => {
          executionRPCAbortRef.current?.abort();
          const controller = new AbortController();
          executionRPCAbortRef.current = controller;
          const args = [
            connectionConfig,
            String(tab.dbName || '').trim(),
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
              String(tab.dbName || '').trim(),
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
    } finally {
      setExecutionPending(false);
    }
  }, [
    capabilityAllowsExecution,
    connection,
    connectionConfig,
    continueOnError,
    displayFileName,
    executionPending,
    isRunning,
    runSQLFileExecutionWithProgress,
    tab.dbName,
    tab.filePath,
    tab.sqlFileExecutionFileSizeMB,
    tab.title,
    t,
  ]);

  const requestStartExecution = React.useCallback(() => {
    if (!terminal) {
      void startExecution();
      return;
    }
    Modal.confirm({
      title: t('data_import.workbench.confirm.rerun_title'),
      content: t('data_import.workbench.confirm.rerun_content'),
      okText: t('data_import.workbench.action.retry_database_import'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: startExecution,
    });
  }, [startExecution, terminal]);

  useEffect(() => {
    const requestKey = String(tab.sqlFileExecutionRequestKey || '').trim();
    if (!requestKey || requestKey === lastRequestKeyRef.current) {
      return;
    }
    if (!connectionConfig || !String(tab.filePath || '').trim() || !capabilityAllowsExecution) {
      return;
    }
    lastRequestKeyRef.current = requestKey;
    void startExecution();
  }, [capabilityAllowsExecution, connectionConfig, startExecution, tab.filePath, tab.sqlFileExecutionRequestKey]);

  const currentElapsedMs = useMemo(
    () => resolveExportElapsedMs(state.startedAt, state.finishedAt, nowTick),
    [nowTick, state.finishedAt, state.startedAt],
  );
  const progressPercent = Math.max(0, Math.min(100, Number(state.percent) || 0));
  const currentSummary = formatExecutionSummary(state.executed, state.failed);
  const historyList = useMemo(
    () => historyEntries.filter((entry) => entry.jobId !== state.jobId),
    [historyEntries, state.jobId],
  );

  return (
    <div
      data-sql-file-execution-workbench="true"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: shellBg,
        color: headingColor,
      }}
    >
      <div style={{ padding: '18px 22px 10px' }}>
        <Title level={4} style={{ margin: 0, color: headingColor }}>
          {t('sidebar.sql_file_exec.title')}
        </Title>
        <div style={{ marginTop: 6, color: secondaryTextColor, fontSize: 13 }}>
          {t('sidebar.sql_file_exec.workbench.helper.auto_run')}
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(280px, 360px) minmax(0, 1fr)',
          gap: 20,
          padding: '0 22px 22px',
          flex: 1,
          minHeight: 0,
        }}
      >
        <section
          style={{
            padding: 20,
            borderRadius: 8,
            background: panelBg,
            border: panelBorder,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            minHeight: 0,
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: headingColor, marginBottom: 10 }}>
              {t('sidebar.sql_file_exec.workbench.section.config')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '96px minmax(0, 1fr)', rowGap: 8, columnGap: 10 }}>
              <Text type="secondary">{t('data_export.label.connection')}</Text>
              <Text>{connection?.name || '-'}</Text>

              <Text type="secondary">{t('data_export.label.database')}</Text>
              <Text>{tab.dbName || '-'}</Text>

              <Text type="secondary">{t('sidebar.sql_file_exec.workbench.label.file_path')}</Text>
              <Paragraph style={{ marginBottom: 0, wordBreak: 'break-all' }}>
                {tab.sqlFileExecutionFileName || tab.filePath || '-'}
              </Paragraph>

              <Text type="secondary">{t('sidebar.sql_file_exec.file_size').replace(/[:：]\s*$/, '')}</Text>
              <Text>{tab.sqlFileExecutionFileSizeMB ? `${tab.sqlFileExecutionFileSizeMB} MB` : '-'}</Text>

              <Text type="secondary">{t('data_export.label.host')}</Text>
              <Text>{hostSummary || '-'}</Text>

              <Text type="secondary">{t('data_import.workbench.error_policy.title')}</Text>
              <div style={{ display: 'grid', gap: 4 }}>
                <Checkbox
                  data-sql-file-execution-continue-on-error="true"
                  checked={continueOnError}
                  disabled={isRunning || executionPending || !capabilityAllowsContinue}
                  onChange={(event) => {
                    if (capabilityAllowsContinue) {
                      updateContinueOnError(event.target.checked);
                    }
                  }}
                >
                  {t('data_import.workbench.error_policy.continue')}
                </Checkbox>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {continueOnError
                    ? t('data_import.workbench.error_policy.continue_description')
                    : t('data_import.workbench.error_policy.stop_description')}
                </Text>
              </div>
            </div>
          </div>

          {!connectionConfig ? (
            <Alert
              type="warning"
              showIcon
              message={t('sidebar.message.connection_config_not_found')}
            />
          ) : null}

          {capabilityReason ? (
            <Alert
              data-sql-file-execution-capability-alert="true"
              data-sql-file-execution-capability-reason={capabilityReason}
              type={capabilityReason === 'loading' ? 'info' : 'error'}
              showIcon
              message={t(capabilityMessageKey)}
              action={capabilityReason === 'rpc_failed' ? (
                <Button
                  data-sql-file-execution-capability-retry="true"
                  type="link"
                  size="small"
                  onClick={() => setCapabilityRequestToken((current) => current + 1)}
                >
                  {t('common.retry')}
                </Button>
              ) : undefined}
            />
          ) : null}

          {preflightError ? (
            <Alert
              data-sql-file-execution-preflight-error="true"
              type="error"
              showIcon
              message={preflightError}
            />
          ) : null}

          <div
            style={{
              marginTop: 'auto',
              padding: 14,
              borderRadius: 8,
              background: subtleBg,
              border: `1px solid ${dividerColor}`,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ fontSize: 12, color: secondaryTextColor }}>
              {t('sidebar.sql_file_exec.workbench.helper.reuse')}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {isRunning ? (
                <Button
                  danger
                  icon={<StopOutlined />}
                  loading={state.status === 'stopping'}
                  disabled={state.status === 'stopping'}
                  onClick={() => {
                    void cancelExecution().catch(() => undefined);
                  }}
                >
                  {t('sidebar.sql_file_exec.cancel')}
                </Button>
              ) : (
                <Button
                  data-sql-file-execution-run-action="true"
                  type="primary"
                  icon={state.status === 'idle' ? <FileTextOutlined /> : <ReloadOutlined />}
                  disabled={!connectionConfig
                    || !String(tab.filePath || '').trim()
                    || executionPending
                    || !capabilityAllowsExecution}
                  onClick={requestStartExecution}
                >
                  {terminal
                    ? t('data_import.workbench.action.retry_database_import')
                    : state.status === 'idle'
                      ? t('query.run')
                      : t('sidebar.sql_file_exec.workbench.action.run_again')}
                </Button>
              )}
              {(state.status === 'done' || state.status === 'cancelled' || state.status === 'error') ? (
                <Button icon={<ReloadOutlined />} onClick={reset}>
                  {t('data_export.action.clear_progress')}
                </Button>
              ) : null}
            </div>
          </div>
        </section>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0, minHeight: 0 }}>
          <section
            style={{
              padding: 20,
              borderRadius: 8,
              background: panelBg,
              border: panelBorder,
              display: 'flex',
              flexDirection: 'column',
              gap: 18,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: headingColor }}>
                    {t('data_export.workbench.section.current_task')}
                  </div>
                  {renderStatusPill(statusMeta(state.status, state.failed))}
                </div>
                <Title level={5} style={{ margin: '10px 0 0', color: headingColor }}>
                  {state.title || tab.title || t('sidebar.sql_file_exec.title')}
                </Title>
                <div style={{ marginTop: 6, color: secondaryTextColor, fontSize: 13 }}>
                  {state.jobId ? `${displayFileReference} · ${currentSummary}` : t('sidebar.sql_file_exec.workbench.description.current_task_empty')}
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
                  <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 4 }}>
                    {t('sidebar.sql_file_exec.workbench.label.elapsed')}
                  </div>
                  <div style={{ color: headingColor, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <ClockCircleOutlined />
                    {state.startedAt ? formatExportElapsed(currentElapsedMs) : '--:--'}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 4 }}>
                    {t('sidebar.sql_file_exec.workbench.label.started_at')}
                  </div>
                  <div style={{ color: headingColor, fontWeight: 600 }}>{formatDateTime(state.startedAt, locale)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 4 }}>
                    {t('sidebar.sql_file_exec.workbench.label.file_path')}
                  </div>
                  <div style={{ color: headingColor, fontWeight: 600, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {displayFileReference}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 4 }}>
                    {t('sidebar.sql_file_exec.workbench.label.progress_summary')}
                  </div>
                  <div style={{ color: headingColor, fontWeight: 600 }}>{state.jobId ? currentSummary : '-'}</div>
                </div>
              </div>
            </div>

            {state.jobId ? (
              <>
                <div>
                  <Progress
                    data-sql-file-execution-progress="true"
                    percent={Math.round(progressPercent)}
                    status={completedWithErrors ? 'normal' : resolveProgressStatus(state.status)}
                    strokeColor={state.status === 'cancelled' || completedWithErrors
                      ? 'var(--gn-warn, #faad14)'
                      : undefined}
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 0.9fr)', gap: 18 }}>
                  <div>
                    <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 6 }}>
                      {t('sidebar.sql_file_exec.workbench.label.current_stage')}
                    </div>
                    <Text data-sql-file-execution-current-stage="true">
                      {resolveStageLabel(state.stage, state.status)}
                    </Text>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 6 }}>
                      {t('sidebar.sql_file_exec.workbench.label.file_path')}
                    </div>
                    <Paragraph style={{ marginBottom: 0, wordBreak: 'break-all' }}>
                      {displayFileReference}
                    </Paragraph>
                  </div>
                </div>

                {state.currentSQL ? (
                  <div>
                    <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 6 }}>
                      {t('sidebar.sql_file_exec.workbench.label.current_sql')}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: secondaryTextColor,
                        background: subtleBg,
                        borderRadius: 8,
                        padding: '10px 12px',
                        fontFamily: 'var(--gn-font-mono)',
                        wordBreak: 'break-all',
                        maxHeight: 96,
                        overflow: 'auto',
                      }}
                    >
                      {state.currentSQL}
                    </div>
                  </div>
                ) : null}

                {state.message ? (
                  <Alert
                    type={state.status === 'error'
                      ? 'error'
                      : state.status === 'cancelled' || completedWithErrors
                        ? 'warning'
                        : 'info'}
                    showIcon
                    message={state.message}
                  />
                ) : null}
              </>
            ) : (
              <div>
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={t('sidebar.sql_file_exec.workbench.empty.not_started')}
                />
              </div>
            )}
          </section>

          <section
            style={{
              padding: 20,
              borderRadius: 8,
              background: panelBg,
              border: panelBorder,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              minHeight: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: headingColor }}>
                  {t('data_export.workbench.section.history')}
                </div>
                <div style={{ marginTop: 4, fontSize: 12, color: secondaryTextColor }}>
                  {t('sidebar.sql_file_exec.workbench.empty.history')}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ color: secondaryTextColor, fontSize: 12 }}>
                  {historyList.length.toLocaleString()}
                </div>
                {historyList.length > 0 ? (
                  <Button size="small" type="text" onClick={() => setHistoryEntries(EMPTY_HISTORY)}>
                    {t('sidebar.sql_file_exec.workbench.action.clear_history')}
                  </Button>
                ) : null}
              </div>
            </div>

            {historyList.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
                {historyList.map((entry, index) => {
                  const elapsed = formatExportElapsed(resolveExportElapsedMs(entry.startedAt, entry.finishedAt, nowTick));
                  return (
                    <div
                      key={entry.jobId}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(0, 1fr) minmax(260px, 0.85fr)',
                        gap: 18,
                        padding: '14px 0',
                        borderTop: index === 0 ? 'none' : `1px solid ${dividerColor}`,
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <Text strong>{entry.title || tab.title}</Text>
                          {renderStatusPill(statusMeta(entry.status, entry.failed))}
                          <span style={{ fontSize: 12, color: secondaryTextColor }}>
                            {formatExecutionSummary(entry.executed, entry.failed)}
                          </span>
                        </div>
                        <div style={{ marginTop: 6, fontSize: 13, color: headingColor }}>
                          {resolveStageLabel(entry.stage, entry.status)}
                        </div>
                        {entry.message ? (
                          <div style={{
                            marginTop: 8,
                            fontSize: 12,
                            color: entry.status === 'error'
                              ? 'var(--gn-danger, #dc2626)'
                              : entry.status === 'done' && entry.failed > 0
                                ? 'var(--gn-warn, #c2410c)'
                                : secondaryTextColor,
                            whiteSpace: 'pre-wrap',
                          }}>
                            {entry.message}
                          </div>
                        ) : null}
                      </div>

                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '84px minmax(0, 1fr)', rowGap: 6, columnGap: 10 }}>
                          <Text type="secondary">{t('sidebar.sql_file_exec.workbench.label.started_at')}</Text>
                          <Text>{formatDateTime(entry.startedAt, locale)}</Text>

                          <Text type="secondary">{t('sidebar.sql_file_exec.workbench.label.elapsed')}</Text>
                          <Text>{elapsed}</Text>

                          <Text type="secondary">{t('sidebar.sql_file_exec.workbench.label.file_path')}</Text>
                          <Paragraph style={{ marginBottom: 0, wordBreak: 'break-all' }}>
                            {tab.sqlFileExecutionFileName || entry.filePath || '-'}
                          </Paragraph>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ padding: '6px 0 2px', color: secondaryTextColor, fontSize: 13 }}>
                {t('sidebar.sql_file_exec.workbench.empty.history')}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

export default SQLFileExecutionWorkbench;
