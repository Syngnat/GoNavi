import { useCallback, useEffect } from 'react';
import { message, Button } from 'antd';
import type { ApplicationQuitConfirmedAction } from '../appLayoutParts';
import { prepareApplicationQuitPersistence } from '../../utils/applicationQuitPersistence';
import { flushQueryTabDraftSnapshots } from '../../utils/sqlFileTabDrafts';
import { flushAppStatePersistence, useStore } from '../../store';
import {
  collectApplicationQuitUnsavedSQLTargets,
  buildApplicationQuitUnsavedSQLLabel,
  saveLatestApplicationQuitUnsavedSQLState,
} from '../../utils/sqlEditorApplicationQuit';
import Modal from '../../components/common/ResizableDraggableModal';
import { discardApplicationQuitUnsavedSQLChanges } from '../../utils/sqlEditorQuitDiscard';
import { EventsOn } from '../../../wailsjs/runtime';
import { createClosedConnectionPackageDialogState } from '../connectionPackageImport';
import type { ToolCenterGroupKey } from '../settingsCenterPanes';
import { SavedConnection } from '../../types';
import { GetSavedConnections } from '../../../wailsjs/go/app/App';
import { mergeSavedConnections } from '../appEnvironment';
import type { AppSecurityUpdateApi } from './useAppSecurityUpdate';
import type { AppUpdateAndDiagnosticsApi } from './useAppUpdateAndDiagnostics';
import type { AppShellStateApi } from './useAppShellState';
import type { AppCoreStateApi } from './useAppCoreState';
import type { AppBootstrapEffectsApi } from './useAppBootstrapEffects';

export interface UseAppQuitAndUpdateInput {
  applicationQuitHandlingRef: AppSecurityUpdateApi['applicationQuitHandlingRef'];
  resetApplicationQuitRequest: AppUpdateAndDiagnosticsApi['resetApplicationQuitRequest'];
  aiSettingsLeaveGuardRef: AppShellStateApi['aiSettingsLeaveGuardRef'];
  captureMainWindowStateRef: AppShellStateApi['captureMainWindowStateRef'];
  connectionSidebarLayoutCoordinatorRef: AppShellStateApi['connectionSidebarLayoutCoordinatorRef'];
  forceQuitApplication: AppUpdateAndDiagnosticsApi['forceQuitApplication'];
  t: AppCoreStateApi['t'];
  ensureSavedQueriesLoaded: AppBootstrapEffectsApi['ensureSavedQueriesLoaded'];
  applicationQuitModalZIndex: AppShellStateApi['applicationQuitModalZIndex'];
  applicationQuitConfirmRef: AppSecurityUpdateApi['applicationQuitConfirmRef'];
  saveQuery: AppSecurityUpdateApi['saveQuery'];
  hideUpdateDownloadProgress: AppUpdateAndDiagnosticsApi['hideUpdateDownloadProgress'];
  handleInstallFromProgress: AppUpdateAndDiagnosticsApi['handleInstallFromProgress'];
  showUpdateDownloadProgress: AppUpdateAndDiagnosticsApi['showUpdateDownloadProgress'];
  setConnectionPackageDialog: AppShellStateApi['setConnectionPackageDialog'];
  setPendingConnectionImportPayload: AppShellStateApi['setPendingConnectionImportPayload'];
  setConnectionImportNotice: AppShellStateApi['setConnectionImportNotice'];
  setToolCenterBackGroupKey: React.Dispatch<React.SetStateAction<ToolCenterGroupKey | null>>;
  replaceConnections: AppCoreStateApi['replaceConnections'];
}

export const useAppQuitAndUpdate = ({
  applicationQuitHandlingRef, resetApplicationQuitRequest, aiSettingsLeaveGuardRef,
  captureMainWindowStateRef, connectionSidebarLayoutCoordinatorRef, forceQuitApplication, t,
  ensureSavedQueriesLoaded, applicationQuitModalZIndex, applicationQuitConfirmRef, saveQuery,
  hideUpdateDownloadProgress, handleInstallFromProgress, showUpdateDownloadProgress,
  setConnectionPackageDialog, setPendingConnectionImportPayload, setConnectionImportNotice,
  setToolCenterBackGroupKey, replaceConnections,
}: UseAppQuitAndUpdateInput) => {
  const handleApplicationQuitRequest = useCallback(async (
      confirmedAction?: ApplicationQuitConfirmedAction,
      cancelledAction?: () => void,
  ) => {
      if (applicationQuitHandlingRef.current) {
          return;
      }
      applicationQuitHandlingRef.current = true;

      const cancelRequest = () => {
          resetApplicationQuitRequest();
          cancelledAction?.();
      };

      const runConfirmedAction = async (): Promise<boolean> => {
          let accepted = false;
          try {
              const leaveGuard = aiSettingsLeaveGuardRef.current;
              if (leaveGuard && !(await leaveGuard())) {
                  cancelRequest();
                  return false;
              }
              await prepareApplicationQuitPersistence({
                  captureWindowState: () => captureMainWindowStateRef.current(),
                  flushDrafts: flushQueryTabDraftSnapshots,
                  flushAppState: async () => {
                      await flushAppStatePersistence();
                      await connectionSidebarLayoutCoordinatorRef.current?.flush();
                  },
              });
              if (confirmedAction) {
                  accepted = await confirmedAction();
              } else {
                  await forceQuitApplication();
                  accepted = true;
              }
          } catch (error) {
              cancelRequest();
              message.error(t('app.quit.message.quit_failed', {
                  detail: error instanceof Error ? error.message : String(error),
              }));
              return false;
          }
          if (!accepted) {
              cancelRequest();
          }
          return accepted;
      };

      let targets;
      try {
          await ensureSavedQueriesLoaded();
          const latestState = useStore.getState();
          targets = await collectApplicationQuitUnsavedSQLTargets(
              latestState.tabs,
              latestState.savedQueries,
          );
      } catch (error) {
          cancelRequest();
          message.error(t('app.quit.unsaved_sql.inspect_failed', {
              detail: error instanceof Error ? error.message : String(error),
          }));
          return;
      }

      if (targets.length === 0) {
          await runConfirmedAction();
          return;
      }

      const label = buildApplicationQuitUnsavedSQLLabel(targets);
      await new Promise<void>((resolve) => {
          let finished = false;
          const finish = () => {
              if (finished) return;
              finished = true;
              resolve();
          };
          const runConfirmedActionAndFinish = async () => {
              try {
                  await runConfirmedAction();
              } finally {
                  finish();
              }
          };

          let destroyConfirm: (() => void) | null = null;
          const confirmRef = Modal.confirm({
              title: t('app.quit.unsaved_sql.title'),
              content: t(targets.length === 1
                  ? 'app.quit.unsaved_sql.content_single'
                  : 'app.quit.unsaved_sql.content_multiple', { label }),
              okText: t('app.quit.unsaved_sql.save_exit'),
              cancelText: t('app.quit.unsaved_sql.cancel'),
              centered: true,
              closable: true,
              maskClosable: false,
              zIndex: applicationQuitModalZIndex,
              okButtonProps: { danger: true, type: 'primary' },
              footer: (_, { OkBtn, CancelBtn }) => (
                  <>
                      <Button
                        onClick={() => {
                            destroyConfirm?.();
                            applicationQuitConfirmRef.current = null;
                            void discardApplicationQuitUnsavedSQLChanges().then(runConfirmedActionAndFinish);
                        }}
                      >
                          {t('app.quit.unsaved_sql.confirm_exit')}
                      </Button>
                      <CancelBtn />
                      <OkBtn />
                  </>
              ),
              onCancel: () => {
                  cancelRequest();
                  finish();
              },
              onOk: async () => {
                  try {
                      await saveLatestApplicationQuitUnsavedSQLState({
                          getState: () => {
                              const latestState = useStore.getState();
                              return {
                                  tabs: latestState.tabs,
                                  savedQueries: latestState.savedQueries,
                              };
                          },
                          updateTabs: (update) => {
                              useStore.setState((state) => ({ tabs: update(state.tabs) }));
                          },
                          saveQuery,
                      });
                      message.success(t('app.quit.unsaved_sql.saved'));
                  } catch (error) {
                      cancelRequest();
                      finish();
                      message.error(t('app.quit.unsaved_sql.save_failed_cancel_exit', {
                          detail: error instanceof Error ? error.message : String(error),
                      }));
                      throw error;
                  }
                  await runConfirmedActionAndFinish();
              },
          });
          destroyConfirm = confirmRef.destroy;
          applicationQuitConfirmRef.current = confirmRef;
      });
  }, [applicationQuitModalZIndex, ensureSavedQueriesLoaded, forceQuitApplication, resetApplicationQuitRequest, saveQuery, t]);

  const handleInstallUpdateRequest = useCallback(async () => {
      let pendingCloseInstanceCount: number | null = null;
      hideUpdateDownloadProgress();
      await handleApplicationQuitRequest(
          () => handleInstallFromProgress(false, (instanceCount) => {
              pendingCloseInstanceCount = instanceCount;
          }),
          () => {
              if (pendingCloseInstanceCount === null) {
                  showUpdateDownloadProgress();
              }
          },
      );
      if (pendingCloseInstanceCount === null) {
          return;
      }
      Modal.confirm({
          title: t('app.about.update_install_confirm.close_instances_title', { count: pendingCloseInstanceCount }),
          content: t('app.about.update_install_confirm.close_instances_content'),
          okText: t('app.about.update_install_confirm.close_instances_ok'),
          cancelText: t('common.cancel'),
          centered: true,
          closable: true,
          maskClosable: false,
          zIndex: applicationQuitModalZIndex,
          okButtonProps: { danger: true, type: 'primary' },
          onCancel: () => {
              showUpdateDownloadProgress();
          },
          onOk: async () => {
              await handleInstallFromProgress(true);
          },
      });
  }, [applicationQuitModalZIndex, handleApplicationQuitRequest, handleInstallFromProgress, hideUpdateDownloadProgress, showUpdateDownloadProgress, t]);

  useEffect(() => {
      const offBeforeClose = EventsOn('app:before-close-request', () => {
          void handleApplicationQuitRequest();
      });
      return () => {
          offBeforeClose();
      };
  }, [handleApplicationQuitRequest]);

  const closeConnectionPackageDialog = useCallback(() => {
      setConnectionPackageDialog(createClosedConnectionPackageDialogState());
      setPendingConnectionImportPayload(null);
      setConnectionImportNotice(null);
      setToolCenterBackGroupKey(null);
  }, []);

  const refreshConnectionsAfterImport = useCallback(async (importedViews: SavedConnection[]) => {
      const backendApp = (window as any).go?.app?.App;
      if (typeof backendApp?.GetSavedConnections === 'function') {
          let latestConnections: unknown;
          try {
              latestConnections = await GetSavedConnections();
          } catch (error) {
              const detail = error instanceof Error ? error.message : String(error ?? '').trim();
              throw new Error(
                  detail
                      ? t('app.connection_package.message.import_failed_with_error', { error: detail })
                      : t('app.connection_package.message.import_failed'),
              );
          }
          if (!Array.isArray(latestConnections)) {
              throw new Error(t('app.connection_package.error.refresh_failed_no_connections'));
          }
          replaceConnections(latestConnections as SavedConnection[]);
          return;
      }

      const latestConnections = useStore.getState().connections;
      replaceConnections(mergeSavedConnections(latestConnections, importedViews));
  }, [replaceConnections]);
  return {
    handleApplicationQuitRequest, handleInstallUpdateRequest, closeConnectionPackageDialog,
    refreshConnectionsAfterImport,
  };
};

export type AppQuitAndUpdateApi = ReturnType<typeof useAppQuitAndUpdate>;
