import { useEffect } from 'react';
import { EventsOn } from '../../../../wailsjs/runtime';
import type { UpdateDownloadProgressEvent, UpdateDownloadProgressState } from '../appUpdateTypes';
import {
  normalizeUpdateDownloadTaskSnapshot,
  buildUpdateKey,
  normalizeUpdateInfo,
  normalizeUpdateChannel,
  normalizeUpdateInstallMode,
  resolveUpdateInstallAction,
} from '../appUpdateNormalizers';
import type { AppUpdateStateApi } from './useAppUpdateState';
import type { UseAppUpdateManagerOptions } from '../appUpdateTypes';

export interface UseAppUpdateEffectsInput {
  t: UseAppUpdateManagerOptions['t'];
  captureUpdateDownloadTaskSession: AppUpdateStateApi['captureUpdateDownloadTaskSession'];
  updateInstallTriggeredVersionRef: AppUpdateStateApi['updateInstallTriggeredVersionRef'];
  applyUpdateDownloadTaskSnapshot: AppUpdateStateApi['applyUpdateDownloadTaskSnapshot'];
  updateDownloadTaskHydratingRef: AppUpdateStateApi['updateDownloadTaskHydratingRef'];
  updateDownloadProgressRef: AppUpdateStateApi['updateDownloadProgressRef'];
  updateDownloadTaskIdRef: AppUpdateStateApi['updateDownloadTaskIdRef'];
  hasExplicitUpdateChannelIntentRef: AppUpdateStateApi['hasExplicitUpdateChannelIntentRef'];
  updateDownloadInFlightRef: AppUpdateStateApi['updateDownloadInFlightRef'];
  setLastUpdateInfo: AppUpdateStateApi['setLastUpdateInfo'];
  lastUpdateInfo: AppUpdateStateApi['lastUpdateInfo'];
  setUpdateChannelState: AppUpdateStateApi['setUpdateChannelState'];
  setInstallMode: AppUpdateStateApi['setInstallMode'];
  updateUserDismissedRef: AppUpdateStateApi['updateUserDismissedRef'];
  updateDownloadTaskStatusRef: AppUpdateStateApi['updateDownloadTaskStatusRef'];
  setUpdateDownloadProgress: AppUpdateStateApi['setUpdateDownloadProgress'];
  refreshUpdateDownloadTask: AppUpdateStateApi['refreshUpdateDownloadTask'];
}

export const useAppUpdateEffects = ({
  t, captureUpdateDownloadTaskSession, updateInstallTriggeredVersionRef,
  applyUpdateDownloadTaskSnapshot, updateDownloadTaskHydratingRef, updateDownloadProgressRef,
  updateDownloadTaskIdRef, hasExplicitUpdateChannelIntentRef, updateDownloadInFlightRef,
  setLastUpdateInfo, lastUpdateInfo, setUpdateChannelState, setInstallMode, updateUserDismissedRef,
  updateDownloadTaskStatusRef, setUpdateDownloadProgress, refreshUpdateDownloadTask,
}: UseAppUpdateEffectsInput) => {
  useEffect(() => {
    let offDownloadProgress: any = null;
    try {
      offDownloadProgress = EventsOn('update:download-progress', (event: UpdateDownloadProgressEvent) => {
        if (!event) return;
        const session = captureUpdateDownloadTaskSession();
        const taskId = String(event.taskId || '').trim();
        if (taskId) {
          const task = normalizeUpdateDownloadTaskSnapshot({
            taskId,
            status: event.status || 'downloading',
            percent: event.percent,
            downloaded: event.downloaded,
            total: event.total,
            message: event.message,
            info: event.info,
          });
          if (!task) {
            return;
          }
          const eventKey = buildUpdateKey(task.info);
          if (updateInstallTriggeredVersionRef.current
            && eventKey
            && updateInstallTriggeredVersionRef.current === eventKey) {
            return;
          }
          applyUpdateDownloadTaskSnapshot(task, {
            session,
            source: 'event',
            notifyTerminal: true,
            suppressOpen: updateDownloadTaskHydratingRef.current && !updateDownloadProgressRef.current.open,
          });
          return;
        }

        // Older backends did not include taskId. Keep their event stream
        // usable only when there is no task-scoped download to protect a new
        // background task from stale legacy events.
        if (updateDownloadTaskIdRef.current) {
          return;
        }
        const eventInfo = event.info && typeof event.info === 'object'
          ? normalizeUpdateInfo(event.info)
          : null;
        const eventKey = buildUpdateKey(eventInfo);
        if (hasExplicitUpdateChannelIntentRef.current
          && eventInfo
          && normalizeUpdateChannel(eventInfo.channel) !== session.channel) {
          return;
        }
        // A legacy event has no task ID to bind to an epoch. It can only win
        // the initial hydration/start race; after a reset it is unsafe to
        // treat it as a new task.
        if (!updateDownloadTaskHydratingRef.current && !updateDownloadInFlightRef.current) {
          return;
        }
        const expectedKey = updateDownloadProgressRef.current.key;
        if (expectedKey && eventKey && eventKey !== expectedKey) {
          return;
        }
        if (eventInfo) {
          setLastUpdateInfo((current) => {
            if (buildUpdateKey(current) === eventKey
              && Boolean(current?.downloaded) === Boolean(eventInfo.downloaded)
              && current?.downloadPath === eventInfo.downloadPath) {
              return current;
            }
            return eventInfo;
          });
          setUpdateChannelState(normalizeUpdateChannel(eventInfo.channel));
          setInstallMode(normalizeUpdateInstallMode(eventInfo.installMode));
        }
        const status = event.status || 'downloading';
        const nextStatus: 'idle' | 'start' | 'downloading' | 'done' | 'error' =
          status === 'start' || status === 'downloading' || status === 'done' || status === 'error'
            ? status
            : 'downloading';
        const downloaded = typeof event.downloaded === 'number' ? event.downloaded : 0;
        const total = typeof event.total === 'number' ? event.total : 0;
        const percentRaw = typeof event.percent === 'number'
          ? event.percent
          : (total > 0 ? (downloaded / total) * 100 : 0);
        const percent = Math.max(0, Math.min(100, percentRaw));
        const previousProgress = updateDownloadProgressRef.current;
        // 用户已确认安装时，不让残留的下载事件把 100% 就绪态打回中间态文案。
        if (updateInstallTriggeredVersionRef.current
          && previousProgress.key
          && updateInstallTriggeredVersionRef.current === previousProgress.key) {
          return;
        }
        const eventMessage = String(event.message || '');
        let eventMessageText = eventMessage;
        if (!eventMessageText) {
          if (nextStatus === 'done') {
            eventMessageText = resolveUpdateInstallAction(eventInfo || lastUpdateInfo) === 'restart'
              ? t('app.about.download_progress.ready_to_restart')
              : t('app.about.download_progress.ready_to_install');
          } else if (nextStatus === 'start' || nextStatus === 'downloading') {
            eventMessageText = t('app.about.download_progress.downloading');
          }
        }
        const nextProgress: UpdateDownloadProgressState = {
          open: previousProgress.open || !updateUserDismissedRef.current,
          version: eventInfo?.latestVersion || previousProgress.version,
          key: eventKey || previousProgress.key,
          status: nextStatus,
          percent: nextStatus === 'done' ? 100 : percent,
          downloaded: nextStatus === 'done' && total > 0 ? total : downloaded,
          total: total > 0 ? total : previousProgress.total,
          message: eventMessageText,
        };
        updateDownloadTaskStatusRef.current = nextStatus;
        updateDownloadProgressRef.current = nextProgress;
        setUpdateDownloadProgress(nextProgress);
      });
    } catch (e) {
      console.warn('Wails API: EventsOn unavailable', e);
    }
    return () => {
      if (offDownloadProgress) offDownloadProgress();
    };
  }, [applyUpdateDownloadTaskSnapshot, captureUpdateDownloadTaskSession, lastUpdateInfo?.autoRelaunch, lastUpdateInfo?.packageType, t]);

  // The listener is registered in the effect above first. Hydrating second
  // avoids a replay gap if a background task changes state during mount.
  useEffect(() => {
    void refreshUpdateDownloadTask({ restoreInBackground: true });
  }, [refreshUpdateDownloadTask]);

  const updateInstallAction = resolveUpdateInstallAction(lastUpdateInfo);
  return { updateInstallAction };
};

export type AppUpdateEffectsApi = ReturnType<typeof useAppUpdateEffects>;
