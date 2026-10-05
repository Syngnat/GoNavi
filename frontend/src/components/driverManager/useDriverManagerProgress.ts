import { useCallback } from 'react';
import {
  type DriverProgressState,
  isDriverProgressTerminalStatus,
} from '../../utils/driverProgress';
import {
  shouldIgnoreDriverDownloadProgress,
  isDriverDownloadTerminal,
  type DriverDownloadTaskSnapshot,
  extractDriverDownloadTaskSnapshots,
  nextDriverActionStateAfterCancel,
} from './driverDownloadCancellation';
import { ListDriverDownloadTasks } from '../../../wailsjs/go/app/App';
import { useDriverDownloadCancellation } from './useDriverDownloadCancellation';
import type { DriverManagerStateApi } from './useDriverManagerState';

export interface UseDriverManagerProgressInput {
  setOperationLogMap: DriverManagerStateApi['setOperationLogMap'];
  progressMapRef: DriverManagerStateApi['progressMapRef'];
  cancelIntentsRef: DriverManagerStateApi['cancelIntentsRef'];
  progressTaskIdMapRef: DriverManagerStateApi['progressTaskIdMapRef'];
  updateDriverProgress: DriverManagerStateApi['updateDriverProgress'];
  resolveDriverErrorMessage: DriverManagerStateApi['resolveDriverErrorMessage'];
  setActionState: DriverManagerStateApi['setActionState'];
}

export const useDriverManagerProgress = ({
  setOperationLogMap,
  progressMapRef,
  cancelIntentsRef,
  progressTaskIdMapRef,
  updateDriverProgress,
  resolveDriverErrorMessage,
  setActionState,
}: UseDriverManagerProgressInput) => {
  const appendOperationLog = useCallback((
    driverType: string,
    text: string,
    signature?: string,
    mode: 'append' | 'update-last' = 'append',
  ) => {
    const normalized = String(driverType || '').trim().toLowerCase();
    const content = String(text || '').trim();
    if (!normalized || !content) {
      return;
    }
    const sign = String(signature || content).trim() || content;
    const now = new Date().toLocaleTimeString();
    setOperationLogMap((prev) => {
      const history = prev[normalized] || [];
      if (history.length > 0) {
        const last = history[history.length - 1];
        if (last.signature === sign) {
          if (mode === 'update-last') {
            if (last.text === content) {
              return prev;
            }
            const nextHistory = [...history];
            nextHistory[nextHistory.length - 1] = {
              ...last,
              text: content,
              time: now,
            };
            return { ...prev, [normalized]: nextHistory };
          }
          return prev;
        }
      }
      const nextHistory = [
        ...history,
        {
          time: now,
          text: content,
          signature: sign,
        },
      ];
      const sliced = nextHistory.length > 200 ? nextHistory.slice(nextHistory.length - 200) : nextHistory;
      return { ...prev, [normalized]: sliced };
    });
  }, []);

  const applyTaskScopedDriverProgress = useCallback((
    taskId: string,
    driverType: string,
    incoming: DriverProgressState,
  ): { applied: boolean; progress?: DriverProgressState } => {
    const normalizedDriverType = String(driverType || '').trim().toLowerCase();
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedDriverType || !normalizedTaskId) {
      return { applied: false };
    }
    const previousProgress = progressMapRef.current[normalizedDriverType];
    if (shouldIgnoreDriverDownloadProgress(incoming.status, cancelIntentsRef.current.isRequested(normalizedDriverType))) {
      return { applied: false, progress: previousProgress };
    }

    const knownTaskId = progressTaskIdMapRef.current[normalizedDriverType];
    if (knownTaskId === normalizedTaskId && isDriverDownloadTerminal(previousProgress)) {
      return { applied: false, progress: previousProgress };
    }
    if (knownTaskId === normalizedTaskId && previousProgress?.status === 'downloading' && incoming.status === 'start') {
      return { applied: false, progress: previousProgress };
    }

    let resetPrevious = false;
    if (knownTaskId && knownTaskId !== normalizedTaskId) {
      if (!isDriverDownloadTerminal(previousProgress)) {
        return { applied: false, progress: previousProgress };
      }
      resetPrevious = true;
    } else if (!knownTaskId && isDriverDownloadTerminal(previousProgress)) {
      resetPrevious = true;
    }

    progressTaskIdMapRef.current = {
      ...progressTaskIdMapRef.current,
      [normalizedDriverType]: normalizedTaskId,
    };
    const progress = updateDriverProgress(normalizedDriverType, incoming, { resetPrevious });
    return { applied: !!progress, progress };
  }, [updateDriverProgress]);

  const applyDriverDownloadTaskSnapshot = useCallback((task: DriverDownloadTaskSnapshot) => {
    const application = applyTaskScopedDriverProgress(task.taskId, task.driverType, {
      status: task.status,
      message: task.message || '',
      percent: task.percent,
    });
    if (!application.applied || !application.progress) {
      return false;
    }
    const nextProgress = application.progress;
    const statusText = String(nextProgress.status || '').toUpperCase();
    const messageText = nextProgress.message || '-';
    appendOperationLog(
      task.driverType,
      messageText,
      `driver-progress:${statusText}:${messageText}`,
      'update-last',
    );
    return isDriverProgressTerminalStatus(task.status);
  }, [appendOperationLog, applyTaskScopedDriverProgress]);

  const refreshDriverDownloadTasks = useCallback(async (): Promise<boolean> => {
    try {
      const result = await ListDriverDownloadTasks();
      if (!result?.success) {
        return false;
      }
      let hasTerminalTask = false;
      extractDriverDownloadTaskSnapshots(result.data).forEach((task) => {
        hasTerminalTask = applyDriverDownloadTaskSnapshot(task) || hasTerminalTask;
      });
      return hasTerminalTask;
    } catch (error) {
      console.warn('Wails API: ListDriverDownloadTasks unavailable', error);
      return false;
    }
  }, [applyDriverDownloadTaskSnapshot]);

  const {
    batchCancellation,
    cancelIntents,
    installSessions,
    cancelDriverDownload,
    cancelDriverDownloadTask,
    cancelAllDriverDownloads,
  } = useDriverDownloadCancellation({
    progressTaskIdMapRef,
    progressMapRef,
    cancelIntents: cancelIntentsRef.current,
    applyDriverDownloadTaskSnapshot,
    updateDriverProgress,
    appendOperationLog,
    resolveDriverErrorMessage,
    onReleaseInstallAction: (driverType) => setActionState((prev) => nextDriverActionStateAfterCancel(prev, driverType)),
  });
  return {
    appendOperationLog,
    applyTaskScopedDriverProgress,
    applyDriverDownloadTaskSnapshot,
    refreshDriverDownloadTasks,
    batchCancellation,
    cancelIntents,
    installSessions,
    cancelDriverDownload,
    cancelDriverDownloadTask,
    cancelAllDriverDownloads,
  };
};

export type DriverManagerProgressApi = ReturnType<typeof useDriverManagerProgress>;
