import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { message } from 'antd';
import type { ToolCenterGroupKey } from '../settingsCenterPanes';
import {
  ShortcutAction,
  setGlobalShortcutCaptureActive,
  type ConflictInfo,
  SHORTCUT_ACTION_ORDER,
  resolveShortcutBinding,
  findReservedConflictsForAction,
  normalizeShortcutCombo,
} from '../../utils/shortcuts';
import type { CloseShortcutScope } from '../../utils/closeTabShortcut';
import { ListInstalledFontFamilies } from '../../../wailsjs/go/app/App';
import { sanitizeFontFamilyInput, type InstalledFontFamily } from '../../utils/fontFamilies';
import { EMPTY_INSTALLED_FONT_FAMILIES } from '../appSettingsConstants';
import { GlobalProxyConfig } from '../../types';
import {
  createGlobalProxyComparableDraft,
  DEFAULT_GLOBAL_PROXY_TEST_URL,
  type GlobalProxyTestResultState,
  areGlobalProxyDraftsEqual,
  getGlobalProxyDefaultPort,
} from '../globalProxySettings';
import {
  clampAIPanelDockWidth,
  shouldOverlayAIPanel,
  shouldUseFullscreenAIPanelOverlay,
  resolveFullscreenAIPanelOverlayWidth,
  resolveOverlayAIPanelWidth,
} from '../../utils/aiPanelLayout';
import { toSaveGlobalProxyInput } from '../../utils/globalProxyDraft';
import type { AppShellStateApi } from './useAppShellState';
import type { AppCoreStateApi } from './useAppCoreState';
import type { AppUpdateAndDiagnosticsApi } from './useAppUpdateAndDiagnostics';
import type { ThemeSettingsSection } from '../settingsCenterNavigation';

export interface UseAppProxySettingsInput {
  activeSettingsCenterPane: AppShellStateApi['activeSettingsCenterPane'];
  runtimePlatform: AppCoreStateApi['runtimePlatform'];
  hasLoadedInstalledFontsRef: AppShellStateApi['hasLoadedInstalledFontsRef'];
  isFontFamiliesLoading: AppShellStateApi['isFontFamiliesLoading'];
  setIsFontFamiliesLoading: AppShellStateApi['setIsFontFamiliesLoading'];
  setFontFamiliesLoadError: AppShellStateApi['setFontFamiliesLoadError'];
  t: AppCoreStateApi['t'];
  setInstalledFontFamilies: AppShellStateApi['setInstalledFontFamilies'];
  shortcutOptions: AppCoreStateApi['shortcutOptions'];
  activeShortcutPlatform: AppUpdateAndDiagnosticsApi['activeShortcutPlatform'];
  language: AppCoreStateApi['language'];
  globalProxy: AppCoreStateApi['globalProxy'];
  aiPanelWidth: AppShellStateApi['aiPanelWidth'];
  viewportWidth: AppShellStateApi['viewportWidth'];
  aiPanelVisible: AppShellStateApi['aiPanelVisible'];
  renderedSidebarWidth: AppShellStateApi['renderedSidebarWidth'];
  replaceGlobalProxy: AppCoreStateApi['replaceGlobalProxy'];
}

export const useAppProxySettings = ({
  activeSettingsCenterPane, runtimePlatform, hasLoadedInstalledFontsRef, isFontFamiliesLoading,
  setIsFontFamiliesLoading, setFontFamiliesLoadError, t, setInstalledFontFamilies, shortcutOptions,
  activeShortcutPlatform, language, globalProxy, aiPanelWidth, viewportWidth, aiPanelVisible,
  renderedSidebarWidth, replaceGlobalProxy,
}: UseAppProxySettingsInput) => {
  const [toolCenterBackGroupKey, setToolCenterBackGroupKey] = useState<ToolCenterGroupKey | null>(null);
  const [isThemeModalOpen, setIsThemeModalOpen] = useState(false);
  const THEME_SETTINGS_SECTION_STORAGE_KEY = 'gonavi.themeSettingsSection';
  const sanitizeThemeSettingsSection = useCallback((value: unknown): ThemeSettingsSection => {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized === 'appearance' || normalized === 'workspace') {
          return normalized;
      }
      return 'theme';
  }, []);
  const [themeModalSection, setThemeModalSection] = useState<ThemeSettingsSection>(() => {
      try {
          return sanitizeThemeSettingsSection(window.localStorage.getItem(THEME_SETTINGS_SECTION_STORAGE_KEY));
      } catch {
          return 'theme';
      }
  });
  useEffect(() => {
      try {
          window.localStorage.setItem(THEME_SETTINGS_SECTION_STORAGE_KEY, themeModalSection);
      } catch {
          // ignore persistence failures
      }
  }, [themeModalSection]);
  const [isLinuxCJKFontBannerDismissed, setIsLinuxCJKFontBannerDismissed] = useState(false);
  const [isAppearanceModalOpen, setIsAppearanceModalOpen] = useState(false);
  const [capturingShortcutAction, setCapturingShortcutAction] = useState<ShortcutAction | null>(null);
  const closeShortcutScopeRef = useRef<CloseShortcutScope>('workspace');
  const tabDisplaySettingsPanelRef = useRef<HTMLDivElement | null>(null);
  const [tabDisplaySettingsFocusRequest, setTabDisplaySettingsFocusRequest] = useState(0);
  const isThemeSettingsPaneOpen = activeSettingsCenterPane?.key === 'theme';
  useEffect(() => {
      setGlobalShortcutCaptureActive(Boolean(capturingShortcutAction));
      return () => setGlobalShortcutCaptureActive(false);
  }, [capturingShortcutAction]);
  useEffect(() => {
      const shouldLoadInstalledFonts =
          runtimePlatform === 'linux' || ((isThemeModalOpen || isThemeSettingsPaneOpen) && themeModalSection === 'appearance');
      if (!shouldLoadInstalledFonts) {
          return;
      }
      if (hasLoadedInstalledFontsRef.current || isFontFamiliesLoading) {
          return;
      }

      let cancelled = false;
      hasLoadedInstalledFontsRef.current = true;
      setIsFontFamiliesLoading(true);
      setFontFamiliesLoadError(null);

      ListInstalledFontFamilies()
          .then((result) => {
              if (cancelled) {
                  return;
              }
              if (!result?.success) {
                  throw new Error(String(result?.message || t('app.theme.font_family.load_failed')));
              }
              const nextFonts = Array.isArray(result?.data)
                  ? result.data
                      .map((item) => ({
                          family: sanitizeFontFamilyInput((item as InstalledFontFamily | Record<string, unknown>)?.family) || '',
                          path: typeof (item as InstalledFontFamily | Record<string, unknown>)?.path === 'string'
                              ? String((item as InstalledFontFamily | Record<string, unknown>).path)
                              : undefined,
                      }))
                      .filter((item) => item.family)
                  : EMPTY_INSTALLED_FONT_FAMILIES;
              setInstalledFontFamilies(nextFonts);
          })
          .catch((error) => {
              if (cancelled) {
                  return;
              }
              hasLoadedInstalledFontsRef.current = false;
              setFontFamiliesLoadError(String(error instanceof Error ? error.message : error || t('app.theme.font_family.load_failed')));
          })
          .finally(() => {
              if (!cancelled) {
                  setIsFontFamiliesLoading(false);
              }
          });

      return () => {
          cancelled = true;
      };
  }, [isThemeModalOpen, isThemeSettingsPaneOpen, runtimePlatform, t, themeModalSection]);

  useEffect(() => {
      if ((!isThemeModalOpen && !isThemeSettingsPaneOpen) || themeModalSection !== 'workspace' || tabDisplaySettingsFocusRequest === 0) {
          return;
      }
      const timer = window.setTimeout(() => {
          tabDisplaySettingsPanelRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }, 80);
      return () => window.clearTimeout(timer);
  }, [isThemeModalOpen, isThemeSettingsPaneOpen, themeModalSection, tabDisplaySettingsFocusRequest]);

  const shortcutConflictMap = useMemo(() => {
      const map: Partial<Record<ShortcutAction, ConflictInfo[]>> = {};
      for (const action of SHORTCUT_ACTION_ORDER) {
          const binding = resolveShortcutBinding(shortcutOptions, action, activeShortcutPlatform);
          if (!binding?.enabled || !binding.combo) continue;
          const conflicts = findReservedConflictsForAction(
              action,
              normalizeShortcutCombo(binding.combo),
              activeShortcutPlatform,
          );
          if (conflicts.length > 0) {
              map[action] = conflicts;
          }
      }
      return map;
  }, [activeShortcutPlatform, language, shortcutOptions]);
  const [isProxyModalOpen, setIsProxyModalOpen] = useState(false);
  const [proxyDraft, setProxyDraft] = useState<GlobalProxyConfig>(() => createGlobalProxyComparableDraft(globalProxy));
  const [proxyDraftClearPassword, setProxyDraftClearPassword] = useState(false);
  const [proxyApplying, setProxyApplying] = useState(false);
  const [proxyTestUrl, setProxyTestUrl] = useState(DEFAULT_GLOBAL_PROXY_TEST_URL);
  const [proxyTesting, setProxyTesting] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<GlobalProxyTestResultState | null>(null);
  const [isDataRootModalOpen, setIsDataRootModalOpen] = useState(false);
  const [dataRootInfo, setDataRootInfo] = useState<any>(null);
  const [selectedDataRootPath, setSelectedDataRootPath] = useState('');
  const [selectedLogDirectoryPath, setSelectedLogDirectoryPath] = useState('');
  const [selectedSavedQueryDirectoryPath, setSelectedSavedQueryDirectoryPath] = useState('');
  const [dataRootLoading, setDataRootLoading] = useState(false);
  const [dataRootApplying, setDataRootApplying] = useState(false);
  const [logDirectoryApplying, setLogDirectoryApplying] = useState(false);
  const [savedQueryDirectoryApplying, setSavedQueryDirectoryApplying] = useState(false);
  const directorySettingsApplying = dataRootApplying || logDirectoryApplying || savedQueryDirectoryApplying;

  // 拖拽后的宽度已持久化；窗口变窄时按当前视口再收一次，避免工作台被挤没。
  const aiPanelDockWidth = clampAIPanelDockWidth(aiPanelWidth, viewportWidth);
  const aiPanelOverlayActive = aiPanelVisible && shouldOverlayAIPanel({
      viewportWidth,
      sidebarWidth: renderedSidebarWidth,
      panelWidth: aiPanelDockWidth,
  });
  const aiPanelFullscreenOverlay = aiPanelOverlayActive && shouldUseFullscreenAIPanelOverlay(viewportWidth);
  const aiPanelRenderWidth = aiPanelFullscreenOverlay
      ? resolveFullscreenAIPanelOverlayWidth(viewportWidth)
      : aiPanelOverlayActive
          ? resolveOverlayAIPanelWidth({
          viewportWidth,
          sidebarWidth: renderedSidebarWidth,
          panelWidth: aiPanelDockWidth,
          })
          : aiPanelDockWidth;
  const appliedGlobalProxyDraft = useMemo(() => (
      createGlobalProxyComparableDraft(globalProxy)
  ), [
      globalProxy.enabled,
      globalProxy.type,
      globalProxy.host,
      globalProxy.port,
      globalProxy.user,
      globalProxy.password,
      globalProxy.hasPassword,
  ]);
  const proxyDraftHost = String(proxyDraft.host || '').trim();
  const proxyDraftUser = String(proxyDraft.user || '').trim();
  const proxyDraftPort = Number(proxyDraft.port);
  const proxyDraftPortValid = Number.isFinite(proxyDraftPort) && proxyDraftPort > 0 && proxyDraftPort <= 65535;
  const proxyDraftValid = !proxyDraft.enabled || (proxyDraftHost !== '' && proxyDraftPortValid);
  const proxyDraftDirty = proxyDraftClearPassword || !areGlobalProxyDraftsEqual(proxyDraft, appliedGlobalProxyDraft);
  const proxyPanelOpen = isProxyModalOpen || activeSettingsCenterPane?.key === 'proxy';
  const proxyPanelWasOpenRef = useRef(false);
  const proxyStatusTone = proxyDraft.enabled
      ? (proxyDraftValid ? 'success' : 'warning')
      : 'info';
  const proxyStatusTitle = proxyDraft.enabled
      ? (proxyDraftValid ? t('app.proxy.status.enabled') : t('app.proxy.status.incomplete'))
      : t('app.proxy.status.disabled');
  const proxyStatusDescription = proxyDraft.enabled && proxyDraftValid
      ? t('app.proxy.status.enabled_description', {
          type: proxyDraft.type.toUpperCase(),
          endpoint: `${proxyDraftHost}:${proxyDraftPort}`,
      })
      : (proxyDraft.enabled
          ? t('app.proxy.status.incomplete_description')
          : t('app.proxy.status.disabled_description'));
  const proxyPresetItems = useMemo(() => ([
      { key: 'clash-mixed', label: t('app.proxy.preset.clash_mixed'), type: 'socks5' as const, host: '127.0.0.1', port: 7890 },
      { key: 'socks5-local', label: t('app.proxy.preset.socks5_local'), type: 'socks5' as const, host: '127.0.0.1', port: 1080 },
      { key: 'http-local', label: t('app.proxy.preset.http_local'), type: 'http' as const, host: '127.0.0.1', port: 8080 },
  ]), [t]);
  const proxyTestPresetItems = useMemo(() => ([
      { key: 'github-api', label: t('app.proxy.test.preset.github_api'), url: 'https://api.github.com/' },
      { key: 'github-release', label: t('app.proxy.test.preset.github_release'), url: 'https://github.com/Syngnat/GoNavi/releases/latest' },
      { key: 'go-module-proxy', label: t('app.proxy.test.preset.go_module_proxy'), url: 'https://proxy.golang.org/' },
      { key: 'baidu', label: t('app.proxy.test.preset.baidu'), url: 'https://www.baidu.com/' },
  ]), [t]);
  const proxyTestUrlTrimmed = String(proxyTestUrl || '').trim();
  const proxyCanTest = proxyDraft.enabled && proxyDraftValid && proxyTestUrlTrimmed !== '' && !proxyTesting;
  useEffect(() => {
      if (!proxyPanelOpen) {
          proxyPanelWasOpenRef.current = false;
          return;
      }
      if (proxyPanelWasOpenRef.current) {
          return;
      }
      proxyPanelWasOpenRef.current = true;
      setProxyDraft(appliedGlobalProxyDraft);
      setProxyDraftClearPassword(false);
  }, [appliedGlobalProxyDraft, proxyPanelOpen]);
  useEffect(() => {
      setProxyTestResult(null);
  }, [
      proxyDraft.enabled,
      proxyDraft.type,
      proxyDraft.host,
      proxyDraft.port,
      proxyDraft.user,
      proxyDraft.password,
      proxyDraftClearPassword,
      proxyTestUrlTrimmed,
  ]);
  const resetProxyDraftToCurrent = useCallback(() => {
      setProxyDraft(appliedGlobalProxyDraft);
      setProxyDraftClearPassword(false);
  }, [appliedGlobalProxyDraft]);
  const updateProxyDraftType = useCallback((type: GlobalProxyConfig['type']) => {
      setProxyDraft((current) => {
          const currentPort = Number(current.port);
          const previousDefault = getGlobalProxyDefaultPort(current.type);
          const shouldSwitchPort = !Number.isFinite(currentPort) || currentPort === previousDefault;
          return {
              ...current,
              type,
              port: shouldSwitchPort ? getGlobalProxyDefaultPort(type) : current.port,
          };
      });
  }, []);
  const applyProxyPreset = useCallback((preset: { type: GlobalProxyConfig['type']; host: string; port: number }) => {
      setProxyDraft((current) => ({
          ...current,
          enabled: true,
          type: preset.type,
          host: preset.host,
          port: preset.port,
      }));
  }, []);
  const handleTestGlobalProxyDraft = useCallback(async () => {
      if (!proxyDraft.enabled) {
          void message.warning(t('app.proxy.test.message.enable_first'));
          return;
      }
      if (!proxyDraftValid) {
          void message.warning(t('app.proxy.message.invalid_enabled'));
          return;
      }
      if (proxyTestUrlTrimmed === '') {
          void message.warning(t('app.proxy.test.message.url_required'));
          return;
      }
      const backendApp = (window as any).go?.app?.App;
      if (typeof backendApp?.TestGlobalProxyConnection !== 'function') {
          void message.error(t('app.proxy.test.message.unavailable'));
          return;
      }
      setProxyTesting(true);
      try {
          const res = await backendApp.TestGlobalProxyConnection({
              proxy: toSaveGlobalProxyInput({
                  ...proxyDraft,
                  host: proxyDraftHost,
                  user: proxyDraftUser,
                  port: proxyDraftPortValid ? proxyDraftPort : getGlobalProxyDefaultPort(proxyDraft.type),
                  clearPassword: proxyDraftClearPassword,
              }),
              url: proxyTestUrlTrimmed,
              timeoutSeconds: 8,
          });
          const data = (res?.data || {}) as Partial<GlobalProxyTestResultState>;
          const statusCode = Number(data.statusCode);
          setProxyTestResult({
              success: res?.success === true,
              message: res?.message || t('common.unknown'),
              url: data.url || proxyTestUrlTrimmed,
              finalUrl: data.finalUrl,
              statusCode: Number.isFinite(statusCode) ? statusCode : undefined,
              durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
              viaProxy: data.viaProxy === true,
          });
      } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err || t('common.unknown'));
          setProxyTestResult({
              success: false,
              message: errMsg,
              url: proxyTestUrlTrimmed,
          });
      } finally {
          setProxyTesting(false);
      }
  }, [
      proxyDraft,
      proxyDraftClearPassword,
      proxyDraftHost,
      proxyDraftPort,
      proxyDraftPortValid,
      proxyDraftUser,
      proxyDraftValid,
      proxyTestUrlTrimmed,
      t,
  ]);
  const handleApplyGlobalProxyDraft = useCallback(async () => {
      if (!proxyDraftValid) {
          void message.warning({
              content: t('app.proxy.message.invalid_enabled'),
              key: 'global-proxy-invalid',
          });
          return;
      }
      void message.destroy('global-proxy-invalid');
      const backendApp = (window as any).go?.app?.App;
      if (typeof backendApp?.SaveGlobalProxy !== 'function') {
          void message.error({
              content: t('app.proxy.message.save_failed', { error: t('common.unknown') }),
              key: 'global-proxy-sync-error',
          });
          return;
      }
      const saveInput = toSaveGlobalProxyInput({
          ...proxyDraft,
          host: proxyDraftHost,
          user: proxyDraftUser,
          port: proxyDraftPortValid ? proxyDraftPort : getGlobalProxyDefaultPort(proxyDraft.type),
          clearPassword: proxyDraftClearPassword,
      });
      setProxyApplying(true);
      try {
          const saved = await backendApp.SaveGlobalProxy(saveInput);
          const nextDraft = createGlobalProxyComparableDraft(saved || saveInput);
          replaceGlobalProxy(nextDraft);
          setProxyDraft(nextDraft);
          setProxyDraftClearPassword(false);
          void message.success({
              content: t('app.proxy.message.config_applied'),
              key: 'global-proxy-applied',
          });
      } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err || t('common.unknown'));
          void message.error({
              content: t('app.proxy.message.save_failed', { error: errMsg }),
              key: 'global-proxy-sync-error',
          });
      } finally {
          setProxyApplying(false);
      }
  }, [
      proxyDraft,
      proxyDraftClearPassword,
      proxyDraftHost,
      proxyDraftPort,
      proxyDraftPortValid,
      proxyDraftUser,
      proxyDraftValid,
      replaceGlobalProxy,
      t,
  ]);
  return {
    toolCenterBackGroupKey, setToolCenterBackGroupKey, isThemeModalOpen, setIsThemeModalOpen,
    themeModalSection, setThemeModalSection, isLinuxCJKFontBannerDismissed,
    setIsLinuxCJKFontBannerDismissed, capturingShortcutAction, setCapturingShortcutAction,
    closeShortcutScopeRef, tabDisplaySettingsPanelRef, setTabDisplaySettingsFocusRequest,
    shortcutConflictMap, isProxyModalOpen, setIsProxyModalOpen, proxyDraft, setProxyDraft,
    proxyDraftClearPassword, setProxyDraftClearPassword, proxyApplying, proxyTestUrl,
    setProxyTestUrl, proxyTesting, proxyTestResult, isDataRootModalOpen, setIsDataRootModalOpen,
    dataRootInfo, setDataRootInfo, selectedDataRootPath, setSelectedDataRootPath,
    selectedLogDirectoryPath, setSelectedLogDirectoryPath, selectedSavedQueryDirectoryPath,
    setSelectedSavedQueryDirectoryPath, dataRootLoading, setDataRootLoading, dataRootApplying,
    setDataRootApplying, logDirectoryApplying, setLogDirectoryApplying, savedQueryDirectoryApplying,
    setSavedQueryDirectoryApplying, directorySettingsApplying, aiPanelOverlayActive,
    aiPanelFullscreenOverlay, aiPanelRenderWidth, proxyDraftHost, proxyDraftPortValid,
    proxyDraftValid, proxyDraftDirty, proxyStatusTitle, proxyStatusDescription, proxyPresetItems,
    proxyTestPresetItems, proxyTestUrlTrimmed, proxyCanTest, resetProxyDraftToCurrent,
    updateProxyDraftType, applyProxyPreset, handleTestGlobalProxyDraft, handleApplyGlobalProxyDraft,
  };
};

export type AppProxySettingsApi = ReturnType<typeof useAppProxySettings>;
