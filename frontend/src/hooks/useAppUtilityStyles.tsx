import React, { useMemo } from 'react';
import { isMacLikePlatform } from '../utils/appearance';
import { buildOverlayWorkbenchTheme } from '../utils/overlayWorkbenchTheme';

type UseAppUtilityStylesOptions = {
  blurFilter?: string;
  darkMode: boolean;
  effectiveOpacity: number;
  effectiveUiScale: number;
  isV2Ui: boolean;
  resolvedAppearance: {
    opacity: number;
    blur: number;
  };
  sidebarWidth: number;
};

export const useAppUtilityStyles = ({
  blurFilter,
  darkMode,
  effectiveOpacity,
  effectiveUiScale,
  isV2Ui,
  resolvedAppearance,
  sidebarWidth,
}: UseAppUtilityStylesOptions) => {
  const effectiveBlurFilter = blurFilter || 'none';
  const getBg = (darkHex: string) => {
    if (!darkMode) return `rgba(255, 255, 255, ${effectiveOpacity})`;
    const hex = darkHex.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${effectiveOpacity})`;
  };

  // v2 / 自定义主题：走 CSS token，主内容与 sider 同为 panel-2，避免并排色差。
  // legacy 仍用 getBg 做透明度混合。
  const bgMain = isV2Ui ? 'var(--gn-bg-panel-2)' : getBg('#141414');
  const bgContent = isV2Ui ? 'var(--gn-bg-panel-2)' : getBg('#1d1d1d');
  const floatingLogButtonBorderColor = darkMode ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.16)';
  const floatingLogButtonTextColor = darkMode ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.82)';
  const floatingLogButtonBgColor = darkMode
    ? `rgba(34, 34, 34, ${Math.max(effectiveOpacity, 0.82)})`
    : `rgba(255, 255, 255, ${Math.max(effectiveOpacity, 0.9)})`;
  const floatingLogButtonShadow = darkMode
    ? '0 8px 22px rgba(0,0,0,0.38)'
    : '0 8px 20px rgba(0,0,0,0.16)';
  const isOpaqueUtilityMode = resolvedAppearance.opacity >= 0.999 && resolvedAppearance.blur <= 0;
  const utilityButtonBgAlpha = darkMode
    ? Math.max(0.28, Math.min(0.76, effectiveOpacity * 0.72))
    : Math.max(0.52, Math.min(0.92, effectiveOpacity * 0.9));
  const utilityButtonBgColor = isOpaqueUtilityMode
    ? 'transparent'
    : (darkMode
      ? `rgba(20, 26, 38, ${utilityButtonBgAlpha})`
      : `rgba(255, 255, 255, ${utilityButtonBgAlpha})`);
  const utilityButtonBorderColor = isOpaqueUtilityMode
    ? (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(16,24,40,0.10)')
    : (darkMode
      ? `rgba(255,255,255,${Math.max(0.08, Math.min(0.18, effectiveOpacity * 0.16))})`
      : `rgba(16,24,40,${Math.max(0.06, Math.min(0.14, effectiveOpacity * 0.12))})`);
  const utilityButtonShadow = isOpaqueUtilityMode
    ? 'none'
    : (darkMode
      ? `0 8px 18px rgba(0,0,0,${Math.max(0.10, Math.min(0.22, effectiveOpacity * 0.24))})`
      : `0 8px 18px rgba(15,23,42,${Math.max(0.04, Math.min(0.12, effectiveOpacity * 0.12))})`);
  const isSidebarNarrow = sidebarWidth < 360;
  const isSidebarCompact = sidebarWidth < 320;
  const isSidebarUltraCompact = sidebarWidth < 260;
  const utilityButtonStyle = useMemo(() => ({
    height: Math.max(30, Math.round(32 * effectiveUiScale)),
    width: '100%',
    paddingInline: isSidebarCompact ? Math.max(8, Math.round(9 * effectiveUiScale)) : Math.max(10, Math.round(12 * effectiveUiScale)),
    borderRadius: 10,
    border: `1px solid ${utilityButtonBorderColor}`,
    background: utilityButtonBgColor,
    color: darkMode ? 'rgba(255,255,255,0.94)' : '#162033',
    boxShadow: utilityButtonShadow,
    backdropFilter: isOpaqueUtilityMode ? 'none' : effectiveBlurFilter,
    WebkitBackdropFilter: isOpaqueUtilityMode ? 'none' : effectiveBlurFilter,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: isSidebarCompact ? 4 : 6,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: isSidebarCompact ? 13 : 14,
  }), [effectiveBlurFilter, darkMode, effectiveUiScale, isOpaqueUtilityMode, isSidebarCompact, utilityButtonBgColor, utilityButtonBorderColor, utilityButtonShadow]);
  const disableLocalBackdropFilter = isMacLikePlatform();
  const overlayTheme = useMemo(
    () => buildOverlayWorkbenchTheme(darkMode, {
      disableBackdropFilter: disableLocalBackdropFilter,
      uiVersion: isV2Ui ? 'v2' : 'legacy',
    }),
    [darkMode, disableLocalBackdropFilter, isV2Ui],
  );

  const sidebarQuickActionBaseStyle = useMemo(() => ({
    height: Math.max(34, Math.round(36 * effectiveUiScale)),
    borderRadius: 12,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingInline: Math.max(12, Math.round(14 * effectiveUiScale)),
    fontWeight: 700,
    boxShadow: darkMode ? '0 8px 18px rgba(0,0,0,0.16)' : '0 8px 16px rgba(15,23,42,0.08)',
    backdropFilter: effectiveBlurFilter,
    WebkitBackdropFilter: effectiveBlurFilter,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }), [effectiveBlurFilter, darkMode, effectiveUiScale]);
  const sidebarQueryActionStyle = useMemo(() => ({
    ...sidebarQuickActionBaseStyle,
    flex: '1 1 0',
    border: `1px solid ${darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(16,24,40,0.10)'}`,
    background: darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.88)',
    color: darkMode ? 'rgba(255,255,255,0.92)' : '#162033',
  }), [darkMode, sidebarQuickActionBaseStyle]);
  const sidebarCreateConnectionActionStyle = useMemo(() => ({
    ...sidebarQuickActionBaseStyle,
    flex: '1 1 0',
    border: 'none',
    background: 'linear-gradient(135deg, rgba(34,197,94,0.96) 0%, rgba(22,163,74,0.92) 100%)',
    color: '#f3fff7',
  }), [sidebarQuickActionBaseStyle]);

  const utilityModalShellStyle = useMemo(() => ({
    background: overlayTheme.shellBg,
    border: overlayTheme.shellBorder,
    boxShadow: overlayTheme.shellShadow,
    backdropFilter: overlayTheme.shellBackdropFilter,
  }), [overlayTheme]);
  const utilityPanelStyle = useMemo(() => ({
    padding: '16px 2px',
    borderRadius: 0,
    border: 'none',
    background: 'transparent',
  }), []);
  const toolCenterModalContentStyle = useMemo<React.CSSProperties>(() => ({
    ...utilityModalShellStyle,
    height: 'min(820px, calc(100vh - 64px))',
    display: 'flex',
    flexDirection: 'column',
  }), [utilityModalShellStyle]);
  const toolCenterModalWorkspaceStyle = useMemo<React.CSSProperties>(() => ({
    display: 'flex',
    flexDirection: 'column',
    padding: '8px 0 2px',
    height: '100%',
    minHeight: 0,
  }), []);
  const toolCenterModalSplitStyle = useMemo<React.CSSProperties>(() => ({
    display: 'grid',
    gridTemplateColumns: '204px minmax(0, 1fr)',
    gap: 16,
    flex: 1,
    minHeight: 0,
  }), []);
  const toolCenterNavPanelStyle = useMemo<React.CSSProperties>(() => ({
    padding: '4px 16px 4px 0',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    borderRight: `1px solid ${overlayTheme.divider}`,
  }), [overlayTheme.divider]);
  const toolCenterNavScrollStyle = useMemo<React.CSSProperties>(() => ({
    display: 'grid',
    alignContent: 'start',
    gap: 2,
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    paddingRight: 4,
  }), []);
  const toolCenterContentPanelStyle = useMemo<React.CSSProperties>(() => ({
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    minHeight: 0,
    overflow: 'hidden',
  }), []);
  const toolCenterDetailPanelStyle = useMemo<React.CSSProperties>(() => ({
    ...utilityPanelStyle,
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  }), [utilityPanelStyle]);
  const toolCenterDetailBodyStyle = useMemo<React.CSSProperties>(() => ({
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    paddingRight: 6,
    overscrollBehavior: 'contain',
  }), []);
  const toolCenterScrollableListStyle = useMemo<React.CSSProperties>(() => ({
    flex: 1,
    minHeight: 0,
    display: 'grid',
    alignContent: 'start',
    gap: 2,
    overflowY: 'auto',
    overflowX: 'hidden',
    overscrollBehavior: 'contain',
  }), []);
  const utilityMutedTextStyle = useMemo(() => ({
    color: overlayTheme.mutedText,
    fontSize: 'var(--gn-font-size-sm, 12px)',
    lineHeight: 1.6,
  }), [overlayTheme]);
  const renderUtilityModalTitle = (
    icon: React.ReactNode,
    title: string,
    description: string,
  ) => (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, minWidth: 0 }}>
      <div style={{ width: 36, height: 36, borderRadius: 12, display: 'grid', placeItems: 'center', background: overlayTheme.iconBg, color: overlayTheme.iconColor, flexShrink: 0 }}>
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 'calc(var(--gn-font-size, 14px) * 1.14)', fontWeight: 700, color: overlayTheme.titleText }}>{title}</div>
        <div style={{ marginTop: 4, color: overlayTheme.mutedText, fontSize: 'var(--gn-font-size-sm, 12px)', lineHeight: 1.6 }}>{description}</div>
      </div>
    </div>
  );
  const utilityActionCardStyle = useMemo(() => ({
    width: '100%',
    minHeight: 64,
    borderRadius: 0,
    border: 'none',
    borderBottom: `1px solid ${overlayTheme.divider}`,
    background: 'transparent',
    color: overlayTheme.titleText,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 14,
    paddingInline: 8,
    boxShadow: 'none',
    fontSize: 'var(--gn-font-size, 14px)',
    fontWeight: 600,
  }), [overlayTheme]);
  const utilityActionHintStyle = useMemo(() => ({
    fontSize: 'var(--gn-font-size-sm, 12px)',
    color: overlayTheme.mutedText,
    fontWeight: 400,
    marginTop: 2,
  }), [overlayTheme]);
  const toolCenterRowStyle = useMemo(() => ({
    width: '100%',
    minHeight: 58,
    borderRadius: 4,
    color: overlayTheme.titleText,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    paddingInline: 6,
    paddingBlock: 8,
    boxShadow: 'none',
    fontSize: 'var(--gn-font-size, 14px)',
    fontWeight: 600,
  }), [overlayTheme]);
  const toolCenterRowDescriptionStyle = useMemo(() => ({
    ...utilityActionHintStyle,
    marginTop: 4,
    textAlign: 'left' as const,
    whiteSpace: 'normal' as const,
    lineHeight: 1.55,
  }), [utilityActionHintStyle]);

  const sidebarHorizontalPadding = isSidebarCompact ? 8 : 10;

  return {
    bgContent,
    bgMain,
    floatingLogButtonBgColor,
    floatingLogButtonBorderColor,
    floatingLogButtonShadow,
    floatingLogButtonTextColor,
    isSidebarCompact,
    isSidebarNarrow,
    isSidebarUltraCompact,
    overlayTheme,
    renderUtilityModalTitle,
    sidebarCreateConnectionActionStyle,
    sidebarHorizontalPadding,
    sidebarQueryActionStyle,
    toolCenterContentPanelStyle,
    toolCenterDetailBodyStyle,
    toolCenterDetailPanelStyle,
    toolCenterModalContentStyle,
    toolCenterModalSplitStyle,
    toolCenterModalWorkspaceStyle,
    toolCenterNavPanelStyle,
    toolCenterNavScrollStyle,
    toolCenterRowDescriptionStyle,
    toolCenterRowStyle,
    toolCenterScrollableListStyle,
    utilityActionCardStyle,
    utilityActionHintStyle,
    utilityButtonStyle,
    utilityModalShellStyle,
    utilityMutedTextStyle,
    utilityPanelStyle,
  };
};
