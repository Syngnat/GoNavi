/** Wails keeps the native macOS traffic lights centered 16 CSS px below the window top. */
const MAC_NATIVE_TITLEBAR_CONTENT_CENTER = 16;

export const getMacNativeTitlebarContentOffset = (titleBarHeight: number, enabled: boolean): number => {
  if (!enabled || !Number.isFinite(titleBarHeight)) {
    return 0;
  }
  return MAC_NATIVE_TITLEBAR_CONTENT_CENTER - (titleBarHeight / 2);
};

export const getMacNativeTitlebarPaddingLeft = (uiScale: number, enabled: boolean): number => {
  if (!enabled) {
    return Math.max(12, Math.round(16 * uiScale));
  }
  return Math.max(88, Math.round(96 * uiScale));
};

export const getMacNativeTitlebarPaddingRight = (uiScale: number, enabled: boolean): number => {
  if (!enabled) {
    return 0;
  }
  return Math.max(12, Math.round(16 * uiScale));
};

export const shouldHandleMacNativeFullscreenShortcut = (
  isMacRuntime: boolean,
  useNativeMacWindowControls: boolean,
  event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'key'>,
): boolean => {
  if (!isMacRuntime || !useNativeMacWindowControls) {
    return false;
  }
  if (!event.ctrlKey || !event.metaKey || event.altKey) {
    return false;
  }
  return String(event.key || '').toLowerCase() === 'f';
};

export const shouldSuppressMacNativeEscapeExit = (
  isMacRuntime: boolean,
  useNativeMacWindowControls: boolean,
  isFullscreen: boolean,
  event: Pick<KeyboardEvent, 'key' | 'defaultPrevented'>,
  options?: { isEditableTarget?: boolean },
): boolean => {
  if (!isMacRuntime || !useNativeMacWindowControls || !isFullscreen) {
    return false;
  }
  if (options?.isEditableTarget) {
    return false;
  }
  if (event.defaultPrevented) {
    return false;
  }
  return String(event.key || '') === 'Escape';
};
