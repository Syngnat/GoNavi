import React, { useEffect, useId, useRef, useState } from 'react';
import { Spin } from 'antd';
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import type {
  ScriptAuditEntry,
  ScriptLogEntry,
  ScriptOutputPage,
  ScriptRunProgress,
  ScriptRunResult,
  ScriptRunStatus,
} from './scriptWorkbenchTypes';
import {
  SCRIPT_MAX_LOG_ENTRIES,
  SCRIPT_MAX_OUTPUT_STREAMS,
} from './scriptWorkbenchTypes';
import type { ScriptWorkbenchTranslate } from './useScriptWorkbenchCopy';
import { formatScriptDuration } from './scriptWorkbenchUtils';
import { ScriptResultCell } from './ScriptResultCell';

type ResultTabId = 'results' | 'logs' | 'audit';

interface ScriptWorkbenchResultsProps {
  status: ScriptRunStatus;
  progress: ScriptRunProgress | null;
  result: ScriptRunResult | null;
  outputs: ScriptOutputPage[];
  selectedOutputId: string | null;
  logs: ScriptLogEntry[];
  audits: ScriptAuditEntry[];
  auditsTruncated?: boolean;
  logsTruncated?: boolean;
  outputsTruncated?: boolean;
  pageLoading: boolean;
  errorMessage?: string;
  t: ScriptWorkbenchTranslate;
  onSelectOutput: (outputId: string) => void;
  onPageChange: (outputId: string, page: number) => void;
}

const formatClock = (timestamp: number): string => (
  new Date(timestamp).toLocaleTimeString([], { hour12: false })
);

const statusIcon = (status: ScriptRunStatus) => {
  if (status === 'completed') return <CheckCircleOutlined aria-hidden="true" />;
  if (
    status === 'failed'
    || status === 'cancelled'
    || status === 'timed_out'
    || status === 'memory_exceeded'
    || status === 'outcome_unknown'
  ) {
    return <CloseCircleOutlined aria-hidden="true" />;
  }
  if (status === 'running' || status === 'preparing' || status === 'cancelling') return <LoadingOutlined aria-hidden="true" />;
  return null;
};

export const ScriptWorkbenchResults: React.FC<ScriptWorkbenchResultsProps> = ({
  status,
  progress,
  result,
  outputs,
  selectedOutputId,
  logs,
  audits,
  auditsTruncated = false,
  logsTruncated = false,
  outputsTruncated = false,
  pageLoading,
  errorMessage = '',
  t,
  onSelectOutput,
  onPageChange,
}) => {
  const [activeTab, setActiveTab] = useState<ResultTabId>('results');
  const id = useId();
  const tabRefs = useRef<Partial<Record<ResultTabId, HTMLButtonElement | null>>>({});
  const output = outputs.find((candidate) => candidate.outputId === selectedOutputId)
    || outputs[0]
    || null;
  const tabs: Array<{ id: ResultTabId; label: string; count?: number }> = [
    { id: 'results', label: t('script_workbench.tab.results'), count: output?.totalRows },
    { id: 'logs', label: t('script_workbench.tab.logs'), count: logs.length },
    { id: 'audit', label: t('script_workbench.tab.audit'), count: audits.length },
  ];
  const selectRelativeTab = (event: React.KeyboardEvent, index: number) => {
    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    const next = tabs[nextIndex];
    setActiveTab(next.id);
    tabRefs.current[next.id]?.focus();
  };
  const progressValue = progress?.total
    ? Math.min(progress.current, progress.total)
    : progress?.current || 0;
  const showProgress = status === 'running' || status === 'preparing' || status === 'cancelling';
  const hasKnownProgressTotal = Boolean(progress?.total && progress.total > 0);
  const progressPercent = hasKnownProgressTotal
    ? Math.max(0, Math.min(100, (progressValue / (progress?.total || 1)) * 100))
    : 0;
  const page = output?.page || 1;
  const pageSize = output?.pageSize || 100;
  const pageCount = output ? Math.max(1, Math.ceil(output.totalRows / pageSize)) : 1;
  const externalError = String(errorMessage || '').trim();
  const hasFailure = Boolean(externalError || (result && !result.success));
  const failureStatus = externalError
    ? t('script_workbench.error.operation_failed')
    : result?.timedOut
    ? t('script_workbench.status.timed_out')
    : result?.memoryExceeded
      ? t('script_workbench.status.memory_exceeded')
      : result?.outcomeUnknown
        ? t('script_workbench.error.outcome_unknown')
        : result?.cancelled
          ? t('script_workbench.status.cancelled')
          : t('script_workbench.status.failed');
  const failureDetail = externalError || (result?.cancelled
    ? ''
    : (result?.message || '').trim());

  useEffect(() => {
    if (hasFailure) setActiveTab('results');
  }, [hasFailure]);

  return (
    <section className="gn-script-results-card" aria-label={t('script_workbench.results.title')}>
      <header className="gn-script-results-header">
        <div className="gn-script-result-tabs" role="tablist" aria-label={t('script_workbench.results.title')}>
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              ref={(node) => { tabRefs.current[tab.id] = node; }}
              id={`${id}-${tab.id}-tab`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`${id}-${tab.id}-panel`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(event) => selectRelativeTab(event, index)}
            >
              {tab.label}
              {tab.count ? <span>{tab.count}</span> : null}
            </button>
          ))}
        </div>
        <div className={`gn-script-run-status is-${status}`} aria-live="polite">
          {statusIcon(status)}
          <strong>{t(`script_workbench.status.${status}`)}</strong>
          {progress?.elapsedMs ? <span>{formatScriptDuration(progress.elapsedMs)}</span> : null}
        </div>
      </header>
      {showProgress ? (
        <div className="gn-script-progress-row">
          <div
            className="gn-script-progress-track"
            role="progressbar"
            aria-label={t('script_workbench.progress.label')}
            aria-valuemin={0}
            aria-valuemax={hasKnownProgressTotal ? progress?.total : undefined}
            aria-valuenow={hasKnownProgressTotal ? progressValue : undefined}
          >
            <span
              className={`gn-script-progress-fill${hasKnownProgressTotal ? '' : ' is-indeterminate'}`}
              style={hasKnownProgressTotal ? { width: `${progressPercent}%` } : undefined}
            />
          </div>
          <span>
            {progress
              ? t('script_workbench.progress.processed', {
                current: progress.current,
                total: progress.total || '?',
              })
              : t('script_workbench.progress.waiting')}
          </span>
          {progress?.message ? <span className="gn-script-progress-message">{progress.message}</span> : null}
        </div>
      ) : null}
      <div
        id={`${id}-results-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-results-tab`}
        aria-label={t('script_workbench.tab.results')}
        hidden={activeTab !== 'results'}
        className="gn-script-result-panel"
      >
        {hasFailure ? (
          <div
            className={`gn-script-result-failure${result?.cancelled ? ' is-cancelled' : result?.timedOut || result?.outcomeUnknown ? ' is-warning' : ' is-error'}${output ? '' : ' is-standalone'}`}
            role="status"
          >
            <CloseCircleOutlined aria-hidden="true" />
            <strong>{failureStatus}</strong>
            {failureDetail && failureDetail !== failureStatus ? <span>{failureDetail}</span> : null}
          </div>
        ) : null}
        {outputsTruncated ? (
          <div className="gn-script-result-truncated" role="status">
            {t('script_workbench.results.outputs_truncated', {
              count: SCRIPT_MAX_OUTPUT_STREAMS,
            })}
          </div>
        ) : null}
        {output ? (
          <>
            {outputs.length > 1 ? (
              <label className="gn-script-output-select">
                <span>{t('script_workbench.results.output_label')}</span>
                <select
                  value={output.outputId}
                  onChange={(event) => onSelectOutput(event.target.value)}
                >
                  {outputs.map((candidate, index) => (
                    <option key={candidate.outputId} value={candidate.outputId}>
                      {candidate.name || t('script_workbench.results.output_option', { index: index + 1 })}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div
              className="gn-script-table-region"
              role="region"
              tabIndex={0}
              aria-label={t('script_workbench.results.caption', { name: output.name })}
            >
              <table className="gn-script-result-table">
                <caption>{t('script_workbench.results.caption', { name: output.name })}</caption>
                <thead>
                  <tr>
                    {output.columns.map((column) => <th key={column} scope="col">{column}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {output.rows.map((row, rowIndex) => (
                    <tr key={`${page}:${rowIndex}`}>
                      {output.columns.map((column) => (
                        <td key={column} data-label={column}>
                          <ScriptResultCell value={row[column]} t={t} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="gn-script-result-pagination">
              <span>{t('script_workbench.results.page_summary', { page, pages: pageCount, rows: output.totalRows })}</span>
              {output.truncated ? <span>{t('script_workbench.results.truncated')}</span> : null}
              <button
                type="button"
                className="gn-script-icon-button"
                aria-label={t('script_workbench.results.prev')}
                disabled={page <= 1 || pageLoading}
                onClick={() => onPageChange(output.outputId, page - 1)}
              >
                <ArrowLeftOutlined aria-hidden="true" />
              </button>
              <button
                type="button"
                className="gn-script-icon-button"
                aria-label={t('script_workbench.results.next')}
                disabled={page >= pageCount || pageLoading}
                onClick={() => onPageChange(output.outputId, page + 1)}
              >
                {pageLoading ? <Spin size="small" /> : <ArrowRightOutlined aria-hidden="true" />}
              </button>
            </div>
          </>
        ) : !hasFailure ? (
          <div className="gn-script-result-empty">
            <strong>{t('script_workbench.results.empty')}</strong>
            <span>{t('script_workbench.results.empty_hint')}</span>
          </div>
        ) : null}
      </div>
      <div
        id={`${id}-logs-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-logs-tab`}
        aria-label={t('script_workbench.tab.logs')}
        hidden={activeTab !== 'logs'}
        className="gn-script-result-panel gn-script-log-panel"
      >
        {logsTruncated ? (
          <div className="gn-script-result-truncated" role="status">
            {t('script_workbench.logs.truncated', { count: SCRIPT_MAX_LOG_ENTRIES })}
          </div>
        ) : null}
        {logs.length ? (
          <ol>
            {logs.map((log) => (
              <li key={log.id} className={`is-${log.level}`}>
                <time>{formatClock(log.at)}</time>
                <span>{log.message}</span>
              </li>
            ))}
          </ol>
        ) : <div className="gn-script-result-empty">{t('script_workbench.logs.empty')}</div>}
      </div>
      <div
        id={`${id}-audit-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-audit-tab`}
        aria-label={t('script_workbench.tab.audit')}
        hidden={activeTab !== 'audit'}
        className="gn-script-result-panel"
      >
        {audits.length ? (
          <div className="gn-script-table-region" role="region" tabIndex={0} aria-label={t('script_workbench.audit.caption')}>
            {auditsTruncated ? (
              <div className="gn-script-audit-truncated" role="status">
                {t('script_workbench.audit.truncated')}
              </div>
            ) : null}
            <table className="gn-script-result-table gn-script-audit-table">
              <caption>{t('script_workbench.audit.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('script_workbench.audit.column.time')}</th>
                  <th scope="col">{t('script_workbench.audit.column.connection')}</th>
                  <th scope="col">{t('script_workbench.audit.column.statement')}</th>
                  <th scope="col">{t('script_workbench.audit.column.rows')}</th>
                  <th scope="col">{t('script_workbench.audit.column.duration')}</th>
                </tr>
              </thead>
              <tbody>
                {audits.map((audit) => (
                  <tr key={audit.id}>
                    <td data-label={t('script_workbench.audit.column.time')}>{formatClock(audit.at)}</td>
                    <td data-label={t('script_workbench.audit.column.connection')}>
                      {audit.connectionAlias}{audit.database ? ` · ${audit.database}` : ''}
                    </td>
                    <td data-label={t('script_workbench.audit.column.statement')}><code>{audit.sql}</code></td>
                    <td data-label={t('script_workbench.audit.column.rows')}>{audit.rowCount ?? '-'}</td>
                    <td data-label={t('script_workbench.audit.column.duration')}>{formatScriptDuration(audit.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="gn-script-result-empty">{t('script_workbench.audit.empty')}</div>}
      </div>
    </section>
  );
};
