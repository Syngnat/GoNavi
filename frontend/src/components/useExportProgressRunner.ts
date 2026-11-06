import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { message } from 'antd';
import { t } from '../i18n';
import { CancelExportFile } from '../../wailsjs/go/app/App';
import { downloadBrowserFileFromResult } from '../utils/browserFileTransfer';
import { isWebRequestTooLargeError } from './exportErrorMessage';
import {
  cancelExportProgressTask,
  createEphemeralExportProgressTaskKey,
  consumeExportProgressTaskRequest,
  finishExportProgressTask,
  getExportProgressTaskSnapshot,
  isExportProgressTaskRunning,
  resetExportProgressTask,
  revertCancelExportProgressTask,
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
  data?: unknown;
};

export type RunExportWithProgressOptions<T extends ExportRunResult> = {
  title: string;
  targetName: string;
  format: string;
  totalRows?: number;
  run: (jobId: string) => Promise<T>;
  shouldPublishResult?: (result?: T) => boolean;
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

// 运行期取消（CancelExportFile 路径）带结构化标记；保存对话框取消只有旧文案、
// 依旧按「任务未开始」静默重置，两者语义不同不能混用。
const hasStructuredCancelMark = (result: ExportRunResult | null): boolean => {
  if (!result || result.success) {
    return false;
  }
  const data = result.data as { canceled?: unknown; outcomeUnknown?: unknown } | undefined;
  return data?.canceled === true && data.outcomeUnknown !== true;
};

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

  // cancelExport 把任务标记为 cancelling 并向后端分发取消信号；后端确认后
  // 协作式停止，run 结果以 data.canceled 收尾归档为 cancelled 终态。
  // 后端拒绝（任务不存在、IPC 异常）时回退 cancelling，让任务保持可关闭/可重试。
  const cancelExport = useCallback(async (): Promise<boolean> => {
    if (!isExportProgressTaskRunning(taskKey)) {
      return false;
    }
    const jobId = String(getExportProgressTaskSnapshot(taskKey).state.jobId || '').trim();
    if (!jobId) {
      return false;
    }
    if (!cancelExportProgressTask(taskKey)) {
      return false;
    }
    try {
      const response = await CancelExportFile(jobId);
      if (!response?.success) {
        revertCancelExportProgressTask(taskKey);
        if (showToast && response?.message) {
          void message.warning(response.message);
        }
        return false;
      }
      return true;
    } catch (error: any) {
      revertCancelExportProgressTask(taskKey);
      if (showToast) {
        void message.warning(error?.message || String(error));
      }
      return false;
    }
  }, [showToast, taskKey]);

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
      const publish = !runOptions.shouldPublishResult || (getExportProgressTaskSnapshot(taskKey).state.jobId === jobId && runOptions.shouldPublishResult(result));
      if (result.success) {
        if (publish && !downloadBrowserFileFromResult(result as any)) {
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
        if (showToast && publish) {
          void message.success(t('data_export.message.export_success'));
        }
      } else if (hasStructuredCancelMark(result)) {
        finishExportProgressTask(taskKey, jobId, (prev): ExportProgressState => ({
          ...prev,
          open: true,
          status: 'cancelled',
          finishedAt: prev.finishedAt || Date.now(),
          stage: prev.stage || t('data_export.progress.title.cancelled'),
          message: result.message || '',
        }));
        if (showToast && publish) {
          void message.info(t('data_export.progress.title.cancelled'));
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
        if (showToast && publish) {
          void message.error(t('data_export.message.export_failed', { error: result.message }));
        }
      } else {
        resetExportProgressTask(taskKey);
      }
      return result;
    } catch (error: any) {
      const rawMessage = error?.message || String(error);
      // The browser build rejects oversized invoke bodies before the export
      // service runs; point the user at the re-query path instead of the bare 413.
      const errorMessage = isWebRequestTooLargeError(error, rawMessage)
        ? t('data_export.message.request_too_large')
        : rawMessage;
      const publish = !runOptions.shouldPublishResult || (getExportProgressTaskSnapshot(taskKey).state.jobId === jobId && runOptions.shouldPublishResult());
      finishExportProgressTask(taskKey, jobId, (prev): ExportProgressState => ({
        ...prev,
        open: true,
        status: 'error',
        finishedAt: prev.finishedAt || Date.now(),
        stage: prev.stage || t('data_export.progress.title.error'),
        message: errorMessage,
      }));
      if (showToast && publish) {
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
    cancelExport,
    runExportWithProgress,
    isRunning: state.status === 'start' || state.status === 'running' || state.status === 'finalizing' || state.status === 'cancelling',
  };
}
