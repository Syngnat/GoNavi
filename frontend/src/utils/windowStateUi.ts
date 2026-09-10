export type WindowVisualState = 'normal' | 'maximized' | 'fullscreen';
export type WindowScaleFixReason = 'activation' | 'ratio-change' | 'restore' | 'startup';
export type WindowsScaleCheckTrigger = 'focus' | 'pageshow' | 'poll' | 'resize' | 'visibilitychange';
export type TitleBarToggleIconKey = 'maximize' | 'restore';

// resize/focus/pageshow/visibility 生命周期事件承担实时同步；轮询只作为 Wails
// 未上报“仅移动窗口”等边缘场景的低频容错，避免空闲窗口持续跨 JS/Go 边界。
export const WINDOW_STATE_FALLBACK_INTERVAL_MS = 15_000;
export const WINDOWS_SCALE_FALLBACK_INTERVAL_MS = 10_000;

type NativeWindowActivityEventHandler = () => void;

export interface NativeWindowActivitySchedulerHandlers {
  resize?: NativeWindowActivityEventHandler;
  focus?: NativeWindowActivityEventHandler;
  blur?: NativeWindowActivityEventHandler;
  pageshow?: NativeWindowActivityEventHandler;
  pagehide?: NativeWindowActivityEventHandler;
  beforeunload?: NativeWindowActivityEventHandler;
  visibilitychange?: NativeWindowActivityEventHandler;
}

export interface NativeWindowActivitySchedulerOptions {
  windowTarget: Window;
  documentTarget: Document;
  fallbackIntervalMs: number;
  onFallback: NativeWindowActivityEventHandler;
  handlers: NativeWindowActivitySchedulerHandlers;
}

export const installNativeWindowActivityScheduler = ({
  windowTarget,
  documentTarget,
  fallbackIntervalMs,
  onFallback,
  handlers,
}: NativeWindowActivitySchedulerOptions): (() => void) => {
  const windowListeners: Array<{
    type: keyof Pick<WindowEventMap, 'resize' | 'focus' | 'blur' | 'pageshow' | 'pagehide' | 'beforeunload'>;
    listener: EventListener;
    capture: boolean;
  }> = [];

  const addWindowListener = (
    type: keyof Pick<WindowEventMap, 'resize' | 'focus' | 'blur' | 'pageshow' | 'pagehide' | 'beforeunload'>,
    handler: NativeWindowActivityEventHandler | undefined,
    capture = false,
  ) => {
    if (!handler) return;
    const listener: EventListener = () => handler();
    windowTarget.addEventListener(type, listener, capture);
    windowListeners.push({ type, listener, capture });
  };

  addWindowListener('resize', handlers.resize);
  addWindowListener('focus', handlers.focus);
  addWindowListener('blur', handlers.blur);
  addWindowListener('pageshow', handlers.pageshow);
  addWindowListener('pagehide', handlers.pagehide, true);
  addWindowListener('beforeunload', handlers.beforeunload, true);

  let fallbackTimer: number | null = null;
  const stopFallback = () => {
    if (fallbackTimer === null) return;
    windowTarget.clearInterval(fallbackTimer);
    fallbackTimer = null;
  };
  const startFallback = () => {
    if (fallbackTimer !== null || documentTarget.visibilityState !== 'visible') return;
    fallbackTimer = windowTarget.setInterval(() => {
      if (documentTarget.visibilityState === 'visible') {
        onFallback();
      }
    }, fallbackIntervalMs);
  };
  const visibilityListener: EventListener = () => {
    if (documentTarget.visibilityState === 'visible') {
      startFallback();
    } else {
      stopFallback();
    }
    handlers.visibilitychange?.();
  };
  documentTarget.addEventListener('visibilitychange', visibilityListener);
  startFallback();

  return () => {
    stopFallback();
    for (const { type, listener, capture } of windowListeners) {
      windowTarget.removeEventListener(type, listener, capture);
    }
    documentTarget.removeEventListener('visibilitychange', visibilityListener);
  };
};

export const shouldApplyWindowsScaleFix = (
  reason: WindowScaleFixReason,
  hasViewportScaleDrift: boolean,
): boolean => (
  reason === 'restore'
  || reason === 'startup'
  || (reason === 'ratio-change' && hasViewportScaleDrift)
);

// Automatic repairs reset the controller and refresh its bounds without changing
// native geometry; stale SetSize calls can shrink an already-maximised HWND.
export const shouldResetWebViewZoomForScaleFix = (
  reason: WindowScaleFixReason,
  hasViewportScaleDrift: boolean,
): boolean => shouldApplyWindowsScaleFix(reason, hasViewportScaleDrift);

export const resolveWindowsScaleCheckDelayMs = (trigger: WindowsScaleCheckTrigger): number =>
  trigger === 'resize' ? 240 : 0;

export const resolveTitleBarToggleIconKey = (windowState: WindowVisualState): TitleBarToggleIconKey =>
  windowState === 'maximized' ? 'restore' : 'maximize';
