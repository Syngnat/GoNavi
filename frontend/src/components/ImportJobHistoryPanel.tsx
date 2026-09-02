import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Typography, message } from 'antd';
import {
  DeleteOutlined,
  DownloadOutlined,
  EyeOutlined,
  PlayCircleOutlined,
  RedoOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';

import {
  CancelImportJob,
  DeleteImportJob,
  ExportImportErrorRows,
  GetImportJob,
  ListImportJobs,
  ResumeImportJob,
  RetryImportJobFailedRows,
} from '../../wailsjs/go/app/App';
import { t as defaultTranslate } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';
import { downloadBrowserFileFromResult } from '../utils/browserFileTransfer';
import { invokeAppWithSignal, isWebRPCAbortError } from '../utils/webRpc';
import Modal from './common/ResizableDraggableModal';

const { Text } = Typography;

type ImportJobStatus =
  | 'preparing'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'interrupted';

type ImportJobRecord = {
  id: string;
  kind: 'table' | 'sql' | string;
  status: ImportJobStatus | string;
  stage?: string;
  connectionId?: string;
  databaseName?: string;
  tableName?: string;
  current?: number;
  total?: number;
  succeeded?: number;
  failed?: number;
  skipped?: number;
  bytesRead?: number;
  outcomeUnknown?: boolean;
  resumable?: boolean;
  checkpointSafe?: boolean;
  errorArtifactId?: string;
  errorArtifactCount?: number;
  errorArtifactOmittedCount?: number;
  errorArtifactTruncated?: boolean;
  errorArtifactRetryableCount?: number;
  errorArtifactUnretryableCount?: number;
  errorArtifactScopeKnown?: boolean;
  parentJobId?: string;
  recoveryAction?: string;
  message?: string;
  createdAt?: number;
  updatedAt?: number;
};

type ImportJobHistoryPanelProps = {
  refreshToken?: number;
};

const terminalStatuses = new Set<ImportJobStatus>([
  'completed',
  'partial',
  'failed',
  'cancelled',
  'unknown',
  'interrupted',
]);

const pollingStatuses = new Set<ImportJobStatus>([
  'preparing',
  'running',
  'stopping',
]);

const normalizeJobs = (value: unknown): ImportJobRecord[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((candidate): candidate is Record<string, unknown> => (
      Boolean(candidate)
      && typeof candidate === 'object'
      && typeof candidate.id === 'string'
      && candidate.id.trim().length > 0
    ))
    .slice(0, 50)
    .map((candidate) => ({
      id: String(candidate.id).trim(),
      kind: String(candidate.kind || ''),
      status: String(candidate.status || 'unknown'),
      stage: String(candidate.stage || ''),
      connectionId: String(candidate.connectionId || ''),
      databaseName: String(candidate.databaseName || ''),
      tableName: String(candidate.tableName || ''),
      current: Number(candidate.current) || 0,
      total: Number(candidate.total) || 0,
      succeeded: Number(candidate.succeeded) || 0,
      skipped: Number(candidate.skipped) || 0,
      failed: Number(candidate.failed) || 0,
      bytesRead: Number(candidate.bytesRead) || 0,
      outcomeUnknown: candidate.outcomeUnknown === true,
      resumable: candidate.resumable === true,
      checkpointSafe: Boolean(
        candidate.checkpoint
        && typeof candidate.checkpoint === 'object'
        && (candidate.checkpoint as Record<string, unknown>).safe === true,
      ),
      errorArtifactId: String(candidate.errorArtifactId || ''),
      errorArtifactCount: Number(candidate.errorArtifactCount) || 0,
      errorArtifactOmittedCount: Number(candidate.errorArtifactOmittedCount) || 0,
      errorArtifactTruncated: candidate.errorArtifactTruncated === true,
      errorArtifactRetryableCount: Number(candidate.errorArtifactRetryableCount) || 0,
      errorArtifactUnretryableCount: Number(candidate.errorArtifactUnretryableCount) || 0,
      errorArtifactScopeKnown: candidate.errorArtifactScopeKnown === true,
      parentJobId: String(candidate.parentJobId || ''),
      recoveryAction: String(candidate.recoveryAction || ''),
      message: String(candidate.message || ''),
      createdAt: Number(candidate.createdAt) || 0,
      updatedAt: Number(candidate.updatedAt) || 0,
    }));
};

const formatJobTarget = (job: ImportJobRecord): string => (
  [job.databaseName, job.tableName].map((value) => String(value || '').trim()).filter(Boolean).join(' / ')
  || '—'
);

const formatUpdatedAt = (value: unknown): string => {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
  return new Date(timestamp).toLocaleString();
};

const ImportJobHistoryPanel: React.FC<ImportJobHistoryPanelProps> = ({ refreshToken = 0 }) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? defaultTranslate;
  const [jobs, setJobs] = useState<ImportJobRecord[]>([]);
  const [selectedJob, setSelectedJob] = useState<ImportJobRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pendingAction, setPendingAction] = useState('');
  const requestRef = useRef(0);
  const recoveryRPCAbortRef = useRef<AbortController | null>(null);

  const loadJobs = useCallback(async () => {
    const requestID = requestRef.current + 1;
    requestRef.current = requestID;
    setLoading(true);
    setError('');
    try {
      const result = await ListImportJobs();
      if (requestRef.current !== requestID) return;
      if (!result?.success) {
        setJobs([]);
        setError(result?.message || t('data_import.history.error.load_failed'));
        return;
      }
      setJobs(normalizeJobs(result.data));
    } catch (loadError: any) {
      if (requestRef.current !== requestID) return;
      setJobs([]);
      setError(t('data_import.history.error.load_failed_detail', {
        detail: loadError?.message || String(loadError),
      }));
    } finally {
      if (requestRef.current === requestID) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadJobs();
    return () => {
      requestRef.current += 1;
    };
  }, [loadJobs, refreshToken]);

  useEffect(() => () => {
    recoveryRPCAbortRef.current?.abort();
    recoveryRPCAbortRef.current = null;
  }, []);

  useEffect(() => {
    const hasRunningJob = jobs.some((job) => pollingStatuses.has(job.status as ImportJobStatus));
    const isStartingRecovery = pendingAction.startsWith('resume:') || pendingAction.startsWith('retry:');
    if (!hasRunningJob && !isStartingRecovery) return undefined;
    const timer = globalThis.setTimeout(() => {
      void loadJobs();
    }, 1_000);
    return () => {
      globalThis.clearTimeout(timer);
    };
  }, [jobs, loadJobs, pendingAction]);

  const loadDetails = async (jobID: string) => {
    setPendingAction(`details:${jobID}`);
    try {
      const result = await GetImportJob(jobID);
      if (!result?.success || !result.data) {
        void message.error(result?.message || t('data_import.history.error.details_failed'));
        return;
      }
      const [job] = normalizeJobs([result.data]);
      if (job) setSelectedJob(job);
    } catch (detailsError: any) {
      void message.error(t('data_import.history.error.details_failed_detail', {
        detail: detailsError?.message || String(detailsError),
      }));
    } finally {
      setPendingAction('');
    }
  };

  const exportRejectedRows = async (job: ImportJobRecord) => {
    const artifactID = String(job.errorArtifactId || '').trim();
    if (!artifactID) return;
    setPendingAction(`export:${job.id}`);
    try {
      const result = await ExportImportErrorRows(artifactID);
      if (!result?.success) {
        void message.error(result?.message || t('data_import.history.error.export_failed'));
        return;
      }
      if (!downloadBrowserFileFromResult(result)) {
        void message.error(t('data_import.history.error.export_failed'));
        return;
      }
      void message.success(t('data_import.history.message.exported'));
    } catch (exportError: any) {
      void message.error(t('data_import.history.error.export_failed_detail', {
        detail: exportError?.message || String(exportError),
      }));
    } finally {
      setPendingAction('');
    }
  };

  const cancelJob = async (job: ImportJobRecord) => {
    if (job.status !== 'preparing' && job.status !== 'running') return;
    setPendingAction(`cancel:${job.id}`);
    try {
      const result = await CancelImportJob(job.id);
      if (!result?.success) {
        void message.error(result?.message || t('import_preview.error.stop_failed'));
        return;
      }
      await loadJobs();
    } catch (cancelError: any) {
      void message.error(t('import_preview.error.stop_failed_detail', {
        detail: cancelError?.message || String(cancelError),
      }));
    } finally {
      setPendingAction('');
    }
  };

  const confirmDelete = (job: ImportJobRecord) => {
    if (!terminalStatuses.has(job.status as ImportJobStatus)) return;
    Modal.confirm({
      title: t('data_import.history.confirm.delete_title'),
      content: t('data_import.history.confirm.delete_content'),
      okText: t('data_import.history.action.delete'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        setPendingAction(`delete:${job.id}`);
        try {
          const result = await DeleteImportJob(job.id);
          if (!result?.success) {
            throw new Error(result?.message || t('data_import.history.error.delete_failed'));
          }
          setSelectedJob((current) => (current?.id === job.id ? null : current));
          await loadJobs();
          void message.success(t('data_import.history.message.deleted'));
        } catch (deleteError: any) {
          void message.error(t('data_import.history.error.delete_failed_detail', {
            detail: deleteError?.message || String(deleteError),
          }));
          throw deleteError;
        } finally {
          setPendingAction('');
        }
      },
    });
  };

  const confirmResume = (job: ImportJobRecord) => {
    Modal.confirm({
      title: t('data_import.history.confirm.resume_title'),
      content: t('data_import.history.confirm.resume_content'),
      okText: t('data_import.history.action.resume'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        setPendingAction(`resume:${job.id}`);
        recoveryRPCAbortRef.current?.abort();
        const controller = new AbortController();
        recoveryRPCAbortRef.current = controller;
        try {
          const result = await invokeAppWithSignal(
            'ResumeImportJob',
            [job.id],
            controller.signal,
            () => ResumeImportJob(job.id),
          );
          if (!result?.success) {
            throw new Error(result?.message || t('data_import.history.error.resume_failed'));
          }
          setSelectedJob((current) => (current?.id === job.id ? null : current));
          await loadJobs();
          void message.success(t('data_import.history.message.resumed'));
        } catch (resumeError: any) {
          if (isWebRPCAbortError(resumeError)) return;
          void message.error(t('data_import.history.error.resume_failed_detail', {
            detail: resumeError?.message || String(resumeError),
          }));
          throw resumeError;
        } finally {
          if (recoveryRPCAbortRef.current === controller) {
            recoveryRPCAbortRef.current = null;
          }
          setPendingAction('');
        }
      },
    });
  };

  const confirmRetryFailedRows = (job: ImportJobRecord) => {
    Modal.confirm({
      title: t('data_import.history.confirm.retry_failed_rows_title'),
      content: t('data_import.history.confirm.retry_failed_rows_content'),
      okText: t('data_import.history.action.retry_failed_rows'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        setPendingAction(`retry:${job.id}`);
        recoveryRPCAbortRef.current?.abort();
        const controller = new AbortController();
        recoveryRPCAbortRef.current = controller;
        try {
          const result = await invokeAppWithSignal(
            'RetryImportJobFailedRows',
            [job.id],
            controller.signal,
            () => RetryImportJobFailedRows(job.id),
          );
          if (!result?.success) {
            throw new Error(result?.message || t('data_import.history.error.retry_failed_rows_failed'));
          }
          setSelectedJob((current) => (current?.id === job.id ? null : current));
          await loadJobs();
          void message.success(t('data_import.history.message.retry_failed_rows_started'));
        } catch (retryError: any) {
          if (isWebRPCAbortError(retryError)) return;
          void message.error(t('data_import.history.error.retry_failed_rows_failed_detail', {
            detail: retryError?.message || String(retryError),
          }));
          throw retryError;
        } finally {
          if (recoveryRPCAbortRef.current === controller) {
            recoveryRPCAbortRef.current = null;
          }
          setPendingAction('');
        }
      },
    });
  };

  return (
    <section
      data-import-history-panel="true"
      style={{
        display: 'grid',
        gap: 12,
        padding: 20,
        border: '1px solid var(--gn-br-1, rgba(15,23,42,0.08))',
        borderRadius: 8,
        background: 'var(--gn-bg-panel, #fff)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'grid', gap: 2 }}>
          <Text strong>{t('data_import.history.title')}</Text>
          <Text type="secondary">{t('data_import.history.description')}</Text>
        </div>
        <Button
          data-import-history-refresh-action="true"
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={() => void loadJobs()}
        >
          {t('data_import.history.action.refresh')}
        </Button>
      </div>

      {error ? <Alert type="error" showIcon message={error} /> : null}
      {!loading && jobs.length === 0 ? (
        <Empty description={t('data_import.history.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : null}

      <div style={{ display: 'grid', gap: 8 }}>
        {jobs.map((job) => {
          const canDelete = terminalStatuses.has(job.status as ImportJobStatus);
          const canCancel = job.status === 'preparing' || job.status === 'running';
          const hasArtifact = Boolean(String(job.errorArtifactId || '').trim());
          const errorArtifactCount = Number(job.errorArtifactCount) || 0;
          const errorArtifactOmittedCount = Number(job.errorArtifactOmittedCount) || 0;
          const errorArtifactRetryableCount = Number(job.errorArtifactRetryableCount) || 0;
          const errorArtifactUnretryableCount = Number(job.errorArtifactUnretryableCount) || 0;
          const hasArtifactMetadata = job.errorArtifactScopeKnown === true
            || errorArtifactCount > 0
            || errorArtifactOmittedCount > 0
            || errorArtifactRetryableCount > 0
            || errorArtifactUnretryableCount > 0
            || job.errorArtifactTruncated === true;
          const canExport = canDelete && hasArtifact;
          const canResume = job.kind === 'table'
            && job.status === 'interrupted'
            && job.resumable === true
            && job.checkpointSafe === true
            && !job.outcomeUnknown;
          const canRetryFailedRows = job.kind === 'table'
            && (job.status === 'failed' || job.status === 'partial')
            && hasArtifact
            && (job.errorArtifactScopeKnown === true
              ? errorArtifactRetryableCount > 0
              : Number(job.failed) > 0)
            && !job.outcomeUnknown;
          const hasRunningResume = jobs.some((candidate) => (
            candidate.parentJobId === job.id
            && candidate.recoveryAction === 'resume'
            && pollingStatuses.has(candidate.status as ImportJobStatus)
          ));
          const resumeUnavailable = job.status === 'interrupted' && !canResume && !hasRunningResume;
          return (
            <div
              key={job.id}
              data-import-history-job={true}
              data-import-history-job-id={job.id}
              style={{
                display: 'grid',
                gap: 8,
                padding: '12px 14px',
                borderRadius: 8,
                background: 'var(--gn-bg-subtle, var(--gn-bg-panel-2, #f8fafc))',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <Text strong>{formatJobTarget(job)}</Text>
                  <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                    {t(`data_import.history.kind.${job.kind || 'table'}`)} · {formatUpdatedAt(job.updatedAt)}
                  </Text>
                </div>
                <Text>{t(`data_import.history.status.${job.status || 'unknown'}`)}</Text>
              </div>
              <Text data-import-history-progress={job.id} type="secondary">
                {t('data_import.history.progress', {
                  current: Number(job.current) || 0,
                  success: Number(job.succeeded) || 0,
                  failed: Number(job.failed) || 0,
                  skipped: Number(job.skipped) || 0,
                })}
              </Text>
              {hasArtifactMetadata ? (
                <div
                  data-import-history-error-artifact={job.id}
                  style={{ display: 'grid', gap: 2 }}
                >
                  <Text
                    data-import-history-error-artifact-count={job.id}
                    type="secondary"
                  >
                    {t('data_import.error_artifact.count', { count: errorArtifactCount })}
                  </Text>
                  <Text
                    data-import-history-error-artifact-omitted-count={job.id}
                    type="secondary"
                  >
                    {t('data_import.error_artifact.omitted_count', { count: errorArtifactOmittedCount })}
                  </Text>
                  <Text
                    data-import-history-error-artifact-retryable-count={job.id}
                    type="secondary"
                  >
                    {t('data_import.error_artifact.retryable_count', { count: errorArtifactRetryableCount })}
                  </Text>
                  <Text
                    data-import-history-error-artifact-unretryable-count={job.id}
                    type="secondary"
                  >
                    {t('data_import.error_artifact.unretryable_count', { count: errorArtifactUnretryableCount })}
                  </Text>
                  {job.errorArtifactTruncated ? (
                    <Text
                      data-import-history-error-artifact-truncated={job.id}
                      type="warning"
                    >
                      {t('data_import.error_artifact.truncated')}
                    </Text>
                  ) : null}
                </div>
              ) : null}
              {job.recoveryAction ? (
                <Text data-import-history-recovery={job.id} type="secondary">
                  {t(`data_import.history.recovery.${job.recoveryAction}`)}
                </Text>
              ) : null}
              {resumeUnavailable ? (
                <Alert
                  data-import-history-resume-unavailable={job.id}
                  type="warning"
                  showIcon
                  message={t(
                    job.outcomeUnknown
                      ? 'data_import.history.detail.resume_unknown_outcome'
                      : 'data_import.history.detail.resume_unavailable',
                  )}
                />
              ) : null}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button
                  data-import-history-details-action={job.id}
                  size="small"
                  icon={<EyeOutlined />}
                  loading={pendingAction === `details:${job.id}`}
                  onClick={() => void loadDetails(job.id)}
                >
                  {t('data_import.history.action.details')}
                </Button>
                {canCancel ? (
                  <Button
                    data-import-history-cancel-action={job.id}
                    size="small"
                    danger
                    icon={<StopOutlined />}
                    loading={pendingAction === `cancel:${job.id}`}
                    onClick={() => void cancelJob(job)}
                  >
                    {t('import_preview.action.stop')}
                  </Button>
                ) : null}
                {canExport ? (
                  <Button
                    data-import-history-export-action={job.id}
                    size="small"
                    icon={<DownloadOutlined />}
                    loading={pendingAction === `export:${job.id}`}
                    onClick={() => void exportRejectedRows(job)}
                  >
                    {t('data_import.history.action.export_errors')}
                  </Button>
                ) : null}
                {canResume ? (
                  <Button
                    data-import-history-resume-action={job.id}
                    size="small"
                    type="primary"
                    icon={<PlayCircleOutlined />}
                    loading={pendingAction === `resume:${job.id}`}
                    onClick={() => confirmResume(job)}
                  >
                    {t('data_import.history.action.resume')}
                  </Button>
                ) : null}
                {canRetryFailedRows ? (
                  <Button
                    data-import-history-retry-failed-rows-action={job.id}
                    size="small"
                    icon={<RedoOutlined />}
                    loading={pendingAction === `retry:${job.id}`}
                    onClick={() => confirmRetryFailedRows(job)}
                  >
                    {t('data_import.history.action.retry_failed_rows')}
                  </Button>
                ) : null}
                {canDelete ? (
                  <Button
                    data-import-history-delete-action={job.id}
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    loading={pendingAction === `delete:${job.id}`}
                    onClick={() => confirmDelete(job)}
                  >
                    {t('data_import.history.action.delete')}
                  </Button>
                ) : null}
              </div>
              {selectedJob?.id === job.id ? (
                <div
                  data-import-history-details={job.id}
                  style={{
                    display: 'grid',
                    gap: 4,
                    padding: 10,
                    borderRadius: 6,
                    border: '1px solid var(--gn-br-1, rgba(15,23,42,0.08))',
                  }}
                >
                  <Text>{t('data_import.history.detail.stage', { stage: selectedJob.stage || '—' })}</Text>
                  <Text>{t('data_import.history.detail.job_id', { id: selectedJob.id })}</Text>
                  {selectedJob.message ? <Text type="secondary">{selectedJob.message}</Text> : null}
                  {selectedJob.outcomeUnknown ? (
                    <Alert type="warning" showIcon message={t('data_import.history.detail.outcome_unknown')} />
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default ImportJobHistoryPanel;
