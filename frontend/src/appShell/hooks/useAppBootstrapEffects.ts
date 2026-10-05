import { useEffect, useCallback } from 'react';
import { message } from 'antd';
import { SetWindowTranslucency } from '../../../wailsjs/go/app/App';
import { Environment } from '../../../wailsjs/runtime';
import {
  normalizeTitlebarRuntimePlatform,
  resolveDocumentPlatform,
} from '../../utils/titlebarLayout';
import { detectNavigatorPlatform, createEmptySecurityUpdateStatus } from '../appEnvironment';
import { useStore } from '../../store';
import { bootstrapSavedQueries } from '../../utils/savedQueryPersistence';
import { SecurityUpdateStatus } from '../../types';
import { resolveSecurityUpdateEntryVisibility } from '../../utils/securityUpdatePresentation';
import { withAISettingsLeaveGuard } from '../../utils/aiSettingsLeaveGuard';
import { resolveSecurityUpdateSettingsFocusTarget } from '../../utils/securityUpdateRepairFlow';
import type { ToolCenterGroupKey } from '../settingsCenterPanes';
import { bootstrapSecureConfig } from '../../utils/secureConfigBootstrap';
import {
  normalizeDownloadSource,
  DOWNLOAD_SOURCE_CHANGED_EVENT,
  type DownloadSourceId,
  notifyDownloadSourceChanged,
} from '../../utils/driverManagerTab';
import type { AppShellStateApi } from './useAppShellState';
import type { AppCoreStateApi } from './useAppCoreState';

export interface UseAppBootstrapEffectsInput {
  setViewportWidth: AppShellStateApi['setViewportWidth'];
  windowState: AppCoreStateApi['windowState'];
  windowCornerRadius: AppShellStateApi['windowCornerRadius'];
  resolvedAppearance: AppShellStateApi['resolvedAppearance'];
  darkMode: AppCoreStateApi['darkMode'];
  setRuntimePlatform: AppCoreStateApi['setRuntimePlatform'];
  setRuntimeBuildType: AppCoreStateApi['setRuntimeBuildType'];
  setIsLinuxRuntime: AppCoreStateApi['setIsLinuxRuntime'];
  isStoreHydrated: AppShellStateApi['isStoreHydrated'];
  setIsStoreHydrated: AppShellStateApi['setIsStoreHydrated'];
  savedQueriesLoadedRef: AppShellStateApi['savedQueriesLoadedRef'];
  savedQueriesBootstrapPromiseRef: AppShellStateApi['savedQueriesBootstrapPromiseRef'];
  replaceSavedQueries: AppCoreStateApi['replaceSavedQueries'];
  reloadSavedQueryGroups: AppCoreStateApi['reloadSavedQueryGroups'];
  setSecurityUpdateStatus: AppShellStateApi['setSecurityUpdateStatus'];
  setIsSecurityUpdateIntroOpen: AppShellStateApi['setIsSecurityUpdateIntroOpen'];
  setIsSecurityUpdateBannerDismissed: AppShellStateApi['setIsSecurityUpdateBannerDismissed'];
  aiSettingsLeaveGuardRef: AppShellStateApi['aiSettingsLeaveGuardRef'];
  setSecurityUpdateSettingsFocusTarget: AppShellStateApi['setSecurityUpdateSettingsFocusTarget'];
  setSecurityUpdateSettingsFocusRequest: AppShellStateApi['setSecurityUpdateSettingsFocusRequest'];
  setToolCenterBackGroupKey: React.Dispatch<React.SetStateAction<ToolCenterGroupKey | null>>;
  setActiveSettingsCenterGroupKey: AppShellStateApi['setActiveSettingsCenterGroupKey'];
  setActiveSettingsCenterPane: AppShellStateApi['setActiveSettingsCenterPane'];
  openSettingsCenterWorkbenchTab: AppShellStateApi['openSettingsCenterWorkbenchTab'];
  replaceConnections: AppCoreStateApi['replaceConnections'];
  replaceGlobalProxy: AppCoreStateApi['replaceGlobalProxy'];
  t: AppCoreStateApi['t'];
  setSecurityUpdateRawPayload: AppShellStateApi['setSecurityUpdateRawPayload'];
  setSecurityUpdateHasLegacySensitiveItems: AppShellStateApi['setSecurityUpdateHasLegacySensitiveItems'];
  setHasLoadedSecureConfig: AppShellStateApi['setHasLoadedSecureConfig'];
  setDownloadSource: AppShellStateApi['setDownloadSource'];
  downloadSource: AppShellStateApi['downloadSource'];
  setDownloadSourceSaving: AppShellStateApi['setDownloadSourceSaving'];
}

export const useAppBootstrapEffects = ({
  setViewportWidth, windowState, windowCornerRadius, resolvedAppearance, darkMode,
  setRuntimePlatform, setRuntimeBuildType, setIsLinuxRuntime, isStoreHydrated, setIsStoreHydrated,
  savedQueriesLoadedRef, savedQueriesBootstrapPromiseRef, replaceSavedQueries,
  reloadSavedQueryGroups, setSecurityUpdateStatus, setIsSecurityUpdateIntroOpen,
  setIsSecurityUpdateBannerDismissed, aiSettingsLeaveGuardRef, setSecurityUpdateSettingsFocusTarget,
  setSecurityUpdateSettingsFocusRequest, setToolCenterBackGroupKey, setActiveSettingsCenterGroupKey,
  setActiveSettingsCenterPane, openSettingsCenterWorkbenchTab, replaceConnections,
  replaceGlobalProxy, t, setSecurityUpdateRawPayload, setSecurityUpdateHasLegacySensitiveItems,
  setHasLoadedSecureConfig, setDownloadSource, downloadSource, setDownloadSourceSaving,
}: UseAppBootstrapEffectsInput) => {
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const syncViewportWidth = () => {
      setViewportWidth(window.innerWidth || document.documentElement?.clientWidth || 1280);
    };
    syncViewportWidth();
    window.addEventListener('resize', syncViewportWidth);
    return () => window.removeEventListener('resize', syncViewportWidth);
  }, []);

  useEffect(()=>{
    if (typeof document === 'undefined' || !document.body) {
        return;
    }
    switch(windowState){
        case 'fullscreen':
        case 'maximized':
            document.body.style.setProperty('--gonavi-border-radius', '0px');
            break;
        default:
            document.body.style.setProperty('--gonavi-border-radius', `${windowCornerRadius}px`);
            break;
    }
  }, [windowState]);

  // 同步 macOS 窗口透明度：opacity=1.0 且 blur=0 时关闭 NSVisualEffectView，
  // 避免 GPU 持续计算窗口背后的模糊合成
  useEffect(() => {
    try {
        void SetWindowTranslucency(resolvedAppearance.opacity, resolvedAppearance.blur, darkMode).catch(() => undefined);
    } catch(e) { /* ignore */ }
  }, [darkMode, resolvedAppearance.blur, resolvedAppearance.opacity]);

  useEffect(() => {
      let cancelled = false;
      try {
          Environment()
              .then((env) => {
                  if (cancelled) return;
                  const platform = normalizeTitlebarRuntimePlatform(String(env?.platform || ''));
                  setRuntimePlatform(platform);
                  setRuntimeBuildType(String(env?.buildType || '').trim().toLowerCase());
                  setIsLinuxRuntime(platform === 'linux');
              })
              .catch(() => {
                  if (cancelled) return;
                  const normalized = resolveDocumentPlatform('', detectNavigatorPlatform());
                  setRuntimePlatform(normalized);
                  setIsLinuxRuntime(normalized === 'linux');
              });
      } catch(e) {
          if (cancelled) return;
          const normalized = resolveDocumentPlatform('', detectNavigatorPlatform());
          setRuntimePlatform(normalized);
          setIsLinuxRuntime(normalized === 'linux');
      }
      return () => {
          cancelled = true;
      };
  }, []);

  useEffect(() => {
      if (isStoreHydrated) {
          return;
      }
      const unsubscribe = useStore.persist.onFinishHydration(() => {
          setIsStoreHydrated(true);
      });
      return () => {
          unsubscribe();
      };
  }, [isStoreHydrated]);

  const ensureSavedQueriesLoaded = useCallback(async (): Promise<void> => {
      if (savedQueriesLoadedRef.current) {
          return;
      }
      if (!savedQueriesBootstrapPromiseRef.current) {
          savedQueriesBootstrapPromiseRef.current = (async () => {
              await bootstrapSavedQueries({
                  backend: (window as any).go?.app?.App,
                  replaceSavedQueries,
              });
              savedQueriesLoadedRef.current = true;
              void reloadSavedQueryGroups().catch((error) => {
                  console.warn('Failed to reload saved query groups', error);
              });
          })();
      }
      const pending = savedQueriesBootstrapPromiseRef.current;
      try {
          await pending;
      } catch (error) {
          if (savedQueriesBootstrapPromiseRef.current === pending) {
              savedQueriesBootstrapPromiseRef.current = null;
          }
          throw error;
      }
  }, [reloadSavedQueryGroups, replaceSavedQueries]);

  useEffect(() => {
      if (!isStoreHydrated) {
          return;
      }
      void ensureSavedQueriesLoaded().catch((err) => {
          console.warn('Failed to bootstrap saved queries', err);
      });
  }, [ensureSavedQueriesLoaded, isStoreHydrated]);

  const normalizeSecurityUpdateStatus = useCallback((status?: Partial<SecurityUpdateStatus> | null): SecurityUpdateStatus => {
      const fallback = createEmptySecurityUpdateStatus();
      return {
          ...fallback,
          ...(status ?? {}),
          summary: {
              ...fallback.summary,
              ...(status?.summary ?? {}),
          },
          issues: Array.isArray(status?.issues) ? status.issues : [],
      };
  }, []);

  const applySecurityUpdateStatus = useCallback((
      status?: Partial<SecurityUpdateStatus> | null,
      options?: {
          openSettings?: boolean;
          refreshFocus?: boolean;
          resetBannerDismissed?: boolean;
      },
  ) => {
      const nextStatus = normalizeSecurityUpdateStatus(status);
      const visibility = resolveSecurityUpdateEntryVisibility(nextStatus);
      setSecurityUpdateStatus(nextStatus);
      setIsSecurityUpdateIntroOpen(visibility.showIntro);
      if (options?.resetBannerDismissed !== false) {
          setIsSecurityUpdateBannerDismissed(false);
      }
      if (options?.openSettings) {
          withAISettingsLeaveGuard(aiSettingsLeaveGuardRef.current, () => {
              if (options.refreshFocus !== false) {
                  setSecurityUpdateSettingsFocusTarget(resolveSecurityUpdateSettingsFocusTarget(nextStatus));
                  setSecurityUpdateSettingsFocusRequest((current) => current + 1);
              }
              setToolCenterBackGroupKey('config');
              setActiveSettingsCenterGroupKey('config');
              setActiveSettingsCenterPane({ key: 'security-update', group: 'config' });
              openSettingsCenterWorkbenchTab();
          });
      }
      return nextStatus;
  }, [normalizeSecurityUpdateStatus]);

  useEffect(() => {
      if (!isStoreHydrated) {
          return;
      }

      let cancelled = false;
      const loadSecureConfig = async () => {
          try {
              const result = await bootstrapSecureConfig({
                  backend: (window as any).go?.app?.App,
                  autoStartLegacySecurityUpdate: true,
                  replaceConnections,
                  replaceGlobalProxy,
                  t,
              });
              if (cancelled) {
                  return;
              }
              setSecurityUpdateRawPayload(result.rawPayload);
              setSecurityUpdateHasLegacySensitiveItems(result.hasLegacySensitiveItems);
              applySecurityUpdateStatus(result.status);
          } catch (err) {
              console.warn('Failed to bootstrap secure config', err);
          } finally {
              if (!cancelled) {
                  setHasLoadedSecureConfig(true);
              }
          }
      };

      void loadSecureConfig();
      return () => {
          cancelled = true;
      };
  }, [applySecurityUpdateStatus, isStoreHydrated, replaceConnections, replaceGlobalProxy, t]);

  useEffect(() => {
      let cancelled = false;
      const backendApp = (window as any).go?.app?.App;
      if (typeof backendApp?.GetDownloadSourceConfig !== 'function') {
          return () => {
              cancelled = true;
          };
      }
      void backendApp.GetDownloadSourceConfig()
          .then((result: { source?: string } | undefined) => {
              if (!cancelled) {
                  setDownloadSource(normalizeDownloadSource(result?.source));
              }
          })
          .catch((error: unknown) => {
              if (!cancelled) {
                  console.warn('Failed to load download source preference', error);
              }
          });
      return () => {
          cancelled = true;
      };
  }, []);

  useEffect(() => {
      const syncDownloadSource = (event: Event) => {
          setDownloadSource(normalizeDownloadSource((event as CustomEvent<{ source?: unknown }>).detail?.source));
      };
      window.addEventListener(DOWNLOAD_SOURCE_CHANGED_EVENT, syncDownloadSource);
      return () => window.removeEventListener(DOWNLOAD_SOURCE_CHANGED_EVENT, syncDownloadSource);
  }, []);

  const handleDownloadSourceChange = useCallback(async (value: DownloadSourceId) => {
      const nextSource = normalizeDownloadSource(value);
      const previousSource = downloadSource;
      setDownloadSource(nextSource);
      notifyDownloadSourceChanged(nextSource);
      const backendApp = (window as any).go?.app?.App;
      if (typeof backendApp?.SaveDownloadSourceConfig !== 'function') {
          return;
      }
      setDownloadSourceSaving(true);
      try {
          const result = await backendApp.SaveDownloadSourceConfig(nextSource);
          const savedSource = normalizeDownloadSource(result?.source ?? nextSource);
          setDownloadSource(savedSource);
          notifyDownloadSourceChanged(savedSource);
          void message.success(t('app.download_source.message.saved'));
      } catch (error: unknown) {
          setDownloadSource(previousSource);
          notifyDownloadSourceChanged(previousSource);
          void message.error(error instanceof Error ? error.message : t('app.download_source.message.save_failed'));
      } finally {
          setDownloadSourceSaving(false);
      }
  }, [downloadSource, t]);
  return {
    ensureSavedQueriesLoaded, normalizeSecurityUpdateStatus, applySecurityUpdateStatus,
    handleDownloadSourceChange,
  };
};

export type AppBootstrapEffectsApi = ReturnType<typeof useAppBootstrapEffects>;
