import React, { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ConfigProvider, theme as antdTheme } from 'antd';

export type GonaviThemeMode = 'light' | 'dark' | 'system';

export interface GonaviThemeProviderProps {
  children: ReactNode;
  mode?: GonaviThemeMode;
  /** Optional host token overrides, for example the primary colour read from ui.theme.get. */
  tokens?: Record<string, string | number>;
  className?: string;
}

interface GonaviThemeContextValue {
  mode: GonaviThemeMode;
  cssVars: Record<string, string>;
}

const GonaviThemeContext = createContext<GonaviThemeContextValue>({
  mode: 'light',
  cssVars: {},
});

export function useGonaviTheme(): GonaviThemeContextValue {
  return useContext(GonaviThemeContext);
}

const UI_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const MONO_FONT =
  '"SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/**
 * GonaviThemeProvider gives a plugin window or page the same antd token family
 * and CSS variables as the host. It never reads the host store or Wails
 * bindings; a plugin can pass the tokens it obtained through `ui.theme.get`.
 */
export const GonaviThemeProvider: React.FC<GonaviThemeProviderProps> = ({
  children,
  mode = 'light',
  tokens,
  className,
}) => {
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    if (mode !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, [mode]);
  const resolvedMode: 'light' | 'dark' = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
  const dark = resolvedMode === 'dark';
  const cssVars = useMemo<Record<string, string>>(() => ({
    '--gonavi-bg': dark ? '#141414' : '#f6f7f9',
    '--gonavi-panel': dark ? '#1d1d1d' : '#ffffff',
    '--gonavi-panel-alt': dark ? '#232323' : '#fafafa',
    '--gonavi-border': dark ? 'rgba(255,255,255,0.12)' : '#e5e7eb',
    '--gonavi-text': dark ? 'rgba(255,255,255,0.88)' : '#1f2329',
    '--gonavi-text-secondary': dark ? 'rgba(255,255,255,0.58)' : '#5f6774',
    '--gonavi-accent': dark ? '#22c55e' : '#16a34a',
    '--gonavi-accent-soft': dark ? 'rgba(34,197,94,0.18)' : '#dcfce7',
    '--gonavi-radius': '8px',
    '--gonavi-font-ui': UI_FONT,
    '--gonavi-font-mono': MONO_FONT,
    ...Object.fromEntries(
      Object.entries(tokens ?? {})
        .filter(([key]) => key.startsWith('--'))
        .map(([key, value]) => [key, String(value)]),
    ),
  }), [dark, tokens]);

  const antdTokens = useMemo(() => ({
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: dark ? '#22c55e' : '#16a34a',
      colorBgLayout: 'transparent',
      colorBgContainer: cssVars['--gonavi-panel'],
      colorBgElevated: dark ? '#1f1f1f' : '#ffffff',
      colorText: cssVars['--gonavi-text'],
      colorTextSecondary: cssVars['--gonavi-text-secondary'],
      colorBorder: cssVars['--gonavi-border'],
      colorBorderSecondary: cssVars['--gonavi-border'],
      borderRadius: 8,
      fontFamily: UI_FONT,
      fontFamilyCode: MONO_FONT,
      ...tokens,
    },
  }), [cssVars, dark, tokens]);

  return (
    <GonaviThemeContext.Provider value={{ mode: resolvedMode, cssVars }}>
      <ConfigProvider theme={antdTokens}>
        <div
          className={['gonavi-plugin-root', className].filter(Boolean).join(' ')}
          data-gonavi-theme={resolvedMode}
          style={cssVars as React.CSSProperties}
        >
          {children}
        </div>
      </ConfigProvider>
    </GonaviThemeContext.Provider>
  );
};
