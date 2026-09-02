import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { message } from 'antd';
import { t } from '../i18n';
import { downloadBrowserFileFromResult } from '../utils/browserFileTransfer';
import {
  createEphemeralExportProgressTaskKey,
  consumeExportProgressTaskRequest,
  finishExportProgressTask,
  getExportProgressTaskSnapshot,
  isExportProgressTaskRunning,
  resetExportProgressTask,
  startExportProgressTask,
  subscribeExportProgressTask,
  type ExportProgressState,
} from './exportProgressTaskStore';

export type {
  ExportProgressEvent,
  ExportProgressLogEntry,
  ExportProgressState,
  ExportProgressTaskSnapshot,
} from './exportProgressTaskStore';

export type ExportRunResult = {
  success: boolean;
  message: string;
};

export type RunExportWithProgressOptions<T extends ExportRunResult> = {
  title: string;
  targetName: string;
  format: string;
  totalRows?: number;
  run: (jobId: string) => Promise<T>;
};

export type UseExportProgressRunnerOptions = {
  showToast?: boolean;
  taskKey?: string;
  requestKey?: string;
};

const normalizeCount = (value: unknown): number => {
  const next = Number(value);
  if (!Number.isFinite(next) || next < 0) {
    return 0;
  }
  return Math.trunc(next);
};

const hasUsableTotalRows = (known: boolean, total: unknown): boolean => {
  if (!known) {
    return false;
  }
  return normalizeCount(total) > 0;
};

const buildExportJobId = (): string => `export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const EXPORT_CANCELED_MESSAGE = '\u5df2\u53d6\u6d88';

export function useExportProgressRunner(options?: UseExportProgressRunnerOptions) {
  const showToast = options?.showToast !== false;
  const configuredTaskKey = String(options?.taskKey || '').trim();
  const configuredRequestKey = String(options?.requestKey || '').trim();
  const ephemeralTaskKeyRef = useRef<string | null>(null);
  if (!ephemeralTaskKeyRef.current) {
    ephemeralTaskKeyRef.current = createEphemeralExportProgressTaskKey();
  }
  const taskKey = configuredTaskKey || ephemeralTaskKeyRef.current;
  const retainAfterUnmount = configuredTaskKey !== '';

  const subscribe = useCallback(
    (listener: () => void) => subscribeExportProgressTask(taskKey, listener, retainAfterUnmount),
    [retainAfterUnmount, taskKey],
  );
  const getSnapshot = useCallback(
    () => getExportProgressTaskSnapshot(taskKey, retainAfterUnmount),
    [retainAfterUnmount, taskKey],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const state = snapshot.state;

  useEffect(() => {
    if (!configuredRequestKey || configuredRequestKey === state.requestKey) {
      return;
    }
    consumeExportProgressTaskRequest(taskKey, configuredRequestKey);
  }, [configuredRequestKey, state.requestKey, state.status, taskKey]);

  const reset = useCallback(() => {
    resetExportProgressTask(taskKey);
  }, [taskKey]);

  const runExportWithProgress = useCallback(async <T extends ExportRunResult,>(
    runOptions: RunExportWithProgressOptions<T>,
  ): Promise<T | null> => {
    if (isExportProgressTaskRunning(taskKey)) {
      if (showToast) {
        void message.warning(t('data_export.message.already_running'));
      }
      return null;
    }

    const jobId = buildExportJobId();
    const requestedTotal = normalizeCount(runOptions.totalRows);
    const totalRowsKnown = hasUsableTotalRows(
      Number.isFinite(runOptions.totalRows) && Number(runOptions.totalRows) >= 0,
      requestedTotal,
    );
    const started = startExportProgressTask(taskKey, {
      open: true,
      jobId,
      title: runOptions.title,
      targetName: String(runOptions.targetName || '').trim(),
      format: String(runOptions.format || '').trim().toUpperCase(),
      startedAt: 0,
      finishedAt: 0,
      status: 'start',
      stage: t('data_export.progress.stage.waiting_file_selection'),
      current: 0,
      total: totalRowsKnown ? requestedTotal : 0,
      totalRowsKnown,
      filePath: '',
      message: '',
      requestKey: configuredRequestKey,
    }, retainAfterUnmount);
    if (!started) {
      if (showToast) {
        void message.warning(t('data_export.message.already_running'));
      }
      return null;
    }

    try {
      const result = await runOptions.run(jobId);
      if (result.success) {
        if (!downloadBrowserFileFromResult(result as any)) {
          throw new Error(t('data_export.message.export_failed', { error: 'Browser download is unavailable' }));
        }
        finishExportProgressTask(taskKey, jobId, (prev): ExportProgressState => ({
          ...prev,
          open: true,
          status: 'done',
          finishedAt: prev.finishedAt || Date.now(),
          stage: prev.stage || t('data_export.progress.title.done'),
          current: prev.totalRowsKnown ? Math.max(prev.current, prev.total) : prev.current,
          message: '',
        }));
        if (showToast) {
          void message.success(t('data_export.message.export_success'));
        }
      } else if (result.message !== EXPORT_CANCELED_MESSAGE) {
        finishExportProgressTask(taskKey, jobId, (prev): ExportProgressState => ({
          ...prev,
          open: true,
          status: 'error',
          finishedAt: prev.finishedAt || Date.now(),
          stage: prev.stage || t('data_export.progress.title.error'),
          message: result.message,
        }));
        if (showToast) {
          void message.error(t('data_export.message.export_failed', { error: result.message }));
        }
      } else {
        resetExportProgressTask(taskKey);
      }
      return result;
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      finishExportProgressTask(taskKey, jobId, (prev): ExportProgressState => ({
        ...prev,
        open: true,
        status: 'error',
        finishedAt: prev.finishedAt || Date.now(),
        stage: prev.stage || t('data_export.progress.title.error'),
        message: errorMessage,
      }));
      if (showToast) {
        void message.error(t('data_export.message.export_failed', { error: errorMessage }));
      }
      throw error;
    }
  }, [configuredRequestKey, retainAfterUnmount, showToast, taskKey]);

  return {
    state,
    logs: snapshot.logs,
    taskKey,
    reset,
    runExportWithProgress,
    isRunning: state.status === 'start' || state.status === 'running' || state.status === 'finalizing',
  };
}
