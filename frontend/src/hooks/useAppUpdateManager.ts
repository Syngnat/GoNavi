import { type UseAppUpdateManagerOptions } from './appUpdate/appUpdateTypes';
import { useAppUpdateState } from './appUpdate/hooks/useAppUpdateState';
import { useAppUpdateDownload } from './appUpdate/hooks/useAppUpdateDownload';
import { useAppUpdateCheck } from './appUpdate/hooks/useAppUpdateCheck';
import { useAppUpdateEffects } from './appUpdate/hooks/useAppUpdateEffects';
export type {
  UpdateChannel,
  UpdateInstallMode,
  UpdatePackageType,
  UpdateInfo,
  UpdateCenterBridge,
} from './appUpdate/appUpdateTypes';
export { resolveUpdateInstallAction } from './appUpdate/appUpdateNormalizers';
export type { UpdateInstallAction } from './appUpdate/appUpdateNormalizers';

export const useAppUpdateManager = ({
  runtimeBuildType,
  t,
  updateCenterBridgeRef,
  onManualCheckHasUpdateRef,
}: UseAppUpdateManagerOptions) => {
  const {
    autoCheckForUpdates, autoCheckForUpdatesIntervalMinutes, updateCheckInFlightRef,
    updateCheckCompletionRef, updateDownloadInFlightRef, intendedUpdateChannelRef,
    hasExplicitUpdateChannelIntentRef, updateChannelChangeRequestRef, updateDownloadStartRequestRef,
    updateDownloadTaskIdRef, updateDownloadTaskStatusRef, updateDownloadTaskHydratingRef,
    updateUserDismissedRef, updateDownloadedVersionRef, updateInstallTriggeredVersionRef,
    updateDownloadMetaRef, updateNotifiedVersionRef, updateMutedVersionRef, isUpdateCenterOpen,
    openUpdateCenter, closeUpdateCenter, aboutLoading, setAboutLoading, updateChannel,
    setUpdateChannelState, installMode, setInstallMode, isUpdateChannelLoading,
    setIsUpdateChannelLoading, isUpdateChannelSaving, setIsUpdateChannelSaving,
    isCheckingForUpdates, setIsCheckingForUpdates, aboutInfo, setAboutInfo, aboutUpdateStatus,
    setAboutUpdateStatus, lastUpdateInfo, setLastUpdateInfo, updateDownloadProgress,
    setUpdateDownloadProgress, updateDownloadProgressRef, aboutDisplayVersion, lastUpdateKey,
    formatAboutUpdateStatus, formatBytes, captureUpdateDownloadTaskSession,
    isCurrentUpdateDownloadTaskSession, advanceUpdateDownloadTaskSession, resetLocalUpdateArtifacts,
    applyUpdateDownloadTaskSnapshot, refreshUpdateDownloadTask,
  } = useAppUpdateState({ updateCenterBridgeRef, runtimeBuildType, t });

  const {
    downloadUpdate, showUpdateDownloadProgress, hideUpdateDownloadProgress,
    isLatestUpdateDownloaded, isBackgroundProgressForLatestUpdate, canShowProgressEntry,
    handleInstallFromProgress, openDownloadedUpdateDirectory,
  } = useAppUpdateDownload({
    t, updateDownloadInFlightRef, updateDownloadTaskStatusRef, updateDownloadedVersionRef,
    updateDownloadMetaRef, advanceUpdateDownloadTaskSession, updateDownloadStartRequestRef,
    updateUserDismissedRef, updateDownloadProgressRef, setUpdateDownloadProgress,
    isCurrentUpdateDownloadTaskSession, applyUpdateDownloadTaskSnapshot, refreshUpdateDownloadTask,
    setInstallMode, setLastUpdateInfo, setAboutUpdateStatus, formatAboutUpdateStatus,
    lastUpdateInfo, lastUpdateKey, updateDownloadProgress, updateInstallTriggeredVersionRef,
  });

  const {
    checkForUpdates, prepareAboutSurface, changeUpdateChannel, muteLatestUpdate,
    markUpdateProgressDismissed,
  } = useAppUpdateCheck({
    t, onManualCheckHasUpdateRef, updateCheckInFlightRef, updateCheckCompletionRef,
    captureUpdateDownloadTaskSession, updateChannelChangeRequestRef, setIsCheckingForUpdates,
    setAboutUpdateStatus, isCurrentUpdateDownloadTaskSession, hasExplicitUpdateChannelIntentRef,
    intendedUpdateChannelRef, setUpdateChannelState, setInstallMode, isUpdateCenterOpen,
    updateDownloadedVersionRef, updateDownloadMetaRef, setUpdateDownloadProgress, setLastUpdateInfo,
    formatAboutUpdateStatus, updateMutedVersionRef, updateNotifiedVersionRef, openUpdateCenter,
    setAboutLoading, setAboutInfo, lastUpdateInfo, setIsUpdateChannelLoading,
    resetLocalUpdateArtifacts, setIsUpdateChannelSaving, installMode, lastUpdateKey,
    closeUpdateCenter, updateUserDismissedRef, autoCheckForUpdates,
    autoCheckForUpdatesIntervalMinutes,
  });

  const { updateInstallAction } = useAppUpdateEffects({
    t, captureUpdateDownloadTaskSession, updateInstallTriggeredVersionRef,
    applyUpdateDownloadTaskSnapshot, updateDownloadTaskHydratingRef, updateDownloadProgressRef,
    updateDownloadTaskIdRef, hasExplicitUpdateChannelIntentRef, updateDownloadInFlightRef,
    setLastUpdateInfo, lastUpdateInfo, setUpdateChannelState, setInstallMode,
    updateUserDismissedRef, updateDownloadTaskStatusRef, setUpdateDownloadProgress,
    refreshUpdateDownloadTask,
  });

  return {
    aboutDisplayVersion,
    aboutInfo,
    aboutLoading,
    aboutUpdateStatus,
    canShowProgressEntry,
    changeUpdateChannel,
    checkForUpdates,
    downloadUpdate,
    formatBytes,
    handleInstallFromProgress,
    hideUpdateDownloadProgress,
    isBackgroundProgressForLatestUpdate,
    isCheckingForUpdates,
    isLatestUpdateDownloaded,
    isUpdateChannelLoading,
    isUpdateChannelSaving,
    installMode,
    lastUpdateInfo,
    markUpdateProgressDismissed,
    muteLatestUpdate,
    openDownloadedUpdateDirectory,
    prepareAboutSurface,
    showUpdateDownloadProgress,
    updateChannel,
    updateDownloadProgress,
    updateInstallAction,
  };
};
