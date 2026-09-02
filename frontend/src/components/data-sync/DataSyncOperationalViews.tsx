import React from 'react';

import { DATA_SYNC_RUN_PAGE_SIZES } from './model';
import type {
  DataSyncCdcSourceStatus,
  DataSyncCheckpointSummary,
  DataSyncCompareMode,
  DataSyncCompareResult,
  DataSyncErrorRow,
  DataSyncRunEvent,
  DataSyncRunRecord,
  DataSyncRunPageSize,
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

/** 运行/调度时间统一按本地时区显示为 y-m-d h:m:s，无法解析时原样返回。 */
const formatDataSyncTime = (value: string): string => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
};

const canDeleteRunHistory = (status: DataSyncRunRecord['status']): boolean =>
  ['succeeded', 'partial', 'failed', 'canceled', 'cancelled', 'interrupted'].includes(
    status,
  );

export const DataSyncRunHistory: React.FC<{
  runs: DataSyncRunRecord[];
  runPage: number;
  runPageSize: DataSyncRunPageSize;
  runTotal: number;
  hasPreviousRunPage: boolean;
  hasNextRunPage: boolean;
  selectedRunId: string;
  selectedRunMessage?: string;
  runEvents: DataSyncRunEvent[];
  errorRows: DataSyncErrorRow[];
  compareResult: DataSyncCompareResult | null;
  compareMode?: DataSyncCompareMode;
  t: DataSyncWorkbenchTranslate;
  onSelectRun: (runId: string) => void;
  checkpoint: DataSyncCheckpointSummary | null;
  busyAction: string;
  onRefresh: () => void;
  onPreviousRunPage: () => void;
  onNextRunPage: () => void;
  onRunPageSizeChange: (pageSize: DataSyncRunPageSize) => void;
  onDeleteRun: (runId: string) => void;
  onClearTerminalRuns: () => void;
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
  runPage,
  runPageSize,
  runTotal,
  hasPreviousRunPage,
  hasNextRunPage,
  selectedRunId,
  selectedRunMessage,
  runEvents,
  errorRows,
  compareResult,
  compareMode,
  checkpoint,
  busyAction,
  t,
  onSelectRun,
  onRefresh,
  onPreviousRunPage,
  onNextRunPage,
  onRunPageSizeChange,
  onDeleteRun,
  onClearTerminalRuns,
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
        <button
          type="button"
          className="gn-data-sync-button gn-data-sync-button--danger"
          disabled={
            !runs.some((run) => canDeleteRunHistory(run.status)) ||
            busyAction === 'clear-runs'
          }
          onClick={onClearTerminalRuns}
        >
          {t('runs.clear_terminal')}
        </button>
      </div>
    </header>
    {runs.length === 0 ? (
      <EmptyState
        title={t('runs.empty_title')}
        description={t('runs.empty_desc')}
      />
    ) : (
      <>
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
                <td>{formatDataSyncTime(run.startedAt)}</td>
                <td>{run.rowsWritten.toLocaleString()}</td>
                <td>{run.rowsFailed.toLocaleString()}</td>
                <td className="gn-data-sync-mono">{run.checkpoint || '—'}</td>
                <td>
                  <button
                    type="button"
                    className="gn-data-sync-link-button"
                    onClick={() => onSelectRun(run.id)}
                  >
                    {t('runs.view_details')}
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
                  {canDeleteRunHistory(run.status) ? (
                    <button
                      type="button"
                      className="gn-data-sync-link-button gn-data-sync-link-button--danger"
                      disabled={busyAction === `delete-run:${run.id}`}
                      onClick={() => onDeleteRun(run.id)}
                    >
                      {t('runs.delete')}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav className="gn-data-sync-run-pagination" aria-label={t('runs.pagination')}>
        <div className="gn-data-sync-run-pagination__summary">
          <span>{t('runs.page', { page: runPage })}</span>
          <span>{t('runs.total', { total: runTotal.toLocaleString() })}</span>
        </div>
        <label className="gn-data-sync-run-pagination__size">
          <span>{t('runs.page_size')}</span>
          <select
            className="gn-data-sync-control"
            value={runPageSize}
            disabled={busyAction === 'page-runs'}
            onChange={(event) =>
              onRunPageSizeChange(Number(event.target.value) as DataSyncRunPageSize)
            }
          >
            {DATA_SYNC_RUN_PAGE_SIZES.map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="gn-data-sync-button"
          disabled={!hasPreviousRunPage || busyAction === 'page-runs'}
          onClick={onPreviousRunPage}
        >
          {t('runs.previous_page')}
        </button>
        <button
          type="button"
          className="gn-data-sync-button"
          disabled={!hasNextRunPage || busyAction === 'page-runs'}
          onClick={onNextRunPage}
        >
          {t('runs.next_page')}
        </button>
      </nav>
      </>
    )}

    <section className="gn-data-sync-run-events" data-data-sync-run-events="true">
      <h2>{t('events.title')}</h2>
      {!selectedRunId ? (
        <p>{t('events.select_run')}</p>
      ) : runEvents.length === 0 ? (
        <p>{t('events.empty')}</p>
      ) : (
        <ol className="gn-data-sync-run-events__timeline">
          {runEvents.map((event) => {
            const scope = [event.stage, event.table].filter(Boolean).join(' · ');
            return (
              <li key={event.sequence} data-event-sequence={event.sequence}>
                <div className="gn-data-sync-run-events__marker" aria-hidden="true" />
                <div className="gn-data-sync-run-events__content">
                  <header>
                    <strong>{event.type}</strong>
                    <time>{formatDataSyncTime(event.createdAt)}</time>
                  </header>
                  {scope ? (
                    <p className="gn-data-sync-run-events__meta">{scope}</p>
                  ) : null}
                  {event.message ? <p>{event.message}</p> : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>

    <section className="gn-data-sync-error-rows" data-data-sync-error-rows="true">
      <h2>{t('errors.title')}</h2>
      {!selectedRunId ? (
        <EmptyState
          title={t('errors.empty_title')}
          description={t('errors.empty_desc')}
        />
      ) : errorRows.length === 0 ? (
        selectedRunMessage ? (
          <div className="gn-data-sync-task-failure" data-data-sync-task-failure="true">
            <strong>{t('errors.task_failure_title')}</strong>
            <p>{selectedRunMessage}</p>
            <span>{t('errors.task_failure_desc')}</span>
          </div>
        ) : (
          <EmptyState
            title={t('errors.empty_title')}
            description={t('errors.empty_desc')}
          />
        )
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
    <section className="gn-data-sync-compare-panel" data-data-sync-compare="true">
      <h2>{t('compare.title')}</h2>
      {!selectedRunId || !compareResult ? (
        <p>{t('compare.empty')}</p>
      ) : compareResult.tables.length === 0 ? (
        <p>{compareResult.message || t('compare.empty')}</p>
      ) : (
        <ul className="gn-data-sync-compare-list">
          {compareResult.tables.map((summary) => {
            const missingColumns = summary.missingColumns || [];
            const columnDiffs = summary.columnDiffs || [];
            const effectiveMode: DataSyncCompareMode =
              compareResult?.content || compareMode || 'data';
            const showData = effectiveMode === 'data' || effectiveMode === 'both';
            const showSchema =
              effectiveMode === 'schema' ||
              effectiveMode === 'both' ||
              summary.hasSchema === true;
            const hasSchemaDiff =
              (summary.schemaDiffCount ?? 0) > 0 ||
              missingColumns.length > 0 ||
              columnDiffs.length > 0;
            // A data-only compare shows no structure section, but a column gap
            // still blocks a later sync, so it degrades to one inline warning
            // instead of vanishing the way it used to.
            const schemaWarningOnly = !showSchema && hasSchemaDiff;
            // Analyze has many per-table early exits (target missing,
            // unrepairable schema diff, no key for the diff, source/target read
            // failure) that only set Message and leave every counter at 0.
            // Without canSync those rows rendered a green "identical" badge for
            // a table that was never actually compared.
            const notCompared = summary.canSync === false;
            const hasDiff =
              (showData &&
                (summary.inserts > 0 ||
                  summary.updates > 0 ||
                  summary.deletes > 0)) ||
              hasSchemaDiff;
            const status = notCompared
              ? 'unknown'
              : hasDiff
                ? 'diff'
                : 'same';
            // Analyze exposes a human summary and a structured field diff for
            // the same schema gap. Keep the structured list authoritative and
            // suppress only the known duplicate summary wording; unrelated
            // warnings/errors remain visible.
            const hasStructuredSchemaDetail =
              columnDiffs.length > 0 || missingColumns.length > 0;
            const isDuplicateSchemaSummary = (value: string): boolean =>
              hasStructuredSchemaDetail &&
              /(?:目标(?:表)?缺失\s*(?:\d+\s*个?)?\s*(?:字段|列)|(?:target\s+)?(?:table\s+)?(?:is\s+)?missing\s+(?:\d+\s+)?(?:columns?|fields?))/i.test(
                value,
              );
            const message =
              summary.message && !isDuplicateSchemaSummary(summary.message)
                ? summary.message
                : '';
            const warnings = (summary.warnings || []).filter(
              (warning) => !isDuplicateSchemaSummary(warning),
            );
            return (
              <li
                key={summary.table}
                className="gn-data-sync-compare-row"
                data-diff={hasDiff ? 'true' : 'false'}
                data-status={status}
              >
                <div className="gn-data-sync-compare-row__head">
                  <span
                    className="gn-data-sync-compare-badge"
                    data-diff={hasDiff ? 'true' : 'false'}
                    data-status={status}
                  >
                    {notCompared
                      ? t('compare.status_blocked')
                      : hasDiff
                        ? t('compare.status_diff')
                        : t('compare.status_same')}
                  </span>
                  <code className="gn-data-sync-mono">{summary.table}</code>
                </div>
                {/* The backend explains per-table outcomes only through
                    Message/Warnings; dropping them left failures invisible. */}
                {message && (
                  <p
                    className="gn-data-sync-compare-row__message"
                    data-data-sync-compare-message="true"
                    role={notCompared ? 'alert' : undefined}
                  >
                    {message}
                  </p>
                )}
                {warnings.length > 0 && (
                  <ul
                    className="gn-data-sync-compare-row__warnings"
                    data-data-sync-compare-warnings="true"
                  >
                    {warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}
                {(summary.sourceObject || summary.targetObject) && (
                  <dl className="gn-data-sync-compare-row__endpoints">
                    {summary.sourceObject && (
                      <div data-side="source">
                        <dt>{t('compare.source')}</dt>
                        <dd className="gn-data-sync-mono">{summary.sourceObject}</dd>
                      </div>
                    )}
                    {summary.targetObject && (
                      <div data-side="target">
                        <dt>{t('compare.target')}</dt>
                        <dd className="gn-data-sync-mono">{summary.targetObject}</dd>
                      </div>
                    )}
                  </dl>
                )}
                {/* Structure first: it is the coarser difference, and a row
                    count says little while a column gap is unresolved. */}
                {showSchema && (
                  <dl className="gn-data-sync-compare-row__schema-counts">
                    <div data-kind="schema">
                      <dt>{t('compare.schema_diff')}</dt>
                      <dd>
                        {summary.schemaDiffCount === undefined
                          ? '—'
                          : summary.schemaDiffCount.toLocaleString()}
                      </dd>
                    </div>
                  </dl>
                )}
                {schemaWarningOnly && (
                  <p
                    className="gn-data-sync-inline-note"
                    role="note"
                    data-data-sync-schema-warning="true"
                  >
                    {t('compare.schema_warning', {
                      count: summary.schemaDiffCount ?? columnDiffs.length,
                    })}
                  </p>
                )}
                {showSchema &&
                  (columnDiffs.length > 0 ? (
                  <ul
                    className="gn-data-sync-compare-row__column-diffs"
                    data-data-sync-column-diffs="true"
                  >
                    {columnDiffs.map((diff) => (
                      <li key={`${diff.kind}:${diff.column}`} data-kind={diff.kind}>
                        {/* Kind leads so the line reads as a sentence in both
                            locales ("目标缺失 new_column varchar(255)"). */}
                        <span className="gn-data-sync-compare-row__diff-kind">
                          {t(`compare.diff_kind.${diff.kind}`)}
                        </span>
                        <span
                          className="gn-data-sync-compare-row__field"
                          data-data-sync-compare-field="true"
                        >
                          <code className="gn-data-sync-mono">{diff.column}</code>
                          {diff.kind !== 'type' &&
                            diff.kind !== 'nullable' &&
                            (diff.source || diff.target) && (
                              <code className="gn-data-sync-mono gn-data-sync-compare-row__field-type">
                                {diff.source || diff.target}
                              </code>
                            )}
                        </span>
                        {diff.kind === 'type' || diff.kind === 'nullable' ? (
                          <span className="gn-data-sync-compare-row__diff-detail">
                            <code className="gn-data-sync-mono">
                              {diff.source || '—'}
                            </code>
                            {' → '}
                            <code className="gn-data-sync-mono">
                              {diff.target || '—'}
                            </code>
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  ) : (
                    missingColumns.length > 0 && (
                      <div className="gn-data-sync-compare-row__missing">
                        <span className="gn-data-sync-compare-row__missing-label">
                          {t('compare.missing_columns')}
                        </span>
                        {missingColumns.map((column) => (
                          <code key={column} className="gn-data-sync-mono">
                            {column}
                          </code>
                        ))}
                      </div>
                    )
                  ))}
                {showData && (
                  <dl className="gn-data-sync-compare-row__data-counts">
                    <div data-kind="inserts">
                      <dt>{t('compare.inserts')}</dt>
                      <dd>{summary.inserts.toLocaleString()}</dd>
                    </div>
                    <div data-kind="updates">
                      <dt>{t('compare.updates')}</dt>
                      <dd>{summary.updates.toLocaleString()}</dd>
                    </div>
                    <div data-kind="deletes">
                      <dt>{t('compare.deletes')}</dt>
                      <dd>{summary.deletes.toLocaleString()}</dd>
                    </div>
                    <div data-kind="same">
                      <dt>{t('compare.same')}</dt>
                      <dd>{summary.same.toLocaleString()}</dd>
                    </div>
                  </dl>
                )}
              </li>
            );
          })}
        </ul>
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
          <div><dt>{t('checkpoint.updated_at')}</dt><dd>{formatDataSyncTime(checkpoint.updatedAt)}</dd></div>
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
}> = ({ schedules, t, refreshing, onRefresh }) => (
  <section className="gn-data-sync-operational-view" data-data-sync-schedules="true">
    <header className="gn-data-sync-view-heading">
      <h1>{t('schedules.title')}</h1>
      <div>
        <p>{t('schedules.subtitle')}</p>
        <button type="button" className="gn-data-sync-button" disabled={refreshing} onClick={onRefresh}>
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
      <ul className="gn-data-sync-summary-list">
        {schedules.map((schedule) => (
          <li key={schedule.id}>
            <span className="gn-data-sync-summary-list__signal" data-active={schedule.enabled} />
            <strong>{schedule.taskName}</strong>
            <code>{schedule.expression}</code>
            <span>{schedule.timezone}</span>
            <time>{formatDataSyncTime(schedule.nextRunAt)}</time>
          </li>
        ))}
      </ul>
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
