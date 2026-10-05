import React, { useMemo, useCallback } from 'react';
import { theme } from 'antd';
import type { DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { APP_OVERLAY_Z_INDEX_BASE } from '../../utils/overlayZIndex';
import { matchFontFamilyOption, type FontFamilyOption } from '../../utils/fontFamilies';
import {
  type SidebarTableMetadataField,
  setSidebarTableMetadataFieldSelected,
  applySidebarTableMetadataFieldOrder,
} from '../../utils/sidebarTableMetadata';
import type { AppCoreStateApi } from './useAppCoreState';
import type { AppShellStateApi } from './useAppShellState';
import type { AppProxySettingsApi } from './useAppProxySettings';

export interface UseAppAntdThemeInput {
  isLinuxRuntime: AppCoreStateApi['isLinuxRuntime'];
  customThemeAntTokens: AppCoreStateApi['customThemeAntTokens'];
  darkMode: AppCoreStateApi['darkMode'];
  tokenFontSize: AppCoreStateApi['tokenFontSize'];
  tokenFontSizeSM: AppCoreStateApi['tokenFontSizeSM'];
  tokenFontSizeLG: AppCoreStateApi['tokenFontSizeLG'];
  resolvedUiFontFamily: AppShellStateApi['resolvedUiFontFamily'];
  resolvedMonoFontFamily: AppShellStateApi['resolvedMonoFontFamily'];
  tokenControlHeight: AppCoreStateApi['tokenControlHeight'];
  tokenControlHeightSM: AppCoreStateApi['tokenControlHeightSM'];
  tokenControlHeightLG: AppCoreStateApi['tokenControlHeightLG'];
  effectiveOpacity: AppShellStateApi['effectiveOpacity'];
  linuxCJKFontInstallHint: AppShellStateApi['linuxCJKFontInstallHint'];
  hasLoadedInstalledFontsRef: AppShellStateApi['hasLoadedInstalledFontsRef'];
  isFontFamiliesLoading: AppShellStateApi['isFontFamiliesLoading'];
  fontFamiliesLoadError: AppShellStateApi['fontFamiliesLoadError'];
  isLinuxCJKFontBannerDismissed: AppProxySettingsApi['isLinuxCJKFontBannerDismissed'];
  t: AppCoreStateApi['t'];
  sidebarTableMetadataFieldOrder: AppCoreStateApi['sidebarTableMetadataFieldOrder'];
  setQueryOptions: AppCoreStateApi['setQueryOptions'];
  sidebarTableMetadataFields: AppCoreStateApi['sidebarTableMetadataFields'];
}

export const useAppAntdTheme = ({
  isLinuxRuntime, customThemeAntTokens, darkMode, tokenFontSize, tokenFontSizeSM, tokenFontSizeLG,
  resolvedUiFontFamily, resolvedMonoFontFamily, tokenControlHeight, tokenControlHeightSM,
  tokenControlHeightLG, effectiveOpacity, linuxCJKFontInstallHint, hasLoadedInstalledFontsRef,
  isFontFamiliesLoading, fontFamiliesLoadError, isLinuxCJKFontBannerDismissed, t,
  sidebarTableMetadataFieldOrder, setQueryOptions, sidebarTableMetadataFields,
}: UseAppAntdThemeInput) => {
  const linuxResizeHandleStyleBase = {
      position: 'fixed',
      zIndex: 12000,
      background: 'transparent',
      WebkitAppRegion: 'drag',
      '--wails-draggable': 'drag',
      userSelect: 'none'
  } as any;

  const showLinuxResizeHandles = isLinuxRuntime;
  const resizeGuideColor = 'var(--gn-accent, #16a34a)';
  const v2AntPrimaryColor = customThemeAntTokens.primary ?? (darkMode ? '#22c55e' : '#16a34a');
  const v2AntPrimaryContrastColor = customThemeAntTokens.primaryContrast ?? '#ffffff';
  const v2AntPrimaryHoverColor = customThemeAntTokens.primaryHover ?? (darkMode ? '#4ade80' : '#15803d');
  const v2AntPrimaryActiveColor = customThemeAntTokens.primaryActive ?? (darkMode ? '#16a34a' : '#166534');
  const v2AntPrimaryBgColor = customThemeAntTokens.primaryBg ?? (darkMode ? 'rgba(34, 197, 94, 0.20)' : '#dcfce7');
  const v2AntPrimaryBgHoverColor = customThemeAntTokens.primaryBgHover ?? (darkMode ? 'rgba(34, 197, 94, 0.28)' : '#bbf7d0');
  const v2AntPrimaryBorderColor = customThemeAntTokens.primaryBorder ?? (darkMode ? 'rgba(34, 197, 94, 0.42)' : '#86efac');
  const v2AntPrimaryBorderHoverColor = customThemeAntTokens.primaryBorderHover ?? (darkMode ? 'rgba(74, 222, 128, 0.58)' : '#4ade80');
  const v2AntControlActiveBg = customThemeAntTokens.controlActiveBg ?? (darkMode ? 'rgba(34, 197, 94, 0.16)' : 'rgba(34, 197, 94, 0.10)');
  const v2AntControlActiveHoverBg = customThemeAntTokens.controlActiveHoverBg ?? (darkMode ? 'rgba(34, 197, 94, 0.24)' : 'rgba(34, 197, 94, 0.16)');
  const v2AntControlOutline = customThemeAntTokens.controlOutline ?? (darkMode ? 'rgba(34, 197, 94, 0.42)' : 'rgba(22, 163, 74, 0.22)');
  const v2AntBgContainer = customThemeAntTokens.bgContainer;
  const v2AntBgElevated = customThemeAntTokens.bgElevated;
  const v2AntFillAlter = customThemeAntTokens.fillAlter;
  const v2AntTextPrimary = customThemeAntTokens.textPrimary;
  const v2AntTextSecondary = customThemeAntTokens.textSecondary;
  const v2AntBorder = customThemeAntTokens.border;
  const v2AntRowHoverBg = customThemeAntTokens.rowHoverBg;
  const v2AntInfoColor = customThemeAntTokens.info ?? v2AntPrimaryColor;
  const antdTheme = useMemo(() => ({
      algorithm: darkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
      token: {
          fontSize: tokenFontSize,
          fontSizeSM: tokenFontSizeSM,
          fontSizeLG: tokenFontSizeLG,
          fontFamily: resolvedUiFontFamily,
          fontFamilyCode: resolvedMonoFontFamily,
          zIndexPopupBase: APP_OVERLAY_Z_INDEX_BASE,
          controlHeight: tokenControlHeight,
          controlHeightSM: tokenControlHeightSM,
          controlHeightLG: tokenControlHeightLG,
          colorBgLayout: 'transparent',
          colorBgContainer: v2AntBgContainer ?? (darkMode
              ? `rgba(29, 29, 29, ${effectiveOpacity})`
              : `rgba(255, 255, 255, ${effectiveOpacity})`),
          colorBgElevated: v2AntBgElevated ?? (darkMode
              ? '#1f1f1f'
              : '#ffffff'),
          colorFillAlter: v2AntFillAlter ?? (darkMode
              ? `rgba(38, 38, 38, ${effectiveOpacity})`
              : `rgba(250, 250, 250, ${effectiveOpacity})`),
          ...(v2AntTextPrimary ? { colorText: v2AntTextPrimary } : {}),
          ...(v2AntTextSecondary ? { colorTextSecondary: v2AntTextSecondary } : {}),
          ...(v2AntBorder ? {
              colorBorder: v2AntBorder,
              colorBorderSecondary: v2AntBorder,
          } : {}),
          colorPrimary: v2AntPrimaryColor,
          colorTextLightSolid: v2AntPrimaryContrastColor,
          colorPrimaryHover: v2AntPrimaryHoverColor,
          colorPrimaryActive: v2AntPrimaryActiveColor,
          colorInfo: v2AntInfoColor,
          colorLink: v2AntPrimaryColor,
          colorLinkHover: v2AntPrimaryHoverColor,
          colorLinkActive: v2AntPrimaryActiveColor,
          colorPrimaryBg: v2AntPrimaryBgColor,
          colorPrimaryBgHover: v2AntPrimaryBgHoverColor,
          colorPrimaryBorder: v2AntPrimaryBorderColor,
          colorPrimaryBorderHover: v2AntPrimaryBorderHoverColor,
          controlItemBgActive: v2AntControlActiveBg,
          controlItemBgActiveHover: v2AntControlActiveHoverBg,
          controlOutline: v2AntControlOutline,
      },
      components: {
          Layout: {
              bodyBg: 'transparent',
              headerBg: 'transparent',
              siderBg: 'transparent',
              triggerBg: 'transparent'
          },
          Table: {
              headerBg: 'transparent',
              rowHoverBg: v2AntRowHoverBg
                  ?? (darkMode ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.02)'),
          },
          Tabs: {
              cardBg: 'transparent',
              itemActiveColor: v2AntPrimaryHoverColor,
              itemHoverColor: v2AntPrimaryHoverColor,
              itemSelectedColor: v2AntPrimaryColor,
              inkBarColor: v2AntPrimaryColor,
          }
      }
  }), [
      darkMode,
      effectiveOpacity,
      v2AntBgContainer,
      v2AntBgElevated,
      v2AntBorder,
      v2AntControlActiveBg,
      v2AntControlActiveHoverBg,
      v2AntControlOutline,
      v2AntFillAlter,
      v2AntInfoColor,
      v2AntPrimaryActiveColor,
      v2AntPrimaryBgColor,
      v2AntPrimaryBgHoverColor,
      v2AntPrimaryBorderColor,
      v2AntPrimaryBorderHoverColor,
      v2AntPrimaryColor,
      v2AntPrimaryContrastColor,
      v2AntPrimaryHoverColor,
      v2AntRowHoverBg,
      v2AntTextPrimary,
      v2AntTextSecondary,
      tokenControlHeight,
      tokenControlHeightLG,
      tokenControlHeightSM,
      tokenFontSize,
      tokenFontSizeLG,
      tokenFontSizeSM,
      resolvedMonoFontFamily,
      resolvedUiFontFamily,
  ]);
  const filterFontOption = useCallback((input: string, option?: { value?: string; label?: React.ReactNode }) => (
      matchFontFamilyOption(input, {
          value: String(option?.value || ''),
          label: String(option?.label || ''),
      })
  ), []);
  const renderFontOptionLabel = useCallback((option: FontFamilyOption) => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, lineHeight: 1.35 }}>
          <span>{option.label}</span>
          <span style={{ fontSize: 11, color: darkMode ? 'rgba(255,255,255,0.45)' : 'rgba(16,24,40,0.45)' }}>
              {option.value}
          </span>
      </div>
  ), [darkMode]);
  const showLinuxCJKFontBanner = Boolean(
      linuxCJKFontInstallHint &&
      hasLoadedInstalledFontsRef.current &&
      !isFontFamiliesLoading &&
      !fontFamiliesLoadError &&
      !isLinuxCJKFontBannerDismissed,
  );
  const sidebarMetadataFieldItems = useMemo(() => {
      const labelByField: Record<SidebarTableMetadataField, string> = {
          comment: t('sidebar.v2_table_group_menu.show_table_comments'),
          rows: t('sidebar.v2_table_group_menu.display_table_rows'),
          size: t('sidebar.v2_table_group_menu.display_table_size'),
          createdAt: t('sidebar.v2_table_group_menu.display_create_time'),
          updatedAt: t('sidebar.v2_table_group_menu.display_update_time'),
      };
      return sidebarTableMetadataFieldOrder.map((field) => ({
          field,
          label: labelByField[field],
      }));
  }, [sidebarTableMetadataFieldOrder, t]);
  const toggleSidebarMetadataFieldFromSettings = useCallback((field: SidebarTableMetadataField, selected: boolean) => {
      setQueryOptions({
          sidebarTableMetadataFields: setSidebarTableMetadataFieldSelected(
              sidebarTableMetadataFields,
              field,
              selected,
              sidebarTableMetadataFieldOrder,
          ),
      });
  }, [setQueryOptions, sidebarTableMetadataFieldOrder, sidebarTableMetadataFields]);
  const handleSidebarMetadataDragEnd = useCallback((event: DragEndEvent) => {
      const activeField = String(event.active.id || '') as SidebarTableMetadataField;
      const overField = String(event.over?.id || '') as SidebarTableMetadataField;
      if (!overField || activeField === overField) {
          return;
      }
      const currentOrder = sidebarMetadataFieldItems.map((item) => item.field);
      const activeIndex = currentOrder.indexOf(activeField);
      const overIndex = currentOrder.indexOf(overField);
      if (activeIndex < 0 || overIndex < 0) {
          return;
      }
      const nextOrder = arrayMove(currentOrder, activeIndex, overIndex);
      setQueryOptions({
          sidebarTableMetadataFieldOrder: nextOrder,
          sidebarTableMetadataFields: applySidebarTableMetadataFieldOrder(
              sidebarTableMetadataFields,
              nextOrder,
          ),
      });
  }, [setQueryOptions, sidebarMetadataFieldItems, sidebarTableMetadataFields]);
  return {
    linuxResizeHandleStyleBase, showLinuxResizeHandles, resizeGuideColor, v2AntPrimaryColor,
    v2AntPrimaryBgColor, antdTheme, filterFontOption, renderFontOptionLabel, showLinuxCJKFontBanner,
    sidebarMetadataFieldItems, toggleSidebarMetadataFieldFromSettings, handleSidebarMetadataDragEnd,
  };
};

export type AppAntdThemeApi = ReturnType<typeof useAppAntdTheme>;
