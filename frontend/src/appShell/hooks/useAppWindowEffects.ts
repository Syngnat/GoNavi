import { useEffect } from 'react';
import { useStore } from '../../store';
import { isStartupWindowRestorePending } from '../../utils/windowStartupLayout';
import { safeWindowRuntimeCall } from '../../utils/wailsRuntime';
import {
  WindowIsFullscreen,
  WindowIsMaximised,
  WindowGetSize,
  WindowGetPosition,
  WindowSetSize,
  WindowSetPosition,
  WindowIsMinimised,
} from '../../../wailsjs/runtime';
import { isWindowsPlatform } from '../../utils/appearance';
import {
  loadMainWindowDisplayLayout,
  resolveMaximisedWindowRestoreBounds,
  resolveGlobalWindowBounds,
  resolveRuntimeWindowPlacement,
  applyRuntimeWindowPlacement,
} from '../../utils/mainWindowDisplayPlacement';
import { readCurrentVisibleViewport } from '../appEnvironment';
import {
  installNativeWindowActivityScheduler,
  WINDOW_STATE_FALLBACK_INTERVAL_MS,
  type WindowScaleFixReason,
  type WindowsScaleCheckTrigger,
  resolveWindowsScaleCheckDelayMs,
  WINDOWS_SCALE_FALLBACK_INTERVAL_MS,
} from '../../utils/windowStateUi';
import { repairWindowsWindowScale } from '../../utils/windowsWindowScaleRepair';
import type { AppShellStateApi } from './useAppShellState';

export interface UseAppWindowEffectsInput {
  emitWindowDiagnostic: (stage: string, extra?: Record<string, unknown>) => Promise<void>;
  captureMainWindowStateRef: AppShellStateApi['captureMainWindowStateRef'];
}

export const useAppWindowEffects = ({ emitWindowDiagnostic, captureMainWindowStateRef }: UseAppWindowEffectsInput) => {
  // 定时保存窗口状态、尺寸与位置
  useEffect(() => {
      let cancelled = false;
      let hydrated = useStore.persist.hasHydrated();
      let eventSaveTimer: number | null = null;
      let boundsRepairTimer: number | null = null;
      let lastSaved = '';

      const saveWindowState = async () => {
          if (cancelled || !hydrated || isStartupWindowRestorePending()) {
              return;
          }
          try {
              const [isFs, isMax] = await Promise.all([
                  safeWindowRuntimeCall(() => WindowIsFullscreen(), false),
                  safeWindowRuntimeCall(() => WindowIsMaximised(), false),
              ]);

              // 启动窗口恢复尚未 settle 时，不保存中间态和中间尺寸。
              if (isStartupWindowRestorePending()) {
                  return;
              }

              // 保存窗口状态
              const store = useStore.getState();
              const newState = isFs ? 'fullscreen' : (isMax ? 'maximized' : 'normal');
              if (store.windowState !== newState) {
                  void emitWindowDiagnostic('transition:windowState', {
                      from: store.windowState,
                      to: newState,
                  });
                  store.setWindowState(newState);
              }

              // Windows 最大化时只记录所在显示器：不把最大化尺寸写成普通窗口的还原尺寸。
              if (isFs || isMax) {
                  if (isWindowsPlatform() && isMax && !isFs) {
                      const layout = await loadMainWindowDisplayLayout();
                      if (cancelled || isStartupWindowRestorePending()) return;
                      const nextBounds = resolveMaximisedWindowRestoreBounds(store.windowBounds, layout);
                      if (nextBounds) {
                          lastSaved = `${nextBounds.width},${nextBounds.height},${nextBounds.x},${nextBounds.y},${nextBounds.dpi || ''}`;
                          store.setWindowBounds(nextBounds);
                      }
                  }
                  return;
              }

              const [size, pos] = await Promise.all([
                  safeWindowRuntimeCall(() => WindowGetSize(), null),
                  safeWindowRuntimeCall(() => WindowGetPosition(), null),
              ]);
              if (!size || !pos || isStartupWindowRestorePending()) return;
              const w = Math.trunc(Number(size.w || 0));
              const h = Math.trunc(Number(size.h || 0));
              const x = Math.trunc(Number(pos.x || 0));
              const y = Math.trunc(Number(pos.y || 0));
               if (w < 400 || h < 300) return;

               // macOS 的 WindowGetPosition 是当前屏局部坐标，必须换算成全局坐标
               // 才能记住窗口在哪块显示器上；换算失败时按原值保存，行为不回退。
               const layout = await loadMainWindowDisplayLayout();
               const savedBounds = resolveGlobalWindowBounds(
                   { width: w, height: h, x, y },
                   layout,
               ) ?? { width: w, height: h, x, y };

               const key = `${savedBounds.width},${savedBounds.height},${savedBounds.x},${savedBounds.y},${savedBounds.dpi || ''}`;
               if (key === lastSaved) return;
               lastSaved = key;
               if (Math.abs(savedBounds.x) > 5000 || Math.abs(savedBounds.y) > 5000) {
                   void emitWindowDiagnostic('anomaly:windowBounds', savedBounds);
               }
               store.setWindowBounds(savedBounds);
            } catch (e) {
                // 静默忽略
            }
      };
      captureMainWindowStateRef.current = saveWindowState;

      const scheduleWindowStateSave = (delayMs = 120) => {
          if (cancelled || !hydrated) {
              return;
          }
          if (eventSaveTimer !== null) {
              window.clearTimeout(eventSaveTimer);
          }
          eventSaveTimer = window.setTimeout(() => {
              eventSaveTimer = null;
              void saveWindowState();
          }, delayMs);
      };

      const repairRuntimeWindowBounds = async () => {
          if (cancelled || !hydrated) {
              return;
          }
          // 启动窗口恢复期间不要抢跑普通 bounds 校正。
          if (isStartupWindowRestorePending()) {
              return;
          }
          try {
              const [isFs, isMax] = await Promise.all([
                  safeWindowRuntimeCall(() => WindowIsFullscreen(), false),
                  safeWindowRuntimeCall(() => WindowIsMaximised(), false),
              ]);
              if (isFs || isMax) {
                  return;
              }
              const [size, pos] = await Promise.all([
                  safeWindowRuntimeCall(() => WindowGetSize(), null),
                  safeWindowRuntimeCall(() => WindowGetPosition(), null),
              ]);
              if (!size || !pos) {
                  return;
              }
              const currentBounds = {
                  width: Math.trunc(Number(size.w || 0)),
                  height: Math.trunc(Number(size.h || 0)),
                  x: Math.trunc(Number(pos.x || 0)),
                  y: Math.trunc(Number(pos.y || 0)),
              };
              if (currentBounds.width <= 0 || currentBounds.height <= 0) {
                  return;
              }
              const layout = await loadMainWindowDisplayLayout();
              if (cancelled || isStartupWindowRestorePending()) return;
              const placement = resolveRuntimeWindowPlacement(currentBounds, layout, readCurrentVisibleViewport(), isWindowsPlatform());
              if (!placement) return;
              const nextBounds = placement.bounds;
              const resolvedOriginal = resolveGlobalWindowBounds(currentBounds, layout);
              const originalGlobal = resolvedOriginal ?? currentBounds;
              const originalDpi = resolvedOriginal?.dpi;
              if (
                  nextBounds.x === originalGlobal.x &&
                  nextBounds.y === originalGlobal.y &&
                  nextBounds.width === originalGlobal.width &&
                  nextBounds.height === originalGlobal.height &&
                  nextBounds.dpi === originalDpi
              ) {
                  return;
              }
              void emitWindowDiagnostic('adjust:runtime-window-bounds', {
                  from: currentBounds,
                  to: nextBounds,
              });
              applyRuntimeWindowPlacement(placement, isWindowsPlatform(), WindowSetSize, WindowSetPosition);
              // 持久化用全局坐标：macOS 的窗口位置是当前屏局部坐标，直接落盘会丢
              // 失“在哪块显示器上”的信息。换算失败时保留设备侧坐标，行为不回退。
              const persistedBounds = placement.persistedBounds;
              lastSaved = `${persistedBounds.width},${persistedBounds.height},${persistedBounds.x},${persistedBounds.y},${persistedBounds.dpi || ''}`;
              useStore.getState().setWindowBounds(persistedBounds);
              window.dispatchEvent(new Event('resize'));
          } catch {
              // Wails runtime window APIs are best-effort here.
          }
      };

      const scheduleWindowBoundsRepair = (delayMs = 80) => {
          if (cancelled || !hydrated) {
              return;
          }
          if (boundsRepairTimer !== null) {
              window.clearTimeout(boundsRepairTimer);
          }
          boundsRepairTimer = window.setTimeout(() => {
              boundsRepairTimer = null;
              void repairRuntimeWindowBounds();
          }, delayMs);
      };

      const handleWindowRuntimeChange = () => {
          scheduleWindowBoundsRepair();
          scheduleWindowStateSave(260);
      };

      const handleVisibilityChange = () => {
          if (document.visibilityState === 'visible') {
              scheduleWindowBoundsRepair();
              scheduleWindowStateSave(260);
          }
      };

      const handleWindowLifecycleFlush = () => {
          void saveWindowState();
      };

      if (hydrated) {
          scheduleWindowBoundsRepair(360);
          scheduleWindowStateSave(320);
      }
      const unsubscribeHydration = useStore.persist.onFinishHydration(() => {
          if (cancelled || hydrated) {
              return;
          }
          hydrated = true;
          scheduleWindowBoundsRepair(360);
          scheduleWindowStateSave(320);
      });

      const cleanupWindowActivityScheduler = installNativeWindowActivityScheduler({
          windowTarget: window,
          documentTarget: document,
          fallbackIntervalMs: WINDOW_STATE_FALLBACK_INTERVAL_MS,
          onFallback: () => {
              void saveWindowState();
          },
          handlers: {
              resize: handleWindowRuntimeChange,
              focus: handleWindowRuntimeChange,
              pageshow: handleWindowRuntimeChange,
              pagehide: handleWindowLifecycleFlush,
              beforeunload: handleWindowLifecycleFlush,
              visibilitychange: handleVisibilityChange,
          },
      });
      return () => {
          cancelled = true;
          if (captureMainWindowStateRef.current === saveWindowState) {
              captureMainWindowStateRef.current = async () => undefined;
          }
          if (eventSaveTimer !== null) {
              window.clearTimeout(eventSaveTimer);
          }
          if (boundsRepairTimer !== null) {
              window.clearTimeout(boundsRepairTimer);
          }
          cleanupWindowActivityScheduler();
          unsubscribeHydration();
      };
  }, []);

  useEffect(() => {
      if (!isWindowsPlatform()) {
          return;
      }

      let cancelled = false;
      let inFlight = false;
      let lastRatio = Number(window.devicePixelRatio) || 1;
      let lastFixAt = 0;
      let activationTimer: number | null = null;
      let resizeTimer: number | null = null;
      let minimisedCheckTimer: number | null = null;
      let minimisedSeen = false;
      let hiddenSeen = document.visibilityState === 'hidden';

      // Automatic scale-fix may call ResetWebViewZoom multiple times on startup.
      // The backend path depends on Wails unexported fields and can fail harmlessly;
      // log at most once so the console is not flooded with expected unavailability.
      let resetWebViewZoomUnavailableLogged = false;
      const tryResetWebViewZoomQuietly = async () => {
          try {
              const res = await (window as any).go?.app?.App?.ResetWebViewZoom?.();
              if (res?.success) {
                  return true;
              }
              if (!resetWebViewZoomUnavailableLogged) {
                  resetWebViewZoomUnavailableLogged = true;
                  console.warn('ResetWebViewZoom unavailable in fixWindowScaleIfNeeded:', res?.message);
              }
              return false;
          } catch (e) {
              if (!resetWebViewZoomUnavailableLogged) {
                  resetWebViewZoomUnavailableLogged = true;
                  console.warn('ResetWebViewZoom call failed in fixWindowScaleIfNeeded', e);
              }
              return false;
          }
      };

      let refreshWebViewBoundsUnavailableLogged = false;
      const tryRefreshWebViewBoundsQuietly = async (): Promise<boolean> => {
          try {
              const result = await (window as any).go?.app?.App?.RefreshWebViewBounds?.();
              if (result?.success) return true;
              if (!refreshWebViewBoundsUnavailableLogged) {
                  refreshWebViewBoundsUnavailableLogged = true;
                  console.warn('RefreshWebViewBounds unavailable in scale repair:', result?.message);
              }
          } catch (error) {
              if (!refreshWebViewBoundsUnavailableLogged) {
                  refreshWebViewBoundsUnavailableLogged = true;
                  console.warn('RefreshWebViewBounds call failed in scale repair', error);
              }
          }
          return false;
      };

      const fixWindowScaleIfNeeded = async (reason: WindowScaleFixReason) => {
          if (cancelled || inFlight) return;
          const now = Date.now();
          if (now - lastFixAt < 700) return;
          inFlight = true;
          try {
              await repairWindowsWindowScale({
                  reason,
                  readViewport: () => ({
                      innerWidth: window.innerWidth,
                      devicePixelRatio: Number(window.devicePixelRatio) || 1,
                      visualViewportScale: window.visualViewport?.scale,
                  }),
                  resetZoom: tryResetWebViewZoomQuietly,
                  refreshBounds: tryRefreshWebViewBoundsQuietly,
                  notifyResize: () => window.dispatchEvent(new Event('resize')),
                  isCancelled: () => cancelled,
              });
              lastFixAt = Date.now();
          } catch (error) {
              console.warn('Wails Window APIs unavailable in scale repair', error);
          } finally {
              inFlight = false;
          }
      };

      const rememberMinimisedState = async (): Promise<boolean> => {
          if (cancelled) return false;
          const isMinimised = await safeWindowRuntimeCall(() => WindowIsMinimised(), false);
          if (isMinimised) {
              minimisedSeen = true;
          }
          return isMinimised;
      };

      const rememberMinimisedStateSoon = () => {
          if (minimisedCheckTimer !== null) {
              window.clearTimeout(minimisedCheckTimer);
          }
          minimisedCheckTimer = window.setTimeout(() => {
              minimisedCheckTimer = null;
              if (cancelled) return;
              void rememberMinimisedState();
          }, 120);
      };

      const checkDevicePixelRatio = () => {
          if (cancelled) return;
          const currentRatio = Number(window.devicePixelRatio) || 1;
          if (Math.abs(currentRatio - lastRatio) < 0.02) {
              return;
          }
          lastRatio = currentRatio;
          if (minimisedSeen || hiddenSeen) {
              scheduleActivationFix();
              return;
          }
          void fixWindowScaleIfNeeded('ratio-change');
      };

      const scheduleDevicePixelRatioCheck = (trigger: WindowsScaleCheckTrigger) => {
          if (cancelled) return;
          const delayMs = resolveWindowsScaleCheckDelayMs(trigger);
          if (delayMs <= 0) {
              checkDevicePixelRatio();
              return;
          }

          if (resizeTimer !== null) {
              window.clearTimeout(resizeTimer);
          }
          resizeTimer = window.setTimeout(() => {
              resizeTimer = null;
              if (cancelled) return;
              checkDevicePixelRatio();
          }, delayMs);
      };

      const scheduleActivationFix = () => {
          if (cancelled) return;
          if (activationTimer !== null) {
              window.clearTimeout(activationTimer);
          }
          const delayMs = (minimisedSeen || hiddenSeen) ? 260 : 80;
          activationTimer = window.setTimeout(async () => {
              activationTimer = null;
              if (cancelled) return;
              if (await rememberMinimisedState()) {
                  return;
              }
              const reason: WindowScaleFixReason = (minimisedSeen || hiddenSeen) ? 'restore' : 'activation';
              minimisedSeen = false;
              hiddenSeen = false;
              void fixWindowScaleIfNeeded(reason);
          }, delayMs);
      };

      const handleWindowFocus = () => {
          if (cancelled) return;
          scheduleDevicePixelRatioCheck('focus');
          scheduleActivationFix();
      };

      const handleWindowBlur = () => {
          if (cancelled) return;
          if (document.visibilityState === 'hidden') {
              hiddenSeen = true;
          }
          rememberMinimisedStateSoon();
      };

      const handleVisibilityChange = () => {
          if (cancelled) return;
          if (document.visibilityState !== 'visible') {
              hiddenSeen = true;
              rememberMinimisedStateSoon();
              return;
          }
          scheduleDevicePixelRatioCheck('visibilitychange');
          scheduleActivationFix();
      };

      const handlePageShow = () => {
          if (cancelled) return;
          scheduleDevicePixelRatioCheck('pageshow');
          scheduleActivationFix();
      };

      const handleWindowResize = () => {
          rememberMinimisedStateSoon();
          scheduleDevicePixelRatioCheck('resize');
      };

      // Windows 冷启动：WebView2 首次布局常只铺满左上角一部分，任务栏恢复才会走 restore 修复。
      // 这里在启动后主动按 startup 原因做几次轻量 settle，避免用户必须双击任务栏。
      // 间隔需大于 fixWindowScaleIfNeeded 的 700ms 节流，确保多次都能真正执行。
      const startupLayoutFixTimers = [220, 1000, 1900].map((delayMs) => (
          window.setTimeout(() => {
              if (cancelled) return;
              void fixWindowScaleIfNeeded('startup');
          }, delayMs)
      ));
      const cleanupWindowActivityScheduler = installNativeWindowActivityScheduler({
          windowTarget: window,
          documentTarget: document,
          fallbackIntervalMs: WINDOWS_SCALE_FALLBACK_INTERVAL_MS,
          onFallback: () => {
              void rememberMinimisedState();
              checkDevicePixelRatio();
          },
          handlers: {
              resize: handleWindowResize,
              focus: handleWindowFocus,
              blur: handleWindowBlur,
              pageshow: handlePageShow,
              visibilitychange: handleVisibilityChange,
          },
      });

      return () => {
          cancelled = true;
          if (activationTimer !== null) {
              window.clearTimeout(activationTimer);
          }
          if (resizeTimer !== null) {
              window.clearTimeout(resizeTimer);
          }
          if (minimisedCheckTimer !== null) {
              window.clearTimeout(minimisedCheckTimer);
              minimisedCheckTimer = null;
          }
          for (const timer of startupLayoutFixTimers) {
              window.clearTimeout(timer);
          }
          cleanupWindowActivityScheduler();
      };
  }, []);
};

export type AppWindowEffectsApi = ReturnType<typeof useAppWindowEffects>;
