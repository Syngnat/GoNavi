export const NATIVE_DETACHED_SYNC_DEBOUNCE_MS = 180;
export const NATIVE_DETACHED_PAINT_FALLBACK_MS = 250;
export const NATIVE_DETACHED_CANCEL_CLOSE_ATTEMPTS = 2;
const NATIVE_DETACHED_MIN_UI_SCALE = 0.8;
const NATIVE_DETACHED_MAX_UI_SCALE = 1.25;
const NATIVE_DETACHED_DEFAULT_UI_SCALE = 1;
const NATIVE_DETACHED_MIN_FONT_SIZE = 12;
const NATIVE_DETACHED_MAX_FONT_SIZE = 20;
const NATIVE_DETACHED_DEFAULT_FONT_SIZE = 14;

type NativeDetachedDocument = Pick<Document, 'body' | 'documentElement'>;

export const applyNativeDetachedDocumentAppearance = (
  themeMode: 'light' | 'dark',
  fontSize: number,
  uiScale: number,
  documentRef: NativeDetachedDocument | null = typeof document === 'undefined' ? null : document,
): void => {
  if (!documentRef?.body) return;
  const resolvedTheme = themeMode === 'dark' ? 'dark' : 'light';
  const effectiveUiScale = Math.min(
    NATIVE_DETACHED_MAX_UI_SCALE,
    Math.max(NATIVE_DETACHED_MIN_UI_SCALE, Number(uiScale) || NATIVE_DETACHED_DEFAULT_UI_SCALE),
  );
  const effectiveFontSize = Math.min(
    NATIVE_DETACHED_MAX_FONT_SIZE,
    Math.max(NATIVE_DETACHED_MIN_FONT_SIZE, Math.round(Number(fontSize) || NATIVE_DETACHED_DEFAULT_FONT_SIZE)),
  );
  const rootStyle = documentRef.documentElement?.style;
  documentRef.body.setAttribute('data-theme', resolvedTheme);
  documentRef.body.setAttribute('data-ui-version', 'v2');
  documentRef.body.setAttribute('data-gonavi-detached', 'true');
  documentRef.body.style.backgroundColor = 'transparent';
  documentRef.body.style.color = resolvedTheme === 'dark' ? '#ffffff' : '#000000';
  documentRef.body.style.fontSize = `${effectiveFontSize}px`;
  if (!rootStyle) return;
  rootStyle.colorScheme = resolvedTheme;
  rootStyle.setProperty('--gonavi-font-size', `${effectiveFontSize}px`);
  rootStyle.setProperty('--gn-ui-scale', `${effectiveUiScale}`);
  rootStyle.setProperty('--gn-font-size', `${effectiveFontSize}px`);
  rootStyle.setProperty('--gn-font-size-sm', `${Math.max(10, Math.round(effectiveFontSize * 0.86))}px`);
  rootStyle.setProperty('--gn-font-size-xs', `${Math.max(9, Math.round(effectiveFontSize * 0.76))}px`);
};

export const waitForNativeDetachedContentPaint = (): Promise<void> => {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
      resolve();
    };
    fallbackTimer = setTimeout(finish, NATIVE_DETACHED_PAINT_FALLBACK_MS);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(finish);
    });
  });
};
