export type WailsWindowVisibleViewport = {
  availWidth: number;
  availHeight: number;
  availLeft?: number;
  availTop?: number;
};

type ScreenLike = {
  availWidth?: number;
  availHeight?: number;
  availLeft?: number;
  availTop?: number;
} | null | undefined;

type ViewportFallback = {
  innerWidth?: number;
  innerHeight?: number;
};

type WindowPositionLike = {
  x?: number;
  y?: number;
};

const toFiniteInteger = (value: unknown, fallback = 0): number => {
  const next = Math.trunc(Number(value));
  return Number.isFinite(next) ? next : fallback;
};

/**
 * 解析 Wails 主窗口恢复使用的可见区域。
 * Wails 的 WindowSetPosition 在 macOS 上接收当前 monitor 可见区域内的局部坐标，
 * 因此 macOS 不能把浏览器 screen.availLeft/availTop 的全局屏幕偏移继续传下去。
 */
export const resolveWailsWindowVisibleViewport = (
  screenLike: ScreenLike,
  fallback: ViewportFallback,
  options?: { useMonitorLocalOrigin?: boolean },
): WailsWindowVisibleViewport => {
  const availWidth = toFiniteInteger(
    screenLike?.availWidth,
    toFiniteInteger(fallback.innerWidth),
  );
  const availHeight = toFiniteInteger(
    screenLike?.availHeight,
    toFiniteInteger(fallback.innerHeight),
  );
  const useMonitorLocalOrigin = options?.useMonitorLocalOrigin === true;

  return {
    availWidth,
    availHeight,
    // macOS 修复点：Wails 会自己把局部坐标映射到当前 NSScreen.visibleFrame。
    availLeft: useMonitorLocalOrigin ? 0 : toFiniteInteger(screenLike?.availLeft),
    availTop: useMonitorLocalOrigin ? 0 : toFiniteInteger(screenLike?.availTop),
  };
};

/**
 * Convert global screen coordinates to the monitor-local coordinates expected by
 * Wails WindowSetPosition on Windows. Callers that use global coordinates can keep
 * comparing WindowGetPosition against the original target.
 */
export const resolveWailsWindowSetPosition = (
  position: WindowPositionLike,
  viewport: WailsWindowVisibleViewport,
  options?: { useMonitorLocalOrigin?: boolean },
): { x: number; y: number } => {
  const x = toFiniteInteger(position.x);
  const y = toFiniteInteger(position.y);
  if (options?.useMonitorLocalOrigin !== true) {
    return { x, y };
  }
  return {
    x: x - toFiniteInteger(viewport.availLeft),
    y: y - toFiniteInteger(viewport.availTop),
  };
};
