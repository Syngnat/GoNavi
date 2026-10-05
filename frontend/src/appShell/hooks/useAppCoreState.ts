import { notification, message } from 'antd';
import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { useSensors, useSensor, PointerSensor } from '@dnd-kit/core';
import { useI18n } from '../../i18n/provider';
import { useAIWorkspaceSnapshot } from '../../components/ai/useAIWorkspaceSnapshot';
import { SavedConnection } from '../../types';
import {
  useStore,
  sanitizeV2SidebarRailScale,
  sanitizeTabEnvironmentAccentThickness,
  type QueryTableCtrlClickAction,
  type ThemePreference,
} from '../../store';
import { useCustomThemeStore } from '../../customThemeStore';
import { getSystemThemeMode } from '../appEnvironment';
import { resolveAvailableCustomTheme } from '../../utils/customThemePresets';
import { extractCustomThemeAntTokens } from '../../utils/customTheme';
import type { CustomThemeAntTokenSnapshot } from '../../components/theme/CustomThemeStyleHost';
import {
  MAX_UI_SCALE,
  MIN_UI_SCALE,
  DEFAULT_UI_SCALE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  DEFAULT_FONT_SIZE,
} from '../appSettingsConstants';
import { resolveTitleBarToggleIconKey } from '../../utils/windowStateUi';
import {
  sanitizeDataTableFontSize,
  sanitizeSidebarTreeFontSize,
} from '../../utils/dataGridDisplay';
import { resolveSqlEditorFontSize } from '../../utils/sqlEditorTypography';
import { DEFAULT_QUERY_TEMPLATE } from '../../components/queryEditor/QueryEditorHelpers';
import {
  resolveSidebarTableMetadataFieldOrder,
  resolveSidebarTableMetadataFields,
} from '../../utils/sidebarTableMetadata';
import {
  sanitizeTabDisplaySettings,
  resolveTabDisplayElementOrder,
  type TabDisplayElementKey,
  TAB_DISPLAY_ELEMENT_META,
  type TabDisplaySettings,
  applyTabDisplaySettingsPatch,
  type TabDisplayLayout,
  switchTabDisplayLayout,
  TAB_DISPLAY_SECONDARY_DEFAULT_KEYS,
} from '../../utils/tabDisplay';
import { safeWindowRuntimeCall } from '../../utils/wailsRuntime';
import {
  WindowSetSystemDefaultTheme,
  WindowSetDarkTheme,
  WindowSetLightTheme,
} from '../../../wailsjs/runtime';
import { useBrandIconSync } from '../../brand/useBrandIconSync';
import { suppressThemeSwitchTransitions } from '../../components/theme/themeSwitchTransition';

export interface UseAppCoreStateInput {
  setFocusedTabDisplayElementKey: React.Dispatch<React.SetStateAction<TabDisplayElementKey | null>>;
}

export const useAppCoreState = ({ setFocusedTabDisplayElementKey }: UseAppCoreStateInput) => {
  const { language, t } = useI18n();
  // The workspace source belongs to the application lifetime, not to the
  // optional AI panel. This keeps a running harness supplied with a live
  // snapshot while the panel is hidden, detached, or being remounted.
  useAIWorkspaceSnapshot({ enabled: true });
  const [notificationApi, notificationContextHolder] = notification.useNotification();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isConnectionModalMounted, setIsConnectionModalMounted] = useState(false);
  const [editingConnection, setEditingConnection] = useState<SavedConnection | null>(null);
  const [connectionHealthTargetIds, setConnectionHealthTargetIds] = useState<string[]>([]);
  const pendingConnectionTagIdRef = useRef<string | null>(null);
  const connectionModalWarmupDoneRef = useRef(false);
  const windowState = useStore(state => state.windowState);
  const themeMode = useStore(state => state.theme);
  const themePreference = useStore(state => state.themePreference);
  const setTheme = useStore(state => state.setTheme);
  const setThemePreference = useStore(state => state.setThemePreference);
  const customThemes = useCustomThemeStore(state => state.themes);
  const activeCustomThemeId = useCustomThemeStore(state => state.activeThemeId);
  const activateRememberedCustomTheme = useCustomThemeStore(state => state.activateRememberedCustomTheme);
  const appearance = useStore(state => state.appearance);
  const setAppearance = useStore(state => state.setAppearance);
  const uiScale = useStore(state => state.uiScale);
  const setUiScale = useStore(state => state.setUiScale);
  const fontSize = useStore(state => state.fontSize);
  const setFontSize = useStore(state => state.setFontSize);
  // Keep reading the legacy persisted field; its product meaning is now startup maximise.
  const startupMaximised = useStore(state => state.startupFullscreen);
  const setStartupMaximised = useStore(state => state.setStartupFullscreen);
  const autoCheckForUpdates = useStore(state => state.autoCheckForUpdates);
  const setAutoCheckForUpdates = useStore(state => state.setAutoCheckForUpdates);
  const autoCheckForUpdatesIntervalMinutes = useStore(state => state.autoCheckForUpdatesIntervalMinutes);
  const setAutoCheckForUpdatesIntervalMinutes = useStore(state => state.setAutoCheckForUpdatesIntervalMinutes);
  const globalProxy = useStore(state => state.globalProxy);
  const replaceConnections = useStore(state => state.replaceConnections);
  const replaceConnectionSidebarLayout = useStore(state => state.replaceConnectionSidebarLayout);
  const replaceGlobalProxy = useStore(state => state.replaceGlobalProxy);
  const replaceSavedQueries = useStore(state => state.replaceSavedQueries);
  const reloadSavedQueryGroups = useStore(state => state.reloadSavedQueryGroups);
  const queryOptions = useStore(state => state.queryOptions);
  const setQueryOptions = useStore(state => state.setQueryOptions);
  const shortcutOptions = useStore(state => state.shortcutOptions);
  const updateShortcut = useStore(state => state.updateShortcut);
  const resetShortcutOptions = useStore(state => state.resetShortcutOptions);
  const [systemThemeMode, setSystemThemeMode] = useState<'light' | 'dark'>(() => getSystemThemeMode());
  const [runtimePlatform, setRuntimePlatform] = useState('');
  // 品牌图标领域逻辑（favicon、原生图标同步、资源加载、设置面板选择流程）在独立 hook 中。
  const { brandIconId, handleBrandIconChange } = useBrandIconSync(runtimePlatform);
  const [runtimeBuildType, setRuntimeBuildType] = useState('');
  const [isLinuxRuntime, setIsLinuxRuntime] = useState(false);
  const activeCustomTheme = useMemo(
      () => resolveAvailableCustomTheme(customThemes, activeCustomThemeId),
      [activeCustomThemeId, customThemes],
  );
  const effectiveThemePreference = activeCustomTheme?.baseMode ?? themePreference;
  const resolvedThemeMode = effectiveThemePreference === 'system'
      ? systemThemeMode
      : effectiveThemePreference;
  const darkMode = resolvedThemeMode === 'dark';
  const sourceCustomThemeAntTokens = useMemo(
      () => activeCustomTheme ? extractCustomThemeAntTokens(activeCustomTheme.css) : {},
      [activeCustomTheme],
  );
  const [computedCustomThemeAntTokens, setComputedCustomThemeAntTokens] = useState<CustomThemeAntTokenSnapshot | null>(null);
  const customThemeStyleContextKey = `${resolvedThemeMode}:v2`;
  const customThemeAntTokens = activeCustomTheme
      && computedCustomThemeAntTokens?.themeId === activeCustomTheme.id
      && computedCustomThemeAntTokens.themeRevision === activeCustomTheme.updatedAt
      && computedCustomThemeAntTokens.contextKey === customThemeStyleContextKey
      ? computedCustomThemeAntTokens.tokens
      : sourceCustomThemeAntTokens;

  const effectiveUiScale = Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, Number(uiScale) || DEFAULT_UI_SCALE));
  const effectiveFontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(Number(fontSize) || DEFAULT_FONT_SIZE)));
  const tokenFontSize = Math.round(effectiveFontSize * effectiveUiScale);
  const titleBarToggleIconKey = resolveTitleBarToggleIconKey(
      windowState === 'fullscreen' ? 'fullscreen' : (windowState === 'maximized' ? 'maximized' : 'normal')
  );
  const tokenFontSizeSM = Math.max(10, Math.round(tokenFontSize * 0.86));
  const tokenFontSizeLG = Math.max(tokenFontSize + 1, Math.round(tokenFontSize * 1.14));
  const tokenControlHeight = Math.max(24, Math.round(32 * effectiveUiScale));
  const tokenControlHeightSM = Math.max(20, Math.round(24 * effectiveUiScale));
  const tokenControlHeightLG = Math.max(30, Math.round(40 * effectiveUiScale));
  const dataTableFontSizeFollowsGlobal = appearance.dataTableFontSizeFollowGlobal !== false;
  const sqlEditorFontSizeFollowsGlobal = appearance.sqlEditorFontSizeFollowGlobal !== false;
  const sidebarTreeFontSizeFollowsGlobal = appearance.sidebarTreeFontSizeFollowGlobal !== false;
  const effectiveDataTableFontSize = dataTableFontSizeFollowsGlobal
      ? effectiveFontSize
      : (sanitizeDataTableFontSize(appearance.dataTableFontSize) ?? effectiveFontSize);
  const effectiveSqlEditorFontSize = resolveSqlEditorFontSize({
      globalFontSize: effectiveFontSize,
      sqlEditorFontSize: appearance.sqlEditorFontSize,
      sqlEditorFontSizeFollowGlobal: appearance.sqlEditorFontSizeFollowGlobal,
  });
  const effectiveSidebarTreeFontSize = sidebarTreeFontSizeFollowsGlobal
      ? effectiveFontSize
      : (sanitizeSidebarTreeFontSize(appearance.sidebarTreeFontSize) ?? effectiveFontSize);
  const effectiveSidebarRailScale = sanitizeV2SidebarRailScale(appearance.v2SidebarRailScale);
  const effectiveTabEnvironmentAccentThickness = sanitizeTabEnvironmentAccentThickness(
      appearance.tabEnvironmentAccentThickness,
  );
  const tableDoubleClickAction = appearance.tableDoubleClickAction === 'open-design' ? 'open-design' : 'open-data';
  const queryTableCtrlClickAction: QueryTableCtrlClickAction = appearance.queryTableCtrlClickAction === 'locate'
      ? 'locate'
      : 'open-design';
  const newQuerySqlTemplate = appearance.newQuerySqlTemplate ?? DEFAULT_QUERY_TEMPLATE;
  const sidebarTableMetadataFieldOrder = useMemo(
      () => resolveSidebarTableMetadataFieldOrder(queryOptions?.sidebarTableMetadataFieldOrder),
      [queryOptions?.sidebarTableMetadataFieldOrder],
  );
  const sidebarTableMetadataFields = useMemo(
      () => resolveSidebarTableMetadataFields(
          queryOptions?.sidebarTableMetadataFields,
          queryOptions?.showSidebarTableComment === true,
          sidebarTableMetadataFieldOrder,
      ),
      [queryOptions?.showSidebarTableComment, queryOptions?.sidebarTableMetadataFields, sidebarTableMetadataFieldOrder],
  );
  const sidebarMetadataDragSensors = useSensors(
      useSensor(PointerSensor, {
          activationConstraint: { distance: 4 },
      }),
  );
  const tabDisplaySettings = useMemo(
      () => sanitizeTabDisplaySettings(appearance.tabDisplay),
      [appearance.tabDisplay],
  );
  const tabDisplayElementOrder = useMemo(
      () => resolveTabDisplayElementOrder(tabDisplaySettings),
      [tabDisplaySettings],
  );
  const visibleTabDisplayElementKeys = useMemo(
      () => new Set<TabDisplayElementKey>([
          ...tabDisplaySettings.primaryElements,
          ...tabDisplaySettings.secondaryElements,
      ]),
      [tabDisplaySettings],
  );
  const getTabDisplayElementLabel = useCallback(
      (key: TabDisplayElementKey) => t(TAB_DISPLAY_ELEMENT_META[key].labelKey),
      [t],
  );
  const getTabDisplayElementDescription = useCallback(
      (key: TabDisplayElementKey) => t(TAB_DISPLAY_ELEMENT_META[key].descriptionKey),
      [t],
  );
  useEffect(() => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
          return;
      }
      const mediaQueryList = window.matchMedia('(prefers-color-scheme: dark)');
      const applySystemTheme = (matches: boolean) => {
          setSystemThemeMode(matches ? 'dark' : 'light');
      };
      applySystemTheme(mediaQueryList.matches);
      const handleChange = (event: MediaQueryListEvent) => {
          applySystemTheme(event.matches);
      };
      if (typeof mediaQueryList.addEventListener === 'function') {
          mediaQueryList.addEventListener('change', handleChange);
          return () => {
              mediaQueryList.removeEventListener('change', handleChange);
          };
      }
      mediaQueryList.addListener(handleChange);
      return () => {
          mediaQueryList.removeListener(handleChange);
      };
  }, []);
  useEffect(() => {
      if (themeMode !== resolvedThemeMode) {
          setTheme(resolvedThemeMode);
      }
      if (effectiveThemePreference === 'system') {
          void safeWindowRuntimeCall(() => WindowSetSystemDefaultTheme(), undefined);
          return;
      }
      if (resolvedThemeMode === 'dark') {
          void safeWindowRuntimeCall(() => WindowSetDarkTheme(), undefined);
          return;
      }
      void safeWindowRuntimeCall(() => WindowSetLightTheme(), undefined);
  }, [effectiveThemePreference, resolvedThemeMode, setTheme, themeMode]);

  const selectPresetTheme = useCallback((preference: ThemePreference) => {
      suppressThemeSwitchTransitions();
      // 亮 / 暗各自恢复上次应用的主题（无记忆则回到基础主题）；跟随系统始终回到基础主题。
      const result = activateRememberedCustomTheme(preference);
      if (!result.ok) message.warning(t('app.theme.custom.error.storage_failed'));
      setThemePreference(preference);
      // 与偏好同批提交解析后的明暗，避免再由 effect 触发第二轮整树渲染。
      setTheme(preference === 'system' ? systemThemeMode : preference);
  }, [activateRememberedCustomTheme, setTheme, setThemePreference, systemThemeMode, t]);
  const setTabDisplaySettings = useCallback((settings: Partial<TabDisplaySettings>) => {
      setAppearance({
          tabDisplay: applyTabDisplaySettingsPatch(tabDisplaySettings, settings),
      });
  }, [setAppearance, tabDisplaySettings]);
  const setTabDisplayLayout = useCallback((layout: TabDisplayLayout) => {
      if (layout === tabDisplaySettings.layout) return;
      setAppearance({
          tabDisplay: switchTabDisplayLayout(tabDisplaySettings, layout),
      });
  }, [setAppearance, tabDisplaySettings]);
  const updateTabDisplayElementVisibility = useCallback((key: TabDisplayElementKey, checked: boolean) => {
      setFocusedTabDisplayElementKey(key);
      const removeKey = (keys: TabDisplayElementKey[]) => keys.filter((item) => item !== key);
      if (!checked) {
          setTabDisplaySettings({
              layout: tabDisplaySettings.layout,
              primaryElements: removeKey(tabDisplaySettings.primaryElements),
              secondaryElements: removeKey(tabDisplaySettings.secondaryElements),
          });
          return;
      }

      const primaryElements = removeKey(tabDisplaySettings.primaryElements);
      const secondaryElements = removeKey(tabDisplaySettings.secondaryElements);
      if (tabDisplaySettings.layout === 'double' && TAB_DISPLAY_SECONDARY_DEFAULT_KEYS.includes(key)) {
          secondaryElements.push(key);
      } else {
          primaryElements.push(key);
      }
      setTabDisplaySettings({
          layout: tabDisplaySettings.layout,
          primaryElements,
          secondaryElements,
      });
  }, [setTabDisplaySettings, tabDisplaySettings]);
  const moveTabDisplayElement = useCallback((key: TabDisplayElementKey, offset: -1 | 1) => {
      setFocusedTabDisplayElementKey(key);
      const moveWithin = (keys: TabDisplayElementKey[]) => {
          const index = keys.indexOf(key);
          if (index < 0) return keys;
          const nextIndex = index + offset;
          if (nextIndex < 0 || nextIndex >= keys.length) return keys;
          const next = [...keys];
          [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
          return next;
      };

      setTabDisplaySettings({
          layout: tabDisplaySettings.layout,
          primaryElements: moveWithin(tabDisplaySettings.primaryElements),
          secondaryElements: moveWithin(tabDisplaySettings.secondaryElements),
      });
  }, [setTabDisplaySettings, tabDisplaySettings]);
  const setTabDisplayElementRow = useCallback((key: TabDisplayElementKey, row: 'primary' | 'secondary') => {
      setFocusedTabDisplayElementKey(key);
      const primaryElements = tabDisplaySettings.primaryElements.filter((item) => item !== key);
      const secondaryElements = tabDisplaySettings.secondaryElements.filter((item) => item !== key);
      if (row === 'primary') {
          primaryElements.push(key);
      } else {
          secondaryElements.push(key);
      }
      setTabDisplaySettings({
          layout: tabDisplaySettings.layout,
          primaryElements,
          secondaryElements,
      });
  }, [setTabDisplaySettings, tabDisplaySettings]);
  return {
    language, t, notificationApi, notificationContextHolder, isModalOpen, setIsModalOpen,
    isConnectionModalMounted, setIsConnectionModalMounted, editingConnection, setEditingConnection,
    connectionHealthTargetIds, setConnectionHealthTargetIds, pendingConnectionTagIdRef,
    connectionModalWarmupDoneRef, windowState, themeMode, appearance, setAppearance, setUiScale,
    setFontSize, startupMaximised, setStartupMaximised, autoCheckForUpdates, setAutoCheckForUpdates,
    autoCheckForUpdatesIntervalMinutes, setAutoCheckForUpdatesIntervalMinutes, globalProxy,
    replaceConnections, replaceConnectionSidebarLayout, replaceGlobalProxy, replaceSavedQueries,
    reloadSavedQueryGroups, setQueryOptions, shortcutOptions, updateShortcut, resetShortcutOptions,
    runtimePlatform, setRuntimePlatform, runtimeBuildType, setRuntimeBuildType, isLinuxRuntime,
    setIsLinuxRuntime, effectiveThemePreference, darkMode, setComputedCustomThemeAntTokens,
    customThemeStyleContextKey, customThemeAntTokens, effectiveUiScale, effectiveFontSize,
    tokenFontSize, titleBarToggleIconKey, tokenFontSizeSM, tokenFontSizeLG, tokenControlHeight,
    tokenControlHeightSM, tokenControlHeightLG, dataTableFontSizeFollowsGlobal,
    sqlEditorFontSizeFollowsGlobal, sidebarTreeFontSizeFollowsGlobal, effectiveDataTableFontSize,
    effectiveSqlEditorFontSize, effectiveSidebarTreeFontSize, effectiveSidebarRailScale,
    effectiveTabEnvironmentAccentThickness, tableDoubleClickAction, queryTableCtrlClickAction,
    newQuerySqlTemplate, sidebarTableMetadataFieldOrder, sidebarTableMetadataFields,
    sidebarMetadataDragSensors, tabDisplaySettings, tabDisplayElementOrder,
    visibleTabDisplayElementKeys, getTabDisplayElementLabel, getTabDisplayElementDescription,
    selectPresetTheme, setTabDisplayLayout, updateTabDisplayElementVisibility,
    moveTabDisplayElement, setTabDisplayElementRow, brandIconId, handleBrandIconChange,
  };
};

export type AppCoreStateApi = ReturnType<typeof useAppCoreState>;
