type WindowsViewportScaleInput = {
  /** Wails WindowGetSize returns device-independent pixels, not physical pixels. */
  windowWidth: number;
  innerWidth: number;
  devicePixelRatio: number;
  visualViewportScale?: number | null;
};

export const computeWindowsViewportScaleRatio = ({
  windowWidth,
  innerWidth,
  devicePixelRatio,
}: WindowsViewportScaleInput): number => {
  const normalizedWindowWidth = Number(windowWidth);
  const normalizedInnerWidth = Number(innerWidth);
  const normalizedDevicePixelRatio = Number(devicePixelRatio);
  if (
    !Number.isFinite(normalizedWindowWidth) || normalizedWindowWidth <= 0 ||
    !Number.isFinite(normalizedInnerWidth) || normalizedInnerWidth <= 0 ||
    !Number.isFinite(normalizedDevicePixelRatio) || normalizedDevicePixelRatio <= 0
  ) {
    return 1;
  }
  return normalizedWindowWidth / normalizedInnerWidth;
};

export const hasWindowsViewportScaleDrift = (
  metrics: WindowsViewportScaleInput,
  tolerance = 0.08,
): boolean => {
  const normalizedTolerance = Math.max(0.01, Number(tolerance) || 0.08);
  const visualViewportScale = Number(metrics.visualViewportScale);
  if (Number.isFinite(visualViewportScale) && Math.abs(visualViewportScale - 1) > normalizedTolerance) {
    return true;
  }

  const viewportScaleRatio = computeWindowsViewportScaleRatio(metrics);
  return Math.abs(viewportScaleRatio - 1) > normalizedTolerance;
};

export const getWindowsScaleFixNudgedWidth = (width: number): number => {
  const normalizedWidth = Math.trunc(Number(width) || 0);
  if (normalizedWidth <= 0) {
    return 0;
  }
  return normalizedWidth > 480 ? normalizedWidth - 1 : normalizedWidth + 1;
};
