import { useEffect } from 'react';
import { SyncOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import {
  type ConnectionSidebarLayoutCoordinator,
  createConnectionSidebarLayoutCoordinator,
} from '../../utils/connectionSidebarLayoutCoordinator';
import { useStore } from '../../store';
import { waitForWindowCondition } from '../../utils/windowTransition';
import {
  WindowIsMaximised,
  WindowGetSize,
  WindowGetPosition,
  WindowUnmaximise,
  WindowMaximise,
  WindowSetPosition,
  WindowSetSize,
  WindowIsFullscreen,
  WindowUnfullscreen,
} from '../../../wailsjs/runtime';
import {
  isStartupMaximisedWindowSettled,
  markStartupWindowRestorePending,
  clearStartupWindowRestorePending,
  resolveWorkAreaFillWindowBounds,
  isStartupWindowSurfaceCoveringViewport,
  resolveStartupWindowRestoreMode,
  resolveDefaultStartupWindowBounds,
} from '../../utils/windowStartupLayout';
import { isWindowsPlatform } from '../../utils/appearance';
import { readCurrentVisibleViewport } from '../appEnvironment';
import { markStartupWindowGeometrySettled } from '../../utils/mainWindowStartup';
import { resolveWailsWindowSetPosition } from '../../utils/wailsWindowViewport';
import type { WindowRestoreBounds } from '../../utils/windowRestoreBounds';
import {
  type MainWindowDisplayLayout,
  resolveRuntimeWindowPlacement,
  applyRuntimeWindowPlacement,
  loadMainWindowDisplayLayout,
} from '../../utils/mainWindowDisplayPlacement';
import type { AppShellStateApi } from './useAppShellState';
import type { AppCoreStateApi } from './useAppCoreState';

export interface UseAppStartupEffectsInput {
  isStoreHydrated: AppShellStateApi['isStoreHydrated'];
  hasLoadedSecureConfig: AppShellStateApi['hasLoadedSecureConfig'];
  replaceConnectionSidebarLayout: AppCoreStateApi['replaceConnectionSidebarLayout'];
  notificationApi: AppCoreStateApi['notificationApi'];
  t: AppCoreStateApi['t'];
  connectionSidebarLayoutCoordinatorRef: AppShellStateApi['connectionSidebarLayoutCoordinatorRef'];
  setHasLoadedConnectionSidebarLayout: AppShellStateApi['setHasLoadedConnectionSidebarLayout'];
  emitWindowDiagnostic: (stage: string, extra?: Record<string, unknown>) => Promise<void>;
}

export const useAppStartupEffects = ({
  isStoreHydrated, hasLoadedSecureConfig, replaceConnectionSidebarLayout, notificationApi, t,
  connectionSidebarLayoutCoordinatorRef, setHasLoadedConnectionSidebarLayout, emitWindowDiagnostic,
}: UseAppStartupEffectsInput) => {
  useEffect(() => {
      if (!isStoreHydrated || !hasLoadedSecureConfig) {
          return;
      }

      let cancelled = false;
      const notificationKey = 'connection-sidebar-layout-save-state';
      let coordinator: ConnectionSidebarLayoutCoordinator;
      coordinator = createConnectionSidebarLayoutCoordinator({
          backend: (window as any).go?.app?.App,
          store: {
              getLayout: () => {
                  const state = useStore.getState();
                  return {
                      connectionTags: state.connectionTags,
                      sidebarRootOrder: state.sidebarRootOrder,
                      rootSortMode: state.rootSortMode,
                      rootConnectionSortMode: state.rootConnectionSortMode,
                  };
              },
              replaceLayout: replaceConnectionSidebarLayout,
              subscribe: (listener) => useStore.subscribe((state, previousState) => {
                    if (
                        state.connectionTags !== previousState.connectionTags
                        || state.sidebarRootOrder !== previousState.sidebarRootOrder
                        || state.rootSortMode !== previousState.rootSortMode
                        || state.rootConnectionSortMode !== previousState.rootConnectionSortMode
                    ) {
                      listener();
                  }
              }),
          },
          onError: (error) => {
              console.warn('Failed to synchronize shared connection sidebar layout', error);
          },
          onSaveStateChange: (state) => {
              if (cancelled) return;
              if (state.status === 'saving') {
                  notificationApi.open({
                      key: notificationKey,
                      message: t('app.connection_sidebar_layout.saving'),
                      description: t('app.connection_sidebar_layout.saving_description'),
                      icon: <SyncOutlined spin />,
                      duration: 0,
                      placement: 'bottomRight',
                  });
                  return;
              }
              if (state.status === 'saved') {
                  notificationApi.success({
                      key: notificationKey,
                      message: t('app.connection_sidebar_layout.saved'),
                      description: t('app.connection_sidebar_layout.saved_description'),
                      duration: 2,
                      placement: 'bottomRight',
                  });
                  return;
              }
              if (state.status === 'error') {
                  const detail = state.error instanceof Error
                      ? state.error.message
                      : String(state.error);
                  notificationApi.error({
                      key: notificationKey,
                      message: t('app.connection_sidebar_layout.save_failed'),
                      description: t('app.connection_sidebar_layout.save_failed_description', { detail }),
                      btn: (
                          <Button
                            size="small"
                            type="primary"
                            onClick={() => void coordinator.retryPendingSave().catch(() => undefined)}
                          >
                            {t('app.connection_sidebar_layout.retry_save')}
                          </Button>
                      ),
                      duration: 0,
                      placement: 'bottomRight',
                  });
                  return;
              }
              notificationApi.warning({
                  key: notificationKey,
                  message: t('app.connection_sidebar_layout.conflict'),
                  description: t('app.connection_sidebar_layout.conflict_description'),
                  btn: (
                      <div style={{ display: 'flex', gap: 8 }}>
                          <Button
                            size="small"
                            onClick={() => {
                                coordinator.acceptRemoteLayout();
                                notificationApi.info({
                                    key: notificationKey,
                                    message: t('app.connection_sidebar_layout.remote_applied'),
                                    description: t('app.connection_sidebar_layout.remote_applied_description'),
                                    duration: 2,
                                    placement: 'bottomRight',
                                });
                            }}
                          >
                            {t('app.connection_sidebar_layout.refresh_remote')}
                          </Button>
                          <Button
                            size="small"
                            type="primary"
                            onClick={() => void coordinator.retryPendingSave().catch(() => undefined)}
                          >
                            {t('app.connection_sidebar_layout.retry_save')}
                          </Button>
                      </div>
                  ),
                  duration: 0,
                  placement: 'bottomRight',
              });
          },
          refreshIntervalMs: 2_000,
      });
      connectionSidebarLayoutCoordinatorRef.current = coordinator;
      const flushConnectionSidebarLayout = () => {
          void coordinator.flush().catch((error) => {
              console.warn('Failed to flush shared connection sidebar layout', error);
          });
      };
      const refreshConnectionSidebarLayout = () => {
          void coordinator.refresh().catch(() => undefined);
      };
      const refreshVisibleConnectionSidebarLayout = () => {
          if (document.visibilityState === 'visible') {
              refreshConnectionSidebarLayout();
          }
      };
      window.addEventListener('pagehide', flushConnectionSidebarLayout, true);
      window.addEventListener('beforeunload', flushConnectionSidebarLayout, true);
      window.addEventListener('focus', refreshConnectionSidebarLayout);
      document.addEventListener('visibilitychange', refreshVisibleConnectionSidebarLayout);
      void coordinator.bootstrap().finally(() => {
          if (!cancelled) {
              setHasLoadedConnectionSidebarLayout(true);
          }
      });

      return () => {
          cancelled = true;
          window.removeEventListener('pagehide', flushConnectionSidebarLayout, true);
          window.removeEventListener('beforeunload', flushConnectionSidebarLayout, true);
          window.removeEventListener('focus', refreshConnectionSidebarLayout);
          document.removeEventListener('visibilitychange', refreshVisibleConnectionSidebarLayout);
          notificationApi.destroy(notificationKey);
          coordinator.dispose();
          if (connectionSidebarLayoutCoordinatorRef.current === coordinator) {
              connectionSidebarLayoutCoordinatorRef.current = null;
          }
      };
  }, [hasLoadedSecureConfig, isStoreHydrated, notificationApi, replaceConnectionSidebarLayout, t]);

  useEffect(() => {
      let cancelled = false;
      let startupWindowTimer: number | null = null;
      let restoredOnce = false;
      const maxApplyAttempts = 8;
      const applyRetryDelayMs = 350;
      const settleDelayMs = 180;
      const startupRestoreGraceMs = 6000;
      let refreshWebViewBoundsUnavailableLogged = false;
      let refreshWebViewBoundsDisabled = false;
      const wait = (delayMs: number) => new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));

      const waitForMaximisedState = (expected: boolean): Promise<boolean> => waitForWindowCondition({
          read: async () => (await WindowIsMaximised()) === expected,
          wait,
          isCancelled: () => cancelled,
          maxChecks: 16,
          intervalMs: 40,
      });

      const checkStartupPreferenceApplied = async (): Promise<boolean> => {
          try {
              const [isMaximised, size] = await Promise.all([
                  WindowIsMaximised(),
                  WindowGetSize(),
              ]);
              return isStartupMaximisedWindowSettled({
                  windowWidth: Number(size?.w),
                  windowHeight: Number(size?.h),
                  isMaximised,
                  isWindows: isWindowsPlatform(),
                  surfaceWidth: window.innerWidth,
                  surfaceHeight: window.innerHeight,
                  viewport: readCurrentVisibleViewport(),
              });
          } catch (_) {
              // ignore
          }
          return false;
      };

      const tryRefreshStartupWebViewBounds = async (): Promise<boolean> => {
          if (
              !isWindowsPlatform()
              || refreshWebViewBoundsDisabled
              || (window as any).__GONAVI_WEB_RUNTIME__?.buildType === 'web'
          ) {
              return false;
          }
          const backendApp = (window as any).go?.app?.App;
          if (typeof backendApp?.RefreshWebViewBounds !== 'function') {
              refreshWebViewBoundsDisabled = true;
              if (!refreshWebViewBoundsUnavailableLogged) {
                  refreshWebViewBoundsUnavailableLogged = true;
                  console.warn('RefreshWebViewBounds backend is unavailable during startup maximise');
              }
              return false;
          }
          try {
              const result = await backendApp.RefreshWebViewBounds();
              if (result?.success) {
                  window.dispatchEvent(new Event('resize'));
                  return true;
              }
              refreshWebViewBoundsDisabled = true;
              if (!refreshWebViewBoundsUnavailableLogged) {
                  refreshWebViewBoundsUnavailableLogged = true;
                  console.warn('RefreshWebViewBounds failed during startup maximise:', result?.message);
              }
          } catch (error) {
              refreshWebViewBoundsDisabled = true;
              if (!refreshWebViewBoundsUnavailableLogged) {
                  refreshWebViewBoundsUnavailableLogged = true;
                  console.warn('RefreshWebViewBounds call failed during startup maximise', error);
              }
          }
          return false;
      };

      const waitForNativeWindowBounds = (bounds: {
          width: number;
          height: number;
          x: number;
          y: number;
      }): Promise<boolean> => waitForWindowCondition({
          read: async () => {
              const [size, position] = await Promise.all([
                  WindowGetSize(),
                  WindowGetPosition(),
              ]);
              return Math.abs(Math.trunc(Number(size?.w)) - bounds.width) <= 2
                  && Math.abs(Math.trunc(Number(size?.h)) - bounds.height) <= 2
                  && Math.abs(Math.trunc(Number(position?.x)) - bounds.x) <= 2
                  && Math.abs(Math.trunc(Number(position?.y)) - bounds.y) <= 2;
          },
          wait,
          isCancelled: () => cancelled,
          maxChecks: 16,
          intervalMs: 40,
      });

      const waitForStartupPreferenceApplied = (): Promise<boolean> => waitForWindowCondition({
          read: checkStartupPreferenceApplied,
          wait,
          isCancelled: () => cancelled,
          maxChecks: 10,
          intervalMs: 40,
      });

      const repairStartupMaximisedSurface = async (): Promise<boolean> => {
          if (!isWindowsPlatform()) {
              return false;
          }
          markStartupWindowRestorePending(startupRestoreGraceMs);
          WindowUnmaximise();
          if (!await waitForMaximisedState(false)) {
              return false;
          }
          WindowMaximise();
          if (!await waitForMaximisedState(true)) {
              return false;
          }
          await tryRefreshStartupWebViewBounds();
          return waitForStartupPreferenceApplied();
      };

      const markStartupMaximised = () => {
          // 启动偏好成功后立刻同步实际窗口态，避免 settle 宽限期留下瞬态 normal。
          useStore.getState().setWindowState('maximized');
          clearStartupWindowRestorePending();
          // 最大化已落到最终几何，放行主窗口首屏显示。
          markStartupWindowGeometrySettled();
      };

      /** Maximise 多次失败时：退回普通窗口并铺满工作区，避免残留默认半窗。 */
      const applyWindowsWorkAreaFillFallback = async (): Promise<boolean> => {
          if (!isWindowsPlatform()) {
              return false;
          }
          try {
              markStartupWindowRestorePending(startupRestoreGraceMs);
              if (await WindowIsMaximised()) {
                  WindowUnmaximise();
                  if (!await waitForMaximisedState(false)) {
                      return false;
                  }
              }
              const viewport = readCurrentVisibleViewport();
              const nextBounds = resolveWorkAreaFillWindowBounds(viewport);
              const setPosition = resolveWailsWindowSetPosition(nextBounds, viewport, {
                  useMonitorLocalOrigin: true,
              });
              WindowSetPosition(setPosition.x, setPosition.y);
              WindowSetSize(nextBounds.width, nextBounds.height);
              const boundsApplied = await waitForNativeWindowBounds(nextBounds);
              if (!boundsApplied) {
                  return false;
              }
              await tryRefreshStartupWebViewBounds();
              const surfaceFilled = await waitForWindowCondition({
                  read: async () => isStartupWindowSurfaceCoveringViewport({
                      surfaceWidth: window.innerWidth,
                      surfaceHeight: window.innerHeight,
                      viewport: readCurrentVisibleViewport(),
                  }),
                  wait,
                  isCancelled: () => cancelled,
                  maxChecks: 10,
                  intervalMs: 40,
              });
              if (!surfaceFilled) return false;
              useStore.getState().setWindowBounds(nextBounds);
              useStore.getState().setWindowState('normal');
              void emitWindowDiagnostic('adjust:startup-work-area-fill-fallback', {
                  to: nextBounds,
              });
              markStartupWindowGeometrySettled();
              return true;
          } catch (e) {
              console.warn('Failed to apply Windows work-area fill fallback', e);
              return false;
          }
      };

      // Windows、Linux 与 macOS 的启动偏好都使用普通窗口最大化，不进入系统全屏。
      // 第 1 次立即执行（delay=0），缩短普通窗口首帧到目标窗口态的过渡。
      const applyStartupWindowChrome = (attempt: number) => {
          if (startupWindowTimer !== null) {
              window.clearTimeout(startupWindowTimer);
          }
          const delayMs = attempt <= 1 ? 0 : applyRetryDelayMs;
          startupWindowTimer = window.setTimeout(() => {
              if (cancelled) {
                  return;
              }
              void Promise.resolve()
                  .then(async () => {
                      markStartupWindowRestorePending(startupRestoreGraceMs);
                      if (await checkStartupPreferenceApplied()) {
                          markStartupMaximised();
                          return;
                      }
                      try {
                          WindowMaximise();
                          if (await waitForMaximisedState(true)) {
                              await tryRefreshStartupWebViewBounds();
                          }
                      } catch (e) {
                          console.warn("Wails Window APIs unavailable", e);
                      }

                      if (await waitForStartupPreferenceApplied()) {
                          markStartupMaximised();
                          return;
                      }
                      if (attempt < maxApplyAttempts) {
                          applyStartupWindowChrome(attempt + 1);
                      } else {
                          // WebView2 controller bounds may remain at the initial 1440x900 even
                          // after WS_MAXIMIZE is set. Use one cold-start-only native transition
                          // if the zero-animation bounds refresh could not settle the surface.
                          if (await repairStartupMaximisedSurface()) {
                              markStartupMaximised();
                              return;
                          }
                          // 最终仍失败：Windows 铺满工作区兜底，再结束宽限
                          void emitWindowDiagnostic('warn:startup-maximise-failed', {
                              attempts: attempt,
                          });
                          const fallbackApplied = await applyWindowsWorkAreaFillFallback();
                          if (!fallbackApplied) {
                              void emitWindowDiagnostic('error:startup-work-area-fill-fallback-failed');
                          }
                          clearStartupWindowRestorePending();
                          // 启动偏好最终没能生效：仍放行首屏，避免窗口一直隐藏。
                          markStartupWindowGeometrySettled();
                      }
                  });
          }, delayMs);
      };

      const applyRestoredWindowBounds = (
          bounds: WindowRestoreBounds,
          displayLayout?: MainWindowDisplayLayout | null,
      ) => {
          const state = useStore.getState();
          const placement = resolveRuntimeWindowPlacement(
              bounds, displayLayout ?? null, readCurrentVisibleViewport(), isWindowsPlatform(), true,
          );
          if (!placement) {
              void emitWindowDiagnostic('warn:startup-window-display-unavailable', { from: bounds });
              return bounds;
          }
          const nextBounds = placement.bounds;
          if (
              nextBounds.x !== bounds.x ||
              nextBounds.y !== bounds.y ||
              nextBounds.width !== bounds.width ||
              nextBounds.height !== bounds.height
          ) {
              void emitWindowDiagnostic('adjust:startup-window-bounds', {
                  from: bounds,
                  to: nextBounds,
              });
          }
          applyRuntimeWindowPlacement(placement, isWindowsPlatform(), WindowSetSize, WindowSetPosition);
          state.setWindowBounds(nextBounds);
          return nextBounds;
      };

      const restoreNormalWindowBounds = async (
          bounds: WindowRestoreBounds,
          layout: MainWindowDisplayLayout | null,
      ) => {
          try {
              if (await WindowIsFullscreen()) {
                  WindowUnfullscreen();
                  await new Promise((resolve) => window.setTimeout(resolve, settleDelayMs));
              }
              if (await WindowIsMaximised()) {
                  WindowUnmaximise();
                  await new Promise((resolve) => window.setTimeout(resolve, settleDelayMs));
              }
          } catch (e) {
              console.warn('Failed to restore normal window chrome', e);
          }
          const appliedBounds = applyRestoredWindowBounds(bounds, layout);
          // Wails can finish the native normal-window transition before the
          // WebView2 controller receives its first size update. Wait for the
          // native rect, then explicitly resize the controller just as the
          // maximised startup path does.
          if (isWindowsPlatform()) {
              await waitForNativeWindowBounds(appliedBounds);
              await tryRefreshStartupWebViewBounds();
          }
          useStore.getState().setWindowState('normal');
      };

      const restoreWindowState = async () => {
          if (cancelled) return;
          // 仅在 hydration 完成后跑一次（或显式重入）；避免未水合默认态先写半窗 bounds
          if (!useStore.persist.hasHydrated()) {
              return;
          }
          if (restoredOnce) {
              return;
          }
          restoredOnce = true;
          await applyStartupWindowState();
      };

      const applyStartupWindowState = async () => {
          const state = useStore.getState();
          const bounds = state.windowBounds;
          const layout = await loadMainWindowDisplayLayout();
          if (cancelled) return;
          const restoreMode = resolveStartupWindowRestoreMode(
              state.startupFullscreen,
              state.windowState,
          );
          if (restoreMode !== 'normal') {
              markStartupWindowRestorePending(startupRestoreGraceMs);
              if (bounds && bounds.width >= 400 && bounds.height >= 300) {
                  try {
                      // Seed the OS restore rectangle before maximising so a later
                      // unmaximise returns to the last normal bounds. A frontend
                      // reload may already be maximised: SetSize in that state
                      // shrinks the HWND while its client area stays maximised.
                      if (!await WindowIsMaximised() && !await WindowIsFullscreen() && !cancelled) {
                          const appliedBounds = applyRestoredWindowBounds(bounds, layout);
                          await waitForNativeWindowBounds(appliedBounds);
                      }
                  } catch (e) {
                      console.warn('Failed to prepare remembered normal window bounds', e);
                  }
              }
              if (cancelled) return;
              markStartupWindowRestorePending(startupRestoreGraceMs);
              applyStartupWindowChrome(1);
              return;
          }

          // Without a remembered maximised state, restore the last normal bounds.
          markStartupWindowRestorePending(startupRestoreGraceMs);
          const viewport = readCurrentVisibleViewport();
          try {
              if (!bounds || bounds.width < 400 || bounds.height < 300) {
                  if (isWindowsPlatform()) {
                      const nextBounds = resolveDefaultStartupWindowBounds(viewport);
                      await restoreNormalWindowBounds(nextBounds, layout);
                      void emitWindowDiagnostic('adjust:startup-default-window-bounds', {
                          to: nextBounds,
                      });
                  } else {
                      state.setWindowState('normal');
                  }
                  return;
              }
              await restoreNormalWindowBounds(bounds, layout);
          } catch (e) {
              console.warn('Failed to restore window bounds', e);
          } finally {
              clearStartupWindowRestorePending();
              markStartupWindowGeometrySettled();
          }
      };

      if (useStore.persist.hasHydrated()) {
          void restoreWindowState();
      }
      const unsubscribeHydration = useStore.persist.onFinishHydration(() => {
          if (cancelled) {
              return;
          }
          // hydration 完成后再恢复，确保读到启动最大化偏好与 windowBounds。
          restoredOnce = false;
          void restoreWindowState();
      });

      return () => {
          cancelled = true;
          if (startupWindowTimer !== null) {
              window.clearTimeout(startupWindowTimer);
          }
          unsubscribeHydration();
      };
  }, []);
};

export type AppStartupEffectsApi = ReturnType<typeof useAppStartupEffects>;
