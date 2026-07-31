export type StartupVisibleViewport = {
  availWidth: number;
  availHeight: number;
  availLeft?: number;
  availTop?: number;
};

export type StartupWindowBounds = {
  width: number;
  height: number;
  x: number;
  y: number;
};

/** Align with main.go MinWidth / MinHeight so first paint never falls below shell minimums. */
const MIN_STARTUP_WIDTH = 900;
const MIN_STARTUP_HEIGHT = 600;

export type StartupWindowRestoreMode = 'normal' | 'maximised';

/**
 * The explicit startup preference is authoritative. A disabled preference must
 * not be overridden by a previously maximised window or a size heuristic.
 */
export const resolveStartupWindowRestoreMode = (
  startupMaximised: boolean,
): StartupWindowRestoreMode => startupMaximised ? 'maximised' : 'normal';

/** Resolve a centered normal window when no persisted bounds exist. */
export const resolveDefaultStartupWindowBounds = (
  viewport: StartupVisibleViewport,
): StartupWindowBounds => {
  const availWidth = Math.max(0, Math.trunc(Number(viewport.availWidth) || 0));
  const availHeight = Math.max(0, Math.trunc(Number(viewport.availHeight) || 0));
  const availLeft = Math.trunc(Number(viewport.availLeft) || 0);
  const availTop = Math.trunc(Number(viewport.availTop) || 0);

  const preferredWidth = availWidth > 0
    ? Math.min(Math.max(MIN_STARTUP_WIDTH, Math.trunc(availWidth * 0.84)), availWidth)
    : 1280;
  const preferredHeight = availHeight > 0
    ? Math.min(Math.max(MIN_STARTUP_HEIGHT, Math.trunc(availHeight * 0.84)), availHeight)
    : 800;

  const width = preferredWidth;
  const height = preferredHeight;

  return {
    width,
    height,
    x: availWidth > 0
      ? availLeft + Math.max(0, Math.trunc((availWidth - width) / 2))
      : 0,
    y: availHeight > 0
      ? availTop + Math.max(0, Math.trunc((availHeight - height) / 2))
      : 0,
  };
};

/**
 * Fill the OS work area (taskbar excluded). Used when Maximise API fails on Windows
 * so the shell still looks full instead of lingering in a normal window.
 */
export const resolveWorkAreaFillWindowBounds = (
  viewport: StartupVisibleViewport,
): StartupWindowBounds => {
  const availWidth = Math.max(0, Math.trunc(Number(viewport.availWidth) || 0));
  const availHeight = Math.max(0, Math.trunc(Number(viewport.availHeight) || 0));
  const availLeft = Math.trunc(Number(viewport.availLeft) || 0);
  const availTop = Math.trunc(Number(viewport.availTop) || 0);

  if (availWidth <= 0 || availHeight <= 0) {
    return resolveDefaultStartupWindowBounds(viewport);
  }

  return {
    width: Math.max(MIN_STARTUP_WIDTH, availWidth),
    height: Math.max(MIN_STARTUP_HEIGHT, availHeight),
    x: availLeft,
    y: availTop,
  };
};

let startupWindowRestorePendingUntil = 0;

/** Mark a short grace window while startup window restoration is still settling. */
export const markStartupWindowRestorePending = (durationMs = 2800): void => {
  const duration = Math.max(0, Math.trunc(Number(durationMs) || 0));
  startupWindowRestorePendingUntil = Date.now() + duration;
};

export const isStartupWindowRestorePending = (): boolean =>
  Date.now() < startupWindowRestorePendingUntil;

export const clearStartupWindowRestorePending = (): void => {
  startupWindowRestorePendingUntil = 0;
};
