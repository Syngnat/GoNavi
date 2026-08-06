import { resolveTextInputSafeBackdropFilter } from './appearance';

type OverlayWorkbenchTheme = {
  isDark: boolean;
  shellBg: string;
  shellBorder: string;
  shellShadow: string;
  shellBackdropFilter: string;
  sectionBg: string;
  sectionBorder: string;
  mutedText: string;
  titleText: string;
  iconBg: string;
  iconColor: string;
  hoverBg: string;
  selectedBg: string;
  selectedText: string;
  divider: string;
};

export const buildOverlayWorkbenchTheme = (
  darkMode: boolean,
  options?: {
    disableBackdropFilter?: boolean;
    uiVersion?: 'legacy' | 'v2';
    /** Resolve V2 surfaces from the document theme variables (used by native detached windows). */
    useThemeVariables?: boolean;
  },
): OverlayWorkbenchTheme => {
  const shellBackdropFilter = resolveTextInputSafeBackdropFilter(
    darkMode ? 'blur(18px)' : 'none',
    options?.disableBackdropFilter ?? false,
  );
  const uiVersion = options?.uiVersion ?? 'legacy';

  // ─── v2 palette ──────────────────────────────────────────────
  if (uiVersion === 'v2') {
    if (options?.useThemeVariables) {
      const fallback = darkMode
        ? {
            panel: '#161a21',
            panel2: '#1b1f27',
            border1: 'rgba(255,255,255,0.06)',
            border2: 'rgba(255,255,255,0.10)',
            fg1: '#f1f3f5',
            fg4: '#80868f',
            accent: '#22c55e',
            accentStrong: '#22c55e',
            accentSoft: 'rgba(34, 197, 94, 0.16)',
            hover: 'rgba(255,255,255,0.05)',
            selected: 'rgba(34, 197, 94, 0.14)',
          }
        : {
            panel: '#ffffff',
            panel2: '#fafaf8',
            border1: 'rgba(15,23,42,0.08)',
            border2: 'rgba(15,23,42,0.12)',
            fg1: '#0c1322',
            fg4: '#6b7280',
            accent: '#15803d',
            accentStrong: '#15803d',
            accentSoft: '#dcfce7',
            hover: 'rgba(15,23,42,0.045)',
            selected: 'rgba(34, 197, 94, 0.10)',
          };
      return {
        isDark: darkMode,
        shellBg: `var(--gn-bg-panel, ${fallback.panel})`,
        shellBorder: `0.5px solid var(--gn-br-1, ${fallback.border1})`,
        shellShadow: `var(--gn-shadow-lg, ${darkMode ? '0 12px 40px rgba(0,0,0,0.55)' : '0 12px 40px rgba(15,23,42,0.14)'})`,
        shellBackdropFilter,
        sectionBg: `var(--gn-bg-panel-2, ${fallback.panel2})`,
        sectionBorder: `0.5px solid var(--gn-br-2, ${fallback.border2})`,
        mutedText: `var(--gn-fg-4, ${fallback.fg4})`,
        titleText: `var(--gn-fg-1, ${fallback.fg1})`,
        iconBg: `var(--gn-accent-soft, ${fallback.accentSoft})`,
        iconColor: `var(--gn-accent, ${fallback.accent})`,
        hoverBg: `var(--gn-bg-hover, ${fallback.hover})`,
        selectedBg: `var(--gn-bg-selected, ${fallback.selected})`,
        selectedText: `var(--gn-accent-strong, ${fallback.accentStrong})`,
        divider: `var(--gn-br-1, ${fallback.border1})`,
      };
    }
    if (darkMode) {
      return {
        isDark: true,
        shellBg: 'linear-gradient(180deg, rgba(22, 26, 33, 0.96) 0%, rgba(12, 14, 18, 0.98) 100%)',
        shellBorder: '0.5px solid rgba(255,255,255,0.10)',
        shellShadow: '0 12px 40px rgba(0,0,0,0.55)',
        shellBackdropFilter,
        sectionBg: 'rgba(255,255,255,0.04)',
        sectionBorder: '0.5px solid rgba(255,255,255,0.06)',
        mutedText: '#80868f',
        titleText: '#f1f3f5',
        iconBg: 'rgba(34, 197, 94, 0.16)',
        iconColor: '#22c55e',
        hoverBg: 'rgba(255,255,255,0.05)',
        selectedBg: 'rgba(34, 197, 94, 0.14)',
        selectedText: '#4ade80',
        divider: 'rgba(255,255,255,0.06)',
      };
    }
    return {
      isDark: false,
      shellBg: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(250,250,248,0.98) 100%)',
      shellBorder: '0.5px solid rgba(15,23,42,0.12)',
      shellShadow: '0 12px 40px rgba(15,23,42,0.14)',
      shellBackdropFilter,
      sectionBg: 'rgba(255,255,255,0.85)',
      sectionBorder: '0.5px solid rgba(15,23,42,0.08)',
      mutedText: '#6b7280',
      titleText: '#0c1322',
      iconBg: '#dcfce7',
      iconColor: '#16a34a',
      hoverBg: 'rgba(15,23,42,0.045)',
      selectedBg: 'rgba(34, 197, 94, 0.10)',
      selectedText: '#15803d',
      divider: 'rgba(15,23,42,0.08)',
    };
  }

  // ─── legacy palette (existing behavior) ──────────────────────
  if (darkMode) {
    return {
      isDark: true,
      shellBg: 'linear-gradient(180deg, rgba(15, 15, 17, 0.96) 0%, rgba(11, 11, 13, 0.98) 100%)',
      shellBorder: '1px solid rgba(255,255,255,0.08)',
      shellShadow: '0 24px 56px rgba(0,0,0,0.34)',
      shellBackdropFilter,
      sectionBg: 'rgba(255,255,255,0.03)',
      sectionBorder: '1px solid rgba(255,255,255,0.08)',
      mutedText: 'rgba(255,255,255,0.5)',
      titleText: '#f5f7ff',
      iconBg: 'rgba(255,214,102,0.12)',
      iconColor: '#ffd666',
      hoverBg: 'rgba(255,214,102,0.10)',
      selectedBg: 'rgba(255,214,102,0.14)',
      selectedText: '#ffd666',
      divider: 'rgba(255,255,255,0.08)',
    };
  }

  return {
    isDark: false,
    shellBg: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(246,248,252,0.98) 100%)',
    shellBorder: '1px solid rgba(16,24,40,0.08)',
    shellShadow: '0 18px 42px rgba(15,23,42,0.12)',
    shellBackdropFilter,
    sectionBg: 'rgba(255,255,255,0.84)',
    sectionBorder: '1px solid rgba(16,24,40,0.08)',
    mutedText: 'rgba(16,24,40,0.55)',
    titleText: '#162033',
    iconBg: 'rgba(24,144,255,0.1)',
    iconColor: '#1677ff',
    hoverBg: 'rgba(24,144,255,0.08)',
    selectedBg: 'rgba(24,144,255,0.12)',
    selectedText: '#1677ff',
    divider: 'rgba(16,24,40,0.08)',
  };
};

export type { OverlayWorkbenchTheme };
