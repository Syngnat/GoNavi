import React, { useEffect, useMemo, useState } from 'react';

import { ClipboardSetText } from '../../../wailsjs/runtime/runtime';

import type {
  DataSyncPreflightSnapshot,
  DataSyncApprovalChallenge,
  DataSyncApprovalGrant,
  DataSyncTaskStage,
  DataSyncValidationIssue,
} from './model';
import {
  buildDataSyncPreflightRemediationSQL,
  collectDataSyncPreflightIndexes,
  formatDataSyncPreflightIndexColumns,
} from './dataSyncPreflightIndexes';
import {
  dataSyncValidationIssueText,
  type DataSyncWorkbenchTranslate,
} from './text';

const statusText = (
  snapshot: DataSyncPreflightSnapshot | null,
  stale: boolean,
  running: boolean,
  t: DataSyncWorkbenchTranslate,
): string => {
  if (running) return t('preflight.running');
  if (stale) return t('preflight.stale');
  if (!snapshot) return t('preflight.not_run');
  if (snapshot.status === 'blocked') {
    return t('preflight.blocked', {
      count: snapshot.issues.filter((issue) => issue.severity === 'blocker').length,
    });
  }
  if (snapshot.status === 'warning') {
    return t('preflight.warning', {
      count: snapshot.issues.filter((issue) => issue.severity === 'warning').length,
    });
  }
  return t('preflight.passed');
};

const issueText = (
  issue: DataSyncValidationIssue,
  t: DataSyncWorkbenchTranslate,
) => dataSyncValidationIssueText(issue, t);

export const DataSyncPreflightPanel: React.FC<{
  snapshot: DataSyncPreflightSnapshot | null;
  currentRevision: number;
  stale: boolean;
  running: boolean;
  t: DataSyncWorkbenchTranslate;
  onLocateIssue: (stage: DataSyncTaskStage, mappingId?: string) => void;
  approval?: DataSyncApprovalGrant | null;
  approvalChallenge?: DataSyncApprovalChallenge | null;
  beginningApproval?: boolean;
  approving?: boolean;
  approvalError?: string;
  onBeginApproval?: () => void;
  onApprove?: () => void;
  embedded?: boolean;
}> = ({
  snapshot,
  currentRevision,
  stale,
  running,
  t,
  onLocateIssue,
  approval = null,
  approvalChallenge = null,
  beginningApproval = false,
  approving = false,
  approvalError = '',
  onBeginApproval,
  onApprove,
  embedded = false,
}) => {
  const [clock, setClock] = useState(Date.now());
  const [copyError, setCopyError] = useState(false);
  const effectiveIssues = stale ? [] : snapshot?.issues || [];
  const approvalRequired = Boolean(snapshot && snapshot.approvalRequired !== false);
  const approvalCurrent = Boolean(
    snapshot &&
      approval &&
      approval.definitionHash === snapshot.definitionHash &&
      Date.parse(approval.expiresAt) > clock,
  );
  const challengeCurrent = Boolean(
    snapshot &&
      approvalChallenge &&
      approvalChallenge.definitionHash === snapshot.definitionHash &&
      Date.parse(approvalChallenge.expiresAt) > clock,
  );
  const remainingSeconds = useMemo(() => {
    if (!approvalChallenge || !challengeCurrent) return 0;
    const remaining = Date.parse(approvalChallenge.notBefore) - clock;
    return Math.max(0, Math.ceil(remaining / 1_000));
  }, [approvalChallenge, challengeCurrent, clock]);
  const status = running
    ? 'running'
    : stale
      ? 'stale'
      : snapshot?.status || 'stale';
  const unmigratedIndexes = useMemo(
    () => collectDataSyncPreflightIndexes(effectiveIssues),
    [effectiveIssues],
  );
  const remediationSQL = useMemo(
    () => buildDataSyncPreflightRemediationSQL(unmigratedIndexes),
    [unmigratedIndexes],
  );

  const copyRemediationSQL = async () => {
    if (!remediationSQL) return;
    setCopyError(false);
    try {
      if (await ClipboardSetText(remediationSQL)) return;
    } catch {
      // Fall back to the browser clipboard when the Wails runtime is unavailable.
    }
    try {
      await navigator.clipboard.writeText(remediationSQL);
    } catch {
      setCopyError(true);
    }
  };

  useEffect(() => {
    setClock(Date.now());
  }, [snapshot?.definitionHash, stale]);

  useEffect(() => {
    if (!challengeCurrent || remainingSeconds <= 0) return undefined;
    const timer = globalThis.setInterval(() => setClock(Date.now()), 250);
    return () => globalThis.clearInterval(timer);
  }, [challengeCurrent, remainingSeconds]);

  return (
    <aside
      className={`gn-data-sync-preflight${embedded ? ' gn-data-sync-preflight--embedded' : ''}`}
      data-data-sync-preflight="true"
      data-layout={embedded ? 'embedded' : 'sidebar'}
      data-status={status}
      data-preflight-task-id={snapshot?.taskId || ''}
      aria-live="polite"
    >
      <header className="gn-data-sync-preflight__header">
        <span className="gn-data-sync-preflight__signal" aria-hidden="true" />
        <div>
          <h2>{t('preflight.title')}</h2>
          <strong>{statusText(snapshot, stale, running, t)}</strong>
        </div>
      </header>
      <div className="gn-data-sync-preflight__revision">
        {t('preflight.current_revision', { revision: currentRevision })}
      </div>
      {snapshot && !stale ? (
        <div
          className="gn-data-sync-approval-state"
          data-approval-required={approvalRequired ? 'true' : 'false'}
          role={approvalRequired ? 'alert' : 'status'}
        >
          <strong>
            {approvalCurrent
              ? t('preflight.approval_granted')
              : approvalRequired
              ? t('preflight.approval_required')
              : t('preflight.approval_not_required')}
          </strong>
          {approvalRequired && !approvalCurrent ? (
            <>
              <span>{t('preflight.approval_fail_closed')}</span>
              {!challengeCurrent ? (
                <button
                  type="button"
                  className="gn-data-sync-button"
                  disabled={beginningApproval || approving || !onBeginApproval}
                  onClick={onBeginApproval}
                >
                  {beginningApproval
                    ? t('preflight.approval_beginning')
                    : t('preflight.approval_begin_countdown')}
                </button>
              ) : remainingSeconds > 0 ? (
                <button type="button" className="gn-data-sync-button" disabled>
                  {t('preflight.approval_countdown', { seconds: remainingSeconds })}
                </button>
              ) : (
                <button
                  type="button"
                  className="gn-data-sync-button gn-data-sync-button--danger"
                  disabled={approving || !onApprove}
                  onClick={onApprove}
                >
                  {approving
                    ? t('preflight.approving')
                    : t('preflight.approval_confirm')}
                </button>
              )}
              {approvalError ? (
                <span className="gn-data-sync-error-text" role="alert">
                  {approvalError}
                </span>
              ) : null}
            </>
          ) : approvalCurrent && approval ? (
            <span>
              {t('preflight.approval_expires', { expiresAt: approval.expiresAt })}
            </span>
          ) : null}
        </div>
      ) : null}
      {effectiveIssues.length === 0 ? (
        <div className="gn-data-sync-empty gn-data-sync-empty--compact">
          <p>{running ? t('preflight.running') : t('preflight.empty')}</p>
        </div>
      ) : (
        <>
          <ol className="gn-data-sync-issue-list">
            {effectiveIssues.map((issue) => (
              <li key={issue.id} data-severity={issue.severity}>
                <div>
                  <span className="gn-data-sync-issue-list__severity">
                    {t(`preflight.severity.${issue.severity}`)}
                  </span>
                  <p title={issue.message || undefined}>{issueText(issue, t)}</p>
                </div>
                <button
                  type="button"
                  className="gn-data-sync-link-button"
                  onClick={() => onLocateIssue(issue.stage, issue.mappingId)}
                >
                  {t('preflight.open_issue')}
                </button>
              </li>
            ))}
          </ol>
          {unmigratedIndexes.length > 0 ? (
            <section className="gn-data-sync-index-remediation">
              <div className="gn-data-sync-index-remediation__header">
                <strong>
                  {t('preflight.index_remediation.title', {
                    count: unmigratedIndexes.length,
                  })}
                </strong>
                <button
                  type="button"
                  className="gn-data-sync-button"
                  disabled={!remediationSQL}
                  onClick={() => void copyRemediationSQL()}
                >
                  {t('preflight.index_remediation.copy')}
                </button>
              </div>
              {copyError ? (
                <p className="gn-data-sync-index-remediation__error" role="alert">
                  {t('preflight.index_remediation.copy_failed')}
                </p>
              ) : null}
              <ol className="gn-data-sync-summary-list">
                {unmigratedIndexes.map((index, itemIndex) => {
                  const remediationStatements = index.remediationStatements || [];
                  return (
                    <li key={`${index.name}:${index.mappingId || ''}:${itemIndex}`}>
                      <strong>{index.name}</strong>
                      <span>{index.indexType || 'BTREE'}</span>
                      <p>{t('preflight.index_remediation.columns', {
                        columns: formatDataSyncPreflightIndexColumns(index.columns),
                      })}</p>
                      <p>{index.reason}</p>
                      {remediationStatements.length > 0 ? (
                        <pre>{remediationStatements.join('\n')}</pre>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}
        </>
      )}
    </aside>
  );
};
