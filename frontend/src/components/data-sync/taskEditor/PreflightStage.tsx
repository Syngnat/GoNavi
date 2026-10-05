import React from 'react';
import {
  type DataSyncTaskDefinition,
  type DataSyncPreflightSnapshot,
  type DataSyncTaskStage,
  validateDataSyncTask,
} from '../model';
import { type DataSyncWorkbenchTranslate, dataSyncValidationIssueText } from '../text';

export const PreflightStage: React.FC<{
  task: DataSyncTaskDefinition;
  snapshot: DataSyncPreflightSnapshot | null;
  stale: boolean;
  t: DataSyncWorkbenchTranslate;
  onLocate: (stage: DataSyncTaskStage) => void;
}> = ({ task, snapshot, stale, t, onLocate }) => {
  const hasCurrentSnapshot = Boolean(snapshot && !stale);
  const issues = hasCurrentSnapshot ? snapshot!.issues : validateDataSyncTask(task);
  return (
    <section className="gn-data-sync-section" data-data-sync-preflight-stage="true">
      <header className="gn-data-sync-section__header">
        <div>
          <h2>{t('preflight.title')}</h2>
          <p>
            {stale
              ? t('preflight.stale')
              : hasCurrentSnapshot
                ? t('preflight.empty')
                : t('preflight.not_run')}
          </p>
        </div>
      </header>
      {!stale && snapshot && snapshot.approvalRequired !== false ? (
        <div
          className="gn-data-sync-approval-state"
          data-approval-required="true"
          role="alert"
        >
          <strong>{t('preflight.approval_required')}</strong>
          <span>{t('preflight.approval_fail_closed')}</span>
        </div>
      ) : null}
      <ol className="gn-data-sync-preflight-checklist">
        {issues.length === 0 ? (
          <li data-severity="info">
            {hasCurrentSnapshot ? t('preflight.passed') : t('preflight.not_run')}
          </li>
        ) : (
          issues.map((item) => (
            <li key={item.id} data-severity={item.severity}>
              <span>{t(`preflight.severity.${item.severity}`)}</span>
              <p title={item.message || undefined}>
                {dataSyncValidationIssueText(item, t)}
              </p>
              <button
                type="button"
                className="gn-data-sync-link-button"
                onClick={() => onLocate(item.stage)}
              >
                {t('preflight.open_issue')}
              </button>
            </li>
          ))
        )}
      </ol>
    </section>
  );
};
