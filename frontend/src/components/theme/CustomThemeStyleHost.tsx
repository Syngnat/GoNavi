import { useEffect, useLayoutEffect, useMemo } from 'react';
import { CUSTOM_THEME_STORAGE_KEY, useCustomThemeStore } from '../../customThemeStore';
import {
  CUSTOM_THEME_STYLE_ID,
  ensureCustomThemeMonacoSurfaceVars,
  extractComputedCustomThemeAntTokens,
  extractCustomThemeAntTokens,
  type CustomThemeAntTokens,
  type CustomThemeDefinition,
} from '../../utils/customTheme';
import { resolveAvailableCustomTheme } from '../../utils/customThemePresets';

export type CustomThemeAntTokenSnapshot = {
  themeId: string;
  themeRevision: number;
  contextKey: string;
  tokens: CustomThemeAntTokens;
};

type CustomThemeStyleHostProps = {
  contextKey: string;
  onAntTokensChange: (snapshot: CustomThemeAntTokenSnapshot | null) => void;
  /** Optional host-owned theme for detached WebViews; undefined keeps local-store behavior. */
  themeOverride?: CustomThemeDefinition | null;
};

type CustomThemeRecoveryKeyboardEvent = Pick<
  KeyboardEvent,
  'altKey' | 'code' | 'ctrlKey' | 'isComposing' | 'key' | 'metaKey' | 'shiftKey'
>;

export const isCustomThemeRecoveryShortcut = (event: CustomThemeRecoveryKeyboardEvent): boolean => (
  !event.altKey
  && !event.isComposing
  && event.shiftKey
  && (event.ctrlKey || event.metaKey)
  && (event.code === 'KeyD' || event.key.toLowerCase() === 'd')
);

export const shouldReloadCustomThemesForStorageEvent = (key: string | null): boolean => (
  key === null || key === CUSTOM_THEME_STORAGE_KEY
);

export const installCustomThemeRecoveryShortcut = (
  deactivate: () => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | null = (
    typeof window === 'undefined' ? null : window
  ),
): (() => void) => {
  if (!target) return () => undefined;
  const handleRecoveryShortcut = (event: KeyboardEvent) => {
    if (!isCustomThemeRecoveryShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    // This fixed capture-phase escape hatch deliberately ignores editable
    // targets and user-remappable shortcuts so destructive CSS is reversible.
    deactivate();
  };
  target.addEventListener('keydown', handleRecoveryShortcut as EventListener, true);
  return () => target.removeEventListener('keydown', handleRecoveryShortcut as EventListener, true);
};

export const syncCustomThemeStyle = (
  theme: CustomThemeDefinition | null,
  documentRef: Document | null = typeof document === 'undefined' ? null : document,
): void => {
  if (!documentRef) return;
  const existing = documentRef.getElementById(CUSTOM_THEME_STYLE_ID);
  if (!theme) {
    existing?.remove();
    documentRef.body.removeAttribute('data-custom-theme');
    documentRef.body.removeAttribute('data-custom-theme-id');
    return;
  }
  if (existing && existing.tagName.toLowerCase() !== 'style') existing.remove();
  const style = existing?.tagName.toLowerCase() === 'style'
    ? existing as HTMLStyleElement
    : documentRef.createElement('style');
  style.id = CUSTOM_THEME_STYLE_ID;
  style.setAttribute('data-gonavi-custom-theme', theme.id);
  // textContent is intentional: imported CSS must never pass through HTML.
  // Inject --gn-monaco-bg for hand-written themes that only set --gn-bg-panel.
  style.textContent = ensureCustomThemeMonacoSurfaceVars(theme.css);
  if (!style.isConnected) documentRef.head.appendChild(style);
  documentRef.body.setAttribute('data-custom-theme', 'active');
  documentRef.body.setAttribute('data-custom-theme-id', theme.id);
};

export default function CustomThemeStyleHost({
  contextKey,
  onAntTokensChange,
  themeOverride,
}: CustomThemeStyleHostProps) {
  const themes = useCustomThemeStore((state) => state.themes);
  const activeThemeId = useCustomThemeStore((state) => state.activeThemeId);
  const reloadCustomThemes = useCustomThemeStore((state) => state.reloadCustomThemes);
  const selectCustomTheme = useCustomThemeStore((state) => state.selectCustomTheme);
  const activeThemeFromStore = useMemo(
    () => resolveAvailableCustomTheme(themes, activeThemeId),
    [activeThemeId, themes],
  );
  const activeTheme = themeOverride === undefined ? activeThemeFromStore : themeOverride;

  useLayoutEffect(() => {
    syncCustomThemeStyle(activeTheme);
    return () => syncCustomThemeStyle(null);
  }, [activeTheme]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleStorage = (event: StorageEvent) => {
      if (shouldReloadCustomThemesForStorageEvent(event.key)) reloadCustomThemes();
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [reloadCustomThemes]);

  useEffect(() => {
    if (!activeTheme) return undefined;
    return installCustomThemeRecoveryShortcut(() => { selectCustomTheme(null); });
  }, [activeTheme, selectCustomTheme]);

  useEffect(() => {
    if (!activeTheme || typeof window === 'undefined') {
      onAntTokensChange(null);
      return undefined;
    }

    let animationFrame = 0;
    const updateTokens = () => {
      animationFrame = 0;
      let tokens = extractCustomThemeAntTokens(activeTheme.css);
      try {
        tokens = extractComputedCustomThemeAntTokens(window.getComputedStyle(document.body));
      } catch {
        // Source-level tokens are a conservative fallback for non-DOM test or
        // teardown states. Normal app windows always use the computed cascade.
      }
      onAntTokensChange({
        themeId: activeTheme.id,
        themeRevision: activeTheme.updatedAt,
        contextKey,
        tokens,
      });
    };
    const scheduleUpdate = () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(updateTokens);
    };

    scheduleUpdate();
    window.addEventListener('resize', scheduleUpdate);
    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', scheduleUpdate);
    };
  }, [activeTheme, contextKey, onAntTokensChange]);

  return null;
}
