import React from 'react';

import type {
  DataSyncCdcSourceStatus,
  DataSyncCheckpointSummary,
  DataSyncErrorRow,
  DataSyncRunRecord,
  DataSyncScheduleSummary,
} from './model';
import type { DataSyncWorkbenchTranslate } from './text';

const EmptyState: React.FC<{
  title: string;
  description: string;
}> = ({ title, description }) => (
  <div className="gn-data-sync-empty">
    <span className="gn-data-sync-empty__mark" aria-hidden="true">∅</span>
    <strong>{title}</strong>
    <p>{description}</p>
  </div>
);

const formatCdcLag = (
  lagMs: number | null,
  t: DataSyncWorkbenchTranslate,
): string =>
  lagMs === null
    ? t('cdc.lag_unknown')
    : `${Math.max(0, lagMs).toLocaleString()} ms`;

export const DataSyncRunHistory: React.FC<{
  runs: DataSyncRunRecord[];
  selectedRunId: string;
  errorRows: DataSyncErrorRow[];
  t: DataSyncWorkbenchTranslate;
  onSelectRun: (runId: string) => void;
  checkpoint: DataSyncCheckpointSummary | null;
  busyAction: string;
  onRefresh: () => void;
  onCancel: (runId: string) => void;
  onResume: (runId: string) => void;
  onRetry: (runId: string) => void;
  onDiscardErrorRow: (errorRowId: string) => void;
  errorRowRetryAvailable: boolean;
  onRetryErrorRow: (errorRowId: string) => void;
  checkpointResetEnabled: boolean;
  onResetCheckpoint: () => void;
}> = ({
  runs,
  selectedRunId,
  errorRows,
  checkpoint,
  busyAction,
  t,
  onSelectRun,
  onRefresh,
  onCancel,
  onResume,
  onRetry,
  onDiscardErrorRow,
  errorRowRetryAvailable,
  onRetryErrorRow,
  checkpointResetEnabled,
  onResetCheckpoint,
}) => (
  <section className="gn-data-sync-operational-view" data-data-sync-run-history="true">
    <header className="gn-data-sync-view-heading">
      <h1>{t('runs.title')}</h1>
      <div>
        <p>{t('runs.subtitle')}</p>
        <button
          type="button"
          className="gn-data-sync-button"
          disabled={busyAction === 'refresh-runs'}
          onClick={onRefresh}
        >
          {t('common.refresh')}
        </button>
      </div>
    </header>
    {runs.length === 0 ? (
      <EmptyState
        title={t('runs.empty_title')}
        description={t('runs.empty_desc')}
      />
    ) : (
      <div className="gn-data-sync-table-scroll">
        <table className="gn-data-sync-history-table">
          <thead>
            <tr>
              <th>{t('runs.id')}</th>
              <th>{t('runs.task')}</th>
              <th>{t('runs.status')}</th>
              <th>{t('runs.started_at')}</th>
              <th>{t('runs.rows_written')}</th>
              <th>{t('runs.rows_failed')}</th>
              <th>{t('runs.checkpoint')}</th>
              <th>{t('runs.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} data-selected={run.id === selectedRunId ? 'true' : 'false'}>
                <td className="gn-data-sync-mono">{run.id}</td>
                <td>{run.taskName}</td>
                <td>
                  <span className="gn-data-sync-state-label" data-state={run.status}>
                    {t(`status.${run.status}`)}
                  </span>
                </td>
                <td>{run.startedAt || '—'}</td>
                <td>{run.rowsWritten.toLocaleString()}</td>
                <td>{run.rowsFailed.toLocaleString()}</td>
                <td className="gn-data-sync-mono">{run.checkpoint || '—'}</td>
                <td>
                  <button
                    type="button"
                    className="gn-data-sync-link-button"
                    onClick={() => onSelectRun(run.id)}
                  >
                    {t('runs.view_errors')}
                  </button>
                  {run.status === 'queued' || run.status === 'running' ? (
                    <button
                      type="button"
                      className="gn-data-sync-link-button"
                      disabled={busyAction === `cancel:${run.id}`}
                      onClick={() => onCancel(run.id)}
                    >
                      {t('runs.cancel')}
                    </button>
                  ) : null}
                  {run.resumable ? (
                    <button
                      type="button"
                      className="gn-data-sync-link-button"
                      disabled={busyAction === `resume:${run.id}`}
                      onClick={() => onResume(run.id)}
                    >
                      {t('runs.resume')}
                    </button>
                  ) : null}
                  {['failed', 'partial', 'canceled', 'cancelled', 'interrupted'].includes(
                    run.status,
                  ) ? (
                    <button
                      type="button"
                      className="gn-data-sync-link-button"
                      disabled={busyAction === `retry:${run.id}`}
                      onClick={() => onRetry(run.id)}
                    >
                      {t('runs.retry')}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}

    <section className="gn-data-sync-error-rows" data-data-sync-error-rows="true">
      <h2>{t('errors.title')}</h2>
      {!selectedRunId || errorRows.length === 0 ? (
        <EmptyState
          title={t('errors.empty_title')}
          description={t('errors.empty_desc')}
        />
      ) : (
        <div className="gn-data-sync-table-scroll">
          <table className="gn-data-sync-history-table">
            <thead>
              <tr>
                <th>{t('errors.source')}</th>
                <th>{t('errors.reason')}</th>
                <th>{t('errors.payload')}</th>
                <th>{t('errors.retryable')}</th>
                <th>{t('runs.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {errorRows.map((row) => (
                <tr key={row.id}>
                  <td className="gn-data-sync-mono">{row.sourceObject}</td>
                  <td>{row.reason}</td>
                  <td className="gn-data-sync-mono">{row.payloadPreview}</td>
                  <td>{t(row.retryable ? 'common.yes' : 'common.no')}</td>
                  <td>
                    <button
                      type="button"
                      className="gn-data-sync-link-button"
                      disabled={
                        !errorRowRetryAvailable ||
                        !row.retryable ||
                        row.status !== 'pending' ||
                        busyAction === `retry-row:${row.id}`
                      }
                      title={
                        errorRowRetryAvailable && row.retryable
                          ? ''
                          : t('errors.retry_unavailable')
                      }
                      onClick={() => onRetryErrorRow(row.id)}
                    >
                      {t('errors.retry')}
                    </button>
                    <button
                      type="button"
                      className="gn-data-sync-link-button gn-data-sync-link-button--danger"
                      disabled={
                        row.status === 'discarded' ||
                        busyAction === `discard:${row.id}`
                      }
                      onClick={() => onDiscardErrorRow(row.id)}
                    >
                      {row.status === 'discarded'
                        ? t('errors.discarded')
                        : t('errors.discard')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
    <section className="gn-data-sync-checkpoint-panel" data-data-sync-checkpoint="true">
      <h2>{t('checkpoint.title')}</h2>
      {!selectedRunId || !checkpoint ? (
        <p>{t('checkpoint.empty')}</p>
      ) : (
        <dl>
          <div><dt>{t('checkpoint.kind')}</dt><dd>{checkpoint.kind || '—'}</dd></div>
          <div><dt>{t('checkpoint.phase')}</dt><dd>{checkpoint.phase || '—'}</dd></div>
          <div><dt>{t('checkpoint.updated_at')}</dt><dd>{checkpoint.updatedAt || '—'}</dd></div>
          <div><dt>{t('checkpoint.cursor')}</dt><dd><code>{checkpoint.cursorPreview || '—'}</code></dd></div>
        </dl>
      )}
      <button
        type="button"
        className="gn-data-sync-button gn-data-sync-button--danger"
        disabled={
          !checkpoint ||
          !checkpointResetEnabled ||
          busyAction === 'reset-checkpoint'
        }
        onClick={onResetCheckpoint}
      >
        {t('checkpoint.reset')}
      </button>
      <p>{t('checkpoint.reset_warning')}</p>
    </section>
  </section>
);

export const DataSyncScheduleView: React.FC<{
  schedules: DataSyncScheduleSummary[];
  t: DataSyncWorkbenchTranslate;
  refreshing: boolean;
  onRefresh: () => void;
  busyAction?: string;
  onToggle?: (schedule: DataSyncScheduleSummary) => void;
  onRunNow?: (schedule: DataSyncScheduleSummary) => void;
  onViewRun?: (runId: string) => void;
}> = ({
  schedules,
  t,
  refreshing,
  onRefresh,
  busyAction = '',
  onToggle,
  onRunNow,
  onViewRun,
}) => (
  <section className="gn-data-sync-operational-view" data-data-sync-schedules="true">
    <header className="gn-data-sync-view-heading">
      <h1>{t('schedules.title')}</h1>
      <div>
        <p>{t('schedules.subtitle')}</p>
        <button
          type="button"
          className="gn-data-sync-button"
          disabled={refreshing || Boolean(busyAction)}
          onClick={onRefresh}
        >
          {t('common.refresh')}
        </button>
      </div>
    </header>
    {schedules.length === 0 ? (
      <EmptyState
        title={t('schedules.empty_title')}
        description={t('schedules.empty_desc')}
      />
    ) : (
      <div className="gn-data-sync-schedule-table" role="table">
        <div className="gn-data-sync-schedule-table__head" role="row">
          <span>{t('schedules.task')}</span>
          <span>{t('schedules.status')}</span>
          <span>{t('schedules.trigger')}</span>
          <span>{t('schedules.next_run')}</span>
          <span>{t('schedules.latest_run')}</span>
          <span>{t('schedules.actions')}</span>
        </div>
        {schedules.map((schedule) => {
          const latest = schedule.latestRun;
          const scheduleActionInFlight = Boolean(busyAction);
          return (
            <div
              key={schedule.id}
              className="gn-data-sync-schedule-table__row"
              role="row"
              data-task-id={schedule.taskId}
              data-enabled={schedule.enabled ? 'true' : 'false'}
            >
              <div className="gn-data-sync-schedule-table__task" role="cell">
                <span
                  className="gn-data-sync-summary-list__signal"
                  data-active={schedule.enabled}
                  aria-hidden="true"
                />
                <strong>{schedule.taskName}</strong>
                {schedule.lifecycle ? (
                  <small>{t(`task_list.lifecycle.${schedule.lifecycle}`)}</small>
                ) : null}
              </div>
              <span role="cell">
                {schedule.enabled
                  ? t('schedules.enabled')
                  : t('schedules.disabled')}
              </span>
              <span role="cell">
                <code>{schedule.expression}</code>
                <small>{schedule.timezone}</small>
              </span>
              <time role="cell">{schedule.nextRunAt || '—'}</time>
              <div className="gn-data-sync-schedule-table__latest" role="cell">
                {latest ? (
                  <>
                    <span className="gn-data-sync-state-label" data-state={latest.status}>
                      {t(`status.${latest.status}`)}
                    </span>
                    <small>
                      {latest.startedAt || '—'}
                      {latest.finishedAt ? ` → ${latest.finishedAt}` : ''}
                    </small>
                    {latest.errorSummary ? (
                      <span className="gn-data-sync-schedule-table__error">
                        {latest.errorSummary}
                      </span>
                    ) : null}
                    {onViewRun ? (
                      <button
                        type="button"
                        className="gn-data-sync-link-button"
                        onClick={() => onViewRun(latest.id)}
                      >
                        {t('schedules.view_run')}
                      </button>
                    ) : null}
                  </>
                ) : (
                  <span>{t('schedules.no_runs')}</span>
                )}
              </div>
              <div className="gn-data-sync-schedule-table__actions" role="cell">
                {onToggle ? (
                  <button
                    type="button"
                    className="gn-data-sync-button"
                    disabled={scheduleActionInFlight}
                    onClick={() => onToggle(schedule)}
                  >
                    {schedule.enabled
                      ? t('schedules.disable')
                      : t('schedules.enable')}
                  </button>
                ) : null}
                {onRunNow ? (
                  <button
                    type="button"
                    className="gn-data-sync-button gn-data-sync-button--primary"
                    disabled={scheduleActionInFlight}
                    onClick={() => onRunNow(schedule)}
                  >
                    {t('schedules.run_now')}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    )}
  </section>
);

export const DataSyncCdcView: React.FC<{
  sources: DataSyncCdcSourceStatus[];
  t: DataSyncWorkbenchTranslate;
  refreshing: boolean;
  onRefresh: () => void;
}> = ({ sources, t, refreshing, onRefresh }) => (
  <section className="gn-data-sync-operational-view" data-data-sync-cdc="true">
    <header className="gn-data-sync-view-heading">
      <h1>{t('cdc.title')}</h1>
      <div>
        <p>{t('cdc.subtitle')}</p>
        <button type="button" className="gn-data-sync-button" disabled={refreshing} onClick={onRefresh}>
          {t('common.refresh')}
        </button>
      </div>
    </header>
    {sources.length === 0 ? (
      <EmptyState
        title={t('cdc.empty_title')}
        description={t('cdc.empty_desc')}
      />
    ) : (
      <ul className="gn-data-sync-summary-list">
        {sources.map((source) => (
          <li key={source.taskId || source.connectionId}>
            <span className="gn-data-sync-summary-list__signal" data-state={source.status} />
            <strong>{source.connectionName}</strong>
            <code>{source.adapter || source.type}</code>
            <span>{formatCdcLag(source.lagMs, t)}</span>
            <code>{source.checkpoint || '—'}</code>
            <span>{source.reason || t(`cdc.status.${source.status}`)}</span>
          </li>
        ))}
      </ul>
    )}
  </section>
);
