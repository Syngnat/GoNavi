import { resolveTextInputSafeBackdropFilter } from '../utils/appearance';

type RedisWorkbenchThemeInput = {
  darkMode: boolean;
  blur: number;
  disableBackdropFilter?: boolean;
};

type RedisWorkbenchTheme = {
  isDark: boolean;
  appBg: string;
  panelBg: string;
  panelBgStrong: string;
  panelBgSubtle: string;
  panelBorder: string;
  panelInset: string;
  toolbarPrimaryBg: string;
  contentEmptyBg: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentSoft: string;
  accentBorder: string;
  actionSecondaryBg: string;
  actionSecondaryBorder: string;
  actionDangerBg: string;
  actionDangerBorder: string;
  actionDangerText: string;
  statusTagBg: string;
  statusTagBorder: string;
  statusTagMutedBg: string;
  statusTagMutedBorder: string;
  treeHoverBg: string;
  treeSelectedBg: string;
  treeSelectedBorder: string;
  divider: string;
  shadow: string;
  backdropFilter: string;
};

export const buildRedisWorkbenchTheme = ({
  darkMode,
  blur,
  disableBackdropFilter,
}: RedisWorkbenchThemeInput): RedisWorkbenchTheme => {
  const normalizedBlur = Math.max(0, Math.round(blur));
  const backdropFilter = resolveTextInputSafeBackdropFilter(
    normalizedBlur > 0 ? `blur(${normalizedBlur}px)` : 'none',
    disableBackdropFilter ?? false,
  );

    if (darkMode) {
      return {
        isDark: true,
        appBg: '#0c0e12',
        panelBg: '#161a21',
        panelBgStrong: '#1b1f27',
        panelBgSubtle: 'rgba(255,255,255,0.04)',
        panelBorder: '0.5px solid rgba(255,255,255,0.10)',
        panelInset: 'inset 0 0.5px 0 rgba(255,255,255,0.05)',
        toolbarPrimaryBg: 'linear-gradient(135deg, rgba(248,113,113,0.18) 0%, rgba(248,113,113,0.08) 100%)',
        contentEmptyBg: 'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.01) 100%)',
        textPrimary: '#f1f3f5',
        textSecondary: '#d6dade',
        textMuted: '#80868f',
        accent: '#f87171',
        accentSoft: 'rgba(248, 113, 113, 0.16)',
        accentBorder: 'rgba(248, 113, 113, 0.32)',
        actionSecondaryBg: 'rgba(255,255,255,0.05)',
        actionSecondaryBorder: '0.5px solid rgba(255,255,255,0.10)',
        actionDangerBg: 'rgba(220, 38, 38, 0.16)',
        actionDangerBorder: '0.5px solid rgba(220, 38, 38, 0.32)',
        actionDangerText: '#f87171',
        statusTagBg: 'rgba(56, 189, 248, 0.16)',
        statusTagBorder: '0.5px solid rgba(56, 189, 248, 0.30)',
        statusTagMutedBg: 'rgba(255,255,255,0.06)',
        statusTagMutedBorder: '0.5px solid rgba(255,255,255,0.10)',
        treeHoverBg: 'rgba(255,255,255,0.05)',
        treeSelectedBg: 'linear-gradient(90deg, rgba(248,113,113,0.18) 0%, rgba(248,113,113,0.06) 100%)',
        treeSelectedBorder: 'rgba(248, 113, 113, 0.28)',
        divider: 'rgba(255,255,255,0.06)',
        shadow: '0 12px 40px rgba(0,0,0,0.55)',
        backdropFilter,
      };
    }
    return {
      isDark: false,
      appBg: '#f6f6f4',
      panelBg: '#ffffff',
      panelBgStrong: '#ffffff',
      panelBgSubtle: '#fafaf8',
      panelBorder: '0.5px solid rgba(15,23,42,0.12)',
      panelInset: 'inset 0 0.5px 0 rgba(255,255,255,0.6)',
      toolbarPrimaryBg: 'linear-gradient(135deg, rgba(220,38,38,0.10) 0%, rgba(220,38,38,0.04) 100%)',
      contentEmptyBg: 'linear-gradient(180deg, rgba(15,23,42,0.02) 0%, rgba(15,23,42,0.01) 100%)',
      textPrimary: '#0c1322',
      textSecondary: '#1f2937',
      textMuted: '#6b7280',
      accent: '#dc2626',
      accentSoft: 'rgba(220, 38, 38, 0.10)',
      accentBorder: 'rgba(220, 38, 38, 0.24)',
      actionSecondaryBg: '#ffffff',
      actionSecondaryBorder: '0.5px solid rgba(15,23,42,0.12)',
      actionDangerBg: 'rgba(220, 38, 38, 0.10)',
      actionDangerBorder: '0.5px solid rgba(220, 38, 38, 0.24)',
      actionDangerText: '#dc2626',
      statusTagBg: 'rgba(2, 132, 199, 0.10)',
      statusTagBorder: '0.5px solid rgba(2, 132, 199, 0.24)',
      statusTagMutedBg: 'rgba(15,23,42,0.04)',
      statusTagMutedBorder: '0.5px solid rgba(15,23,42,0.08)',
      treeHoverBg: 'rgba(15,23,42,0.045)',
      treeSelectedBg: 'linear-gradient(90deg, rgba(220,38,38,0.10) 0%, rgba(220,38,38,0.02) 100%)',
      treeSelectedBorder: 'rgba(220, 38, 38, 0.22)',
      divider: 'rgba(15,23,42,0.08)',
      shadow: '0 12px 40px rgba(15,23,42,0.14)',
      backdropFilter,
    };
  };

export type { RedisWorkbenchTheme, RedisWorkbenchThemeInput };
