import React, { useState, useEffect } from 'react';
import { Layout, Button, ConfigProvider, theme, Dropdown, MenuProps, message, Modal, Spin, Slider, Progress, Switch, Input, InputNumber, Select } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { PlusOutlined, ConsoleSqlOutlined, UploadOutlined, DownloadOutlined, CloudDownloadOutlined, BugOutlined, ToolOutlined, GlobalOutlined, InfoCircleOutlined, GithubOutlined, SkinOutlined, CheckOutlined, MinusOutlined, BorderOutlined, CloseOutlined, SettingOutlined, LinkOutlined } from '@ant-design/icons';
import { BrowserOpenURL, Environment, EventsOn, Quit, WindowFullscreen, WindowIsFullscreen, WindowIsMaximised, WindowMaximise, WindowMinimise, WindowToggleMaximise } from '../wailsjs/runtime';
import Sidebar from './components/Sidebar';
import TabManager from './components/TabManager';
import ConnectionModal from './components/ConnectionModal';
import DataSyncModal from './components/DataSyncModal';
import DriverManagerModal from './components/DriverManagerModal';
import LogPanel from './components/LogPanel';
import { useStore } from './store';
import { SavedConnection } from './types';
import { blurToFilter, normalizeBlurForPlatform, normalizeOpacityForPlatform, isWindowsPlatform } from './utils/appearance';
import { ConfigureGlobalProxy, SetWindowTranslucency } from '../wailsjs/go/app/App';
import './App.css';

const { Sider, Content } = Layout;
const MIN_UI_SCALE = 0.8;
const MAX_UI_SCALE = 1.25;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 20;
const DEFAULT_UI_SCALE = 1.0;
const DEFAULT_FONT_SIZE = 14;

const detectNavigatorPlatform = (): string => {
  if (typeof navigator === 'undefined') {
      return '';
  }
  const uaDataPlatform = (navigator as Navigator & {
      userAgentData?: { platform?: string };
  }).userAgentData?.platform;
  if (uaDataPlatform) {
      return uaDataPlatform;
  }
  return navigator.userAgent || '';
};

function App() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [isDriverModalOpen, setIsDriverModalOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<SavedConnection | null>(null);
  const themeMode = useStore(state => state.theme);
  const setTheme = useStore(state => state.setTheme);
  const appearance = useStore(state => state.appearance);
  const setAppearance = useStore(state => state.setAppearance);
  const uiScale = useStore(state => state.uiScale);
  const setUiScale = useStore(state => state.setUiScale);
  const fontSize = useStore(state => state.fontSize);
  const setFontSize = useStore(state => state.setFontSize);
  const startupFullscreen = useStore(state => state.startupFullscreen);
  const setStartupFullscreen = useStore(state => state.setStartupFullscreen);
  const globalProxy = useStore(state => state.globalProxy);
  const setGlobalProxy = useStore(state => state.setGlobalProxy);
  const darkMode = themeMode === 'dark';
  const effectiveUiScale = Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, Number(uiScale) || DEFAULT_UI_SCALE));
  const effectiveFontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(Number(fontSize) || DEFAULT_FONT_SIZE)));
  const tokenFontSize = Math.round(effectiveFontSize * effectiveUiScale);
  const tokenFontSizeSM = Math.max(10, Math.round(tokenFontSize * 0.86));
  const tokenFontSizeLG = Math.max(tokenFontSize + 1, Math.round(tokenFontSize * 1.14));
  const tokenControlHeight = Math.max(24, Math.round(32 * effectiveUiScale));
  const tokenControlHeightSM = Math.max(20, Math.round(24 * effectiveUiScale));
  const tokenControlHeightLG = Math.max(30, Math.round(40 * effectiveUiScale));
  const appComponentSize: 'small' | 'middle' | 'large' = effectiveUiScale <= 0.92 ? 'small' : (effectiveUiScale >= 1.12 ? 'large' : 'middle');
  const titleBarHeight = Math.max(28, Math.round(32 * effectiveUiScale));
  const toolbarHeight = Math.max(32, Math.round(36 * effectiveUiScale));
  const titleBarButtonWidth = Math.max(40, Math.round(46 * effectiveUiScale));
  const floatingLogButtonHeight = Math.max(30, Math.round(34 * effectiveUiScale));
  const effectiveOpacity = normalizeOpacityForPlatform(appearance.opacity);
  const effectiveBlur = normalizeBlurForPlatform(appearance.blur);
  const blurFilter = blurToFilter(effectiveBlur);
  const windowCornerRadius = 14;
  const [runtimePlatform, setRuntimePlatform] = useState('');
  const [isLinuxRuntime, setIsLinuxRuntime] = useState(false);
  const [isStoreHydrated, setIsStoreHydrated] = useState(() => useStore.persist.hasHydrated());
  const globalProxyInvalidHintShownRef = React.useRef(false);

  // 同步 macOS 窗口透明度：opacity=1.0 且 blur=0 时关闭 NSVisualEffectView，
  // 避免 GPU 持续计算窗口背后的模糊合成
  useEffect(() => {
    void SetWindowTranslucency(appearance.opacity, appearance.blur).catch(() => undefined);
  }, [appearance.opacity, appearance.blur]);

  useEffect(() => {
      let cancelled = false;
      Environment()
          .then((env) => {
              if (cancelled) return;
              const platform = String(env?.platform || '').toLowerCase();
              setRuntimePlatform(platform);
              setIsLinuxRuntime(platform === 'linux');
          })
          .catch(() => {
              if (cancelled) return;
              const platform = detectNavigatorPlatform();
              const normalized = /linux/i.test(platform)
                  ? 'linux'
                  : (/mac/i.test(platform) ? 'darwin' : (/win/i.test(platform) ? 'windows' : ''));
              setRuntimePlatform(normalized);
              setIsLinuxRuntime(normalized === 'linux');
          });
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

  useEffect(() => {
      if (!isStoreHydrated) {
          return;
      }

      const host = String(globalProxy.host || '').trim();
      const port = Number(globalProxy.port);
      const portValid = Number.isFinite(port) && port > 0 && port <= 65535;
      const invalidWhenEnabled = globalProxy.enabled && (!host || !portValid);

      if (invalidWhenEnabled) {
          if (!globalProxyInvalidHintShownRef.current) {
              void message.warning({
                  content: '全局代理已开启，但地址或端口无效，当前按未启用处理',
                  key: 'global-proxy-invalid',
              });
              globalProxyInvalidHintShownRef.current = true;
          }
      } else {
          globalProxyInvalidHintShownRef.current = false;
          void message.destroy('global-proxy-invalid');
      }

      const enabledForBackend = globalProxy.enabled && !invalidWhenEnabled;
      let cancelled = false;
      ConfigureGlobalProxy(enabledForBackend, {
          type: globalProxy.type,
          host,
          port: portValid ? port : (globalProxy.type === 'http' ? 8080 : 1080),
          user: String(globalProxy.user || '').trim(),
          password: globalProxy.password || '',
      })
          .then((res) => {
              if (cancelled || res?.success) {
                  return;
              }
              void message.error({
                  content: '全局代理配置失败: ' + (res?.message || '未知错误'),
                  key: 'global-proxy-sync-error',
              });
          })
          .catch((err) => {
              if (cancelled) {
                  return;
              }
              const errMsg = err instanceof Error ? err.message : String(err || '未知错误');
              void message.error({
                  content: '全局代理配置失败: ' + errMsg,
                  key: 'global-proxy-sync-error',
              });
          });

      return () => {
          cancelled = true;
      };
  }, [
      isStoreHydrated,
      globalProxy.enabled,
      globalProxy.type,
      globalProxy.host,
      globalProxy.port,
      globalProxy.user,
      globalProxy.password,
  ]);

  useEffect(() => {
      let cancelled = false;
      let startupWindowTimer: number | null = null;
      const maxApplyAttempts = 6;
      const applyRetryDelayMs = 400;
      const settleDelayMs = 160;

      const checkStartupPreferenceApplied = async (): Promise<boolean> => {
          try {
              if (await WindowIsFullscreen()) {
                  return true;
              }
          } catch (_) {
              // ignore
          }
          try {
              if (await WindowIsMaximised()) {
                  return true;
              }
          } catch (_) {
              // ignore
          }
          return false;
      };

      const applyStartupWindowPreference = (attempt: number) => {
          if (startupWindowTimer !== null) {
              window.clearTimeout(startupWindowTimer);
          }
          startupWindowTimer = window.setTimeout(() => {
              if (cancelled) {
                  return;
              }
              if (!useStore.getState().startupFullscreen) {
                  return;
              }
              void Promise.resolve()
                  .then(async () => {
                      if (await checkStartupPreferenceApplied()) {
                          return;
                      }
                      // 优先尝试全屏，若当前平台/时机不生效，后续走最大化兜底。
                      await WindowFullscreen();
                      await new Promise((resolve) => window.setTimeout(resolve, settleDelayMs));
                      if (await checkStartupPreferenceApplied()) {
                          return;
                      }
                      await WindowMaximise();
                      await new Promise((resolve) => window.setTimeout(resolve, settleDelayMs));
                      if (await checkStartupPreferenceApplied()) {
                          return;
                      }
                      if (attempt < maxApplyAttempts) {
                          applyStartupWindowPreference(attempt + 1);
                      }
                  });
          }, applyRetryDelayMs);
      };

      if (useStore.persist.hasHydrated()) {
          applyStartupWindowPreference(1);
      }
      const unsubscribeHydration = useStore.persist.onFinishHydration(() => {
          if (cancelled) {
              return;
          }
          applyStartupWindowPreference(1);
      });

      return () => {
          cancelled = true;
          if (startupWindowTimer !== null) {
              window.clearTimeout(startupWindowTimer);
          }
          unsubscribeHydration();
      };
  }, []);

  // Background Helper
  const getBg = (darkHex: string) => {
      if (!darkMode) return `rgba(255, 255, 255, ${effectiveOpacity})`; // Light mode usually white
      
      // Parse hex to rgb
      const hex = darkHex.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${effectiveOpacity})`;
  };
  // Specific colors
  const bgMain = getBg('#141414');
  const bgContent = getBg('#1d1d1d');
  const floatingLogButtonBorderColor = darkMode ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.16)';
  const floatingLogButtonTextColor = darkMode ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.82)';
  const floatingLogButtonBgColor = darkMode
      ? `rgba(34, 34, 34, ${Math.max(effectiveOpacity, 0.82)})`
      : `rgba(255, 255, 255, ${Math.max(effectiveOpacity, 0.9)})`;
  const floatingLogButtonShadow = darkMode
      ? '0 8px 22px rgba(0,0,0,0.38)'
      : '0 8px 20px rgba(0,0,0,0.16)';
  
  const addTab = useStore(state => state.addTab);
  const activeContext = useStore(state => state.activeContext);
  const connections = useStore(state => state.connections);
  const addConnection = useStore(state => state.addConnection);
  const tabs = useStore(state => state.tabs);
  const activeTabId = useStore(state => state.activeTabId);
  const updateCheckInFlightRef = React.useRef(false);
  const updateDownloadInFlightRef = React.useRef(false);
  const updateDownloadedVersionRef = React.useRef<string | null>(null);
  const updateInstallTriggeredVersionRef = React.useRef<string | null>(null);
  const updateDownloadMetaRef = React.useRef<UpdateDownloadResultData | null>(null);
  const updateNotifiedVersionRef = React.useRef<string | null>(null);
  const updateMutedVersionRef = React.useRef<string | null>(null);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const isAboutOpenRef = React.useRef(false);
  const [aboutLoading, setAboutLoading] = useState(false);
  const [aboutInfo, setAboutInfo] = useState<{ version: string; author: string; buildTime?: string; repoUrl?: string; issueUrl?: string; releaseUrl?: string; communityUrl?: string } | null>(null);
  const [aboutUpdateStatus, setAboutUpdateStatus] = useState<string>('');
  const [lastUpdateInfo, setLastUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateDownloadProgress, setUpdateDownloadProgress] = useState<{
      open: boolean;
      version: string;
      status: 'idle' | 'start' | 'downloading' | 'done' | 'error';
      percent: number;
      downloaded: number;
      total: number;
      message: string;
  }>({
      open: false,
      version: '',
      status: 'idle',
      percent: 0,
      downloaded: 0,
      total: 0,
      message: ''
  });

  type UpdateInfo = {
      hasUpdate: boolean;
      currentVersion: string;
      latestVersion: string;
      releaseName?: string;
      releaseNotesUrl?: string;
      assetName?: string;
      assetUrl?: string;
      assetSize?: number;
      sha256?: string;
      downloaded?: boolean;
      downloadPath?: string;
  };

  type UpdateDownloadProgressEvent = {
      status?: 'start' | 'downloading' | 'done' | 'error';
      percent?: number;
      downloaded?: number;
      total?: number;
      message?: string;
  };

  type UpdateDownloadResultData = {
      info?: UpdateInfo;
      downloadPath?: string;
      installLogPath?: string;
      installTarget?: string;
      platform?: string;
      autoRelaunch?: boolean;
  };

  const isMacRuntime = runtimePlatform === 'darwin'
      || (runtimePlatform === '' && /mac/i.test(detectNavigatorPlatform()));

  const formatBytes = (bytes?: number) => {
      if (!bytes || bytes <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let value = bytes;
      let idx = 0;
      while (value >= 1024 && idx < units.length - 1) {
          value /= 1024;
          idx++;
      }
      return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
  };

  const downloadUpdate = React.useCallback(async (info: UpdateInfo, silent: boolean) => {
      if (updateDownloadInFlightRef.current) return;
      if (updateDownloadedVersionRef.current === info.latestVersion) {
          if (!silent) {
              const cachedDownloadPath = updateDownloadMetaRef.current?.downloadPath;
              void message.info(cachedDownloadPath ? `更新包已就绪（${info.latestVersion}），路径：${cachedDownloadPath}` : `更新包已就绪（${info.latestVersion}）`);
              showUpdateDownloadProgress();
          }
          return;
      }
      updateDownloadInFlightRef.current = true;
      updateDownloadMetaRef.current = null;
      setUpdateDownloadProgress({
          open: true,
          version: info.latestVersion,
          status: 'start',
          percent: 0,
          downloaded: 0,
          total: info.assetSize || 0,
          message: ''
      });
      const res = await (window as any).go.app.App.DownloadUpdate();
      updateDownloadInFlightRef.current = false;
      if (res?.success) {
          const resultData = (res?.data || {}) as UpdateDownloadResultData;
          updateDownloadMetaRef.current = resultData;
          updateDownloadedVersionRef.current = info.latestVersion;
          setUpdateDownloadProgress(prev => {
              const total = prev.total > 0 ? prev.total : (info.assetSize || 0);
              return { ...prev, status: 'done', percent: 100, downloaded: total, total, message: '', open: false };
          });
          setLastUpdateInfo((prev) => {
              if (!prev || prev.latestVersion !== info.latestVersion) {
                  return {
                      ...info,
                      downloaded: true,
                      downloadPath: resultData?.downloadPath || info.downloadPath,
                  };
              }
              return {
                  ...prev,
                  downloaded: true,
                  downloadPath: resultData?.downloadPath || prev.downloadPath || info.downloadPath,
              };
          });
          if (resultData?.downloadPath) {
              void message.success({ content: `更新下载完成，更新包路径：${resultData.downloadPath}`, duration: 5 });
          } else {
              void message.success({ content: '更新下载完成', duration: 2 });
          }
          setAboutUpdateStatus(`发现新版本 ${info.latestVersion}（已下载，请点击“下载进度”后安装）`);
      } else {
          setUpdateDownloadProgress(prev => ({
              ...prev,
              status: 'error',
              message: res?.message || '未知错误'
          }));
          void message.error({ content: '更新下载失败: ' + (res?.message || '未知错误'), duration: 4 });
      }
  }, []);

  const showUpdateDownloadProgress = React.useCallback(() => {
      setUpdateDownloadProgress((prev) => {
          if (prev.status === 'idle') return prev;
          return { ...prev, open: true };
      });
  }, []);

  const hideUpdateDownloadProgress = React.useCallback(() => {
      setUpdateDownloadProgress((prev) => ({ ...prev, open: false }));
  }, []);

  const isLatestUpdateDownloaded = Boolean(lastUpdateInfo?.hasUpdate) && (
      Boolean(lastUpdateInfo?.downloaded)
      || (Boolean(lastUpdateInfo?.latestVersion) && updateDownloadedVersionRef.current === lastUpdateInfo?.latestVersion)
  );
  const isBackgroundProgressForLatestUpdate = Boolean(lastUpdateInfo?.hasUpdate)
      && Boolean(lastUpdateInfo?.latestVersion)
      && updateDownloadProgress.version === lastUpdateInfo?.latestVersion
      && (updateDownloadProgress.status === 'start'
          || updateDownloadProgress.status === 'downloading'
          || updateDownloadProgress.status === 'error');
  const canShowProgressEntry = (isLatestUpdateDownloaded || isBackgroundProgressForLatestUpdate)
      && updateInstallTriggeredVersionRef.current !== (lastUpdateInfo?.latestVersion || null);

  const handleInstallFromProgress = React.useCallback(async () => {
      if (updateDownloadProgress.status !== 'done') {
          return;
      }
      if (isMacRuntime) {
          const res = await (window as any).go.app.App.OpenDownloadedUpdateDirectory();
          if (!res?.success) {
              void message.error('打开安装目录失败: ' + (res?.message || '未知错误'));
              return;
          }
          updateInstallTriggeredVersionRef.current = updateDownloadProgress.version || lastUpdateInfo?.latestVersion || null;
          hideUpdateDownloadProgress();
          void message.success(res?.message || '已打开安装目录，请手动完成替换');
          return;
      }
      const res = await (window as any).go.app.App.InstallUpdateAndRestart();
      if (!res?.success) {
          void message.error('更新安装失败: ' + (res?.message || '未知错误'));
          return;
      }
      updateInstallTriggeredVersionRef.current = updateDownloadProgress.version || lastUpdateInfo?.latestVersion || null;
      hideUpdateDownloadProgress();
  }, [hideUpdateDownloadProgress, isMacRuntime, lastUpdateInfo?.latestVersion, updateDownloadProgress.status, updateDownloadProgress.version]);

  const checkForUpdates = React.useCallback(async (silent: boolean) => {
      if (updateCheckInFlightRef.current) return;
      updateCheckInFlightRef.current = true;
      if (!silent) {
          setAboutUpdateStatus('正在检查更新...');
      }
      const res = await (window as any).go.app.App.CheckForUpdates();
      updateCheckInFlightRef.current = false;
      if (!res?.success) {
          if (!silent) {
              void message.error('检查更新失败: ' + (res?.message || '未知错误'));
              setAboutUpdateStatus('检查更新失败: ' + (res?.message || '未知错误'));
          }
          return;
      }
      const info: UpdateInfo = res.data;
      if (!info) return;
      const aboutOpen = isAboutOpenRef.current;
      if (info.hasUpdate) {
          const localDownloaded = updateDownloadedVersionRef.current === info.latestVersion;
          const hasDownloaded = Boolean(info.downloaded) || localDownloaded;
          if (hasDownloaded) {
              const downloadPath = info.downloadPath || updateDownloadMetaRef.current?.downloadPath || '';
              updateDownloadedVersionRef.current = info.latestVersion;
              updateDownloadMetaRef.current = {
                  ...(updateDownloadMetaRef.current || {}),
                  info,
                  downloadPath: downloadPath || undefined,
              };
              setUpdateDownloadProgress((prev) => {
                  if (prev.status === 'start' || prev.status === 'downloading') {
                      return prev;
                  }
                  const total = info.assetSize || prev.total || 0;
                  return {
                      ...prev,
                      open: prev.open && prev.version === info.latestVersion,
                      version: info.latestVersion,
                      status: 'done',
                      percent: 100,
                      downloaded: total,
                      total,
                      message: '',
                  };
              });
              setLastUpdateInfo({
                  ...info,
                  downloaded: true,
                  downloadPath: downloadPath || undefined,
              });
          } else {
              if (updateDownloadedVersionRef.current !== info.latestVersion) {
                  updateDownloadMetaRef.current = null;
              }
              setUpdateDownloadProgress((prev) => {
                  if (prev.status === 'start' || prev.status === 'downloading') {
                      return prev;
                  }
                  return {
                      ...prev,
                      open: false,
                      version: info.latestVersion,
                      status: 'idle',
                      percent: 0,
                      downloaded: 0,
                      total: info.assetSize || 0,
                      message: '',
                  };
              });
              setLastUpdateInfo(info);
          }
          const statusText = hasDownloaded
              ? `发现新版本 ${info.latestVersion}（已下载，请点击“下载进度”后安装）`
              : `发现新版本 ${info.latestVersion}（未下载）`;
          if (!silent) {
              void message.info(`发现新版本 ${info.latestVersion}`);
              setAboutUpdateStatus(statusText);
          }
          if (silent && aboutOpen) {
              setAboutUpdateStatus(statusText);
          }
          if (silent && !aboutOpen && updateMutedVersionRef.current !== info.latestVersion && updateNotifiedVersionRef.current !== info.latestVersion) {
              updateNotifiedVersionRef.current = info.latestVersion;
              setIsAboutOpen(true);
          }
      } else if (!silent) {
          setUpdateDownloadProgress((prev) => {
              if (prev.status === 'start' || prev.status === 'downloading') {
                  return prev;
              }
              return {
                  open: false,
                  version: '',
                  status: 'idle',
                  percent: 0,
                  downloaded: 0,
                  total: 0,
                  message: '',
              };
          });
          setLastUpdateInfo(info);
          const text = `当前已是最新版本（${info.currentVersion || '未知'}）`;
          void message.success(text);
          setAboutUpdateStatus(text);
      } else if (silent && aboutOpen) {
          setUpdateDownloadProgress((prev) => {
              if (prev.status === 'start' || prev.status === 'downloading') {
                  return prev;
              }
              return {
                  open: false,
                  version: '',
                  status: 'idle',
                  percent: 0,
                  downloaded: 0,
                  total: 0,
                  message: '',
              };
          });
          setLastUpdateInfo(info);
          const text = `当前已是最新版本（${info.currentVersion || '未知'}）`;
          setAboutUpdateStatus(text);
      } else {
          setLastUpdateInfo(info);
      }
  }, []);

  const loadAboutInfo = React.useCallback(async () => {
      setAboutLoading(true);
      const res = await (window as any).go.app.App.GetAppInfo();
      if (res?.success) {
          setAboutInfo(res.data);
      } else {
          void message.error('获取应用信息失败: ' + (res?.message || '未知错误'));
      }
      setAboutLoading(false);
  }, []);

  const handleNewQuery = () => {
      let connId = activeContext?.connectionId || '';
      let db = activeContext?.dbName || '';

      // Priority: Active Tab Context > Sidebar Selection
      if (activeTabId) {
          const currentTab = tabs.find(t => t.id === activeTabId);
          if (currentTab && currentTab.connectionId) {
              connId = currentTab.connectionId;
              db = currentTab.dbName || '';
          }
      }

      addTab({
          id: `query-${Date.now()}`,
          title: '新建查询',
          type: 'query',
          connectionId: connId,
          dbName: db,
          query: ''
      });
  };

  const handleImportConnections = async () => {
      const res = await (window as any).go.app.App.ImportConfigFile();
      if (res.success) {
          try {
              const imported = JSON.parse(res.data);
              if (Array.isArray(imported)) {
                  let count = 0;
                  imported.forEach((conn: any) => {
                      if (!connections.some(c => c.id === conn.id)) {
                          addConnection(conn);
                          count++;
                      }
                  });
                  void message.success(`成功导入 ${count} 个连接`);
              } else {
                  void message.error("文件格式错误：需要 JSON 数组");
              }
          } catch (e) {
              void message.error("解析 JSON 失败");
          }
      } else if (res.message !== "Cancelled") {
          void message.error("导入失败: " + res.message);
      }
  };

  const handleExportConnections = async () => {
      if (connections.length === 0) {
          void message.warning("没有连接可导出");
          return;
      }
      const res = await (window as any).go.app.App.ExportData(connections, ['id','name','config','includeDatabases','includeRedisDatabases'], "connections", "json");
      if (res.success) {
          void message.success("导出成功");
      } else if (res.message !== "Cancelled") {
          void message.error("导出失败: " + res.message);
      }
  };

  const toolsMenu: MenuProps['items'] = [
      {
          key: 'import',
          label: '导入连接配置',
          icon: <UploadOutlined />,
          onClick: handleImportConnections
      },
      {
          key: 'export',
          label: '导出连接配置',
          icon: <DownloadOutlined />,
          onClick: handleExportConnections
      },
      {
          key: 'sync',
          label: '数据同步',
          icon: <UploadOutlined rotate={90} />,
          onClick: () => setIsSyncModalOpen(true)
      },
      {
          key: 'drivers',
          label: '驱动管理',
          icon: <SettingOutlined />,
          onClick: () => setIsDriverModalOpen(true)
      }
  ];

  const themeMenu: MenuProps['items'] = [
      {
          key: 'light',
          label: '亮色主题',
          icon: themeMode === 'light' ? <CheckOutlined /> : undefined,
          onClick: () => setTheme('light')
      },
      {
          key: 'dark',
          label: '暗色主题',
          icon: themeMode === 'dark' ? <CheckOutlined /> : undefined,
          onClick: () => setTheme('dark')
      },
      { type: 'divider' },
      {
          key: 'settings',
          label: '外观设置...',
          icon: <SettingOutlined />,
          onClick: () => setIsAppearanceModalOpen(true)
      }
  ];

  const [isAppearanceModalOpen, setIsAppearanceModalOpen] = useState(false);
  const [isProxyModalOpen, setIsProxyModalOpen] = useState(false);


  // Log Panel: 最小高度按“工具栏 + 1 条日志行（微增）”限制
  const LOG_PANEL_TOOLBAR_HEIGHT = 32;
  const LOG_PANEL_SINGLE_ROW_HEIGHT = 39;
  const LOG_PANEL_MIN_VISIBLE_ROWS = 1;
  const LOG_PANEL_MIN_HEIGHT = LOG_PANEL_TOOLBAR_HEIGHT + (LOG_PANEL_SINGLE_ROW_HEIGHT * LOG_PANEL_MIN_VISIBLE_ROWS);
  const LOG_PANEL_MAX_HEIGHT = 800;
  const [logPanelHeight, setLogPanelHeight] = useState(Math.max(200, LOG_PANEL_MIN_HEIGHT));
  const [isLogPanelOpen, setIsLogPanelOpen] = useState(false);
  const logResizeRef = React.useRef<{ startY: number, startHeight: number } | null>(null);
  const logGhostRef = React.useRef<HTMLDivElement>(null);

  const handleLogResizeStart = (e: React.MouseEvent) => {
      e.preventDefault();
      logResizeRef.current = { startY: e.clientY, startHeight: logPanelHeight };
      
      if (logGhostRef.current) {
          logGhostRef.current.style.top = `${e.clientY}px`;
          logGhostRef.current.style.display = 'block';
      }

      document.addEventListener('mousemove', handleLogResizeMove);
      document.addEventListener('mouseup', handleLogResizeUp);
  };

  const handleLogResizeMove = (e: MouseEvent) => {
      if (!logResizeRef.current) return;
      // Just update ghost line, no state update
      if (logGhostRef.current) {
          logGhostRef.current.style.top = `${e.clientY}px`;
      }
  };

  const handleLogResizeUp = (e: MouseEvent) => {
      if (logResizeRef.current) {
          const delta = logResizeRef.current.startY - e.clientY; 
          const newHeight = Math.max(
              LOG_PANEL_MIN_HEIGHT,
              Math.min(LOG_PANEL_MAX_HEIGHT, logResizeRef.current.startHeight + delta)
          );
          setLogPanelHeight(newHeight);
      }
      
      if (logGhostRef.current) {
          logGhostRef.current.style.display = 'none';
      }

      logResizeRef.current = null;
      document.removeEventListener('mousemove', handleLogResizeMove);
      document.removeEventListener('mouseup', handleLogResizeUp);
  };
  
  const handleEditConnection = (conn: SavedConnection) => {
      setEditingConnection(conn);
      setIsModalOpen(true);
  };

  const handleCloseModal = () => {
      setIsModalOpen(false);
      setEditingConnection(null);
  };

  const handleOpenDriverManagerFromConnection = () => {
      setIsModalOpen(false);
      setEditingConnection(null);
      setIsDriverModalOpen(true);
  };

  const handleTitleBarDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-no-titlebar-toggle="true"]')) {
          return;
      }
      WindowToggleMaximise();
  };
  
  // Sidebar Resizing
  const [sidebarWidth, setSidebarWidth] = useState(330);
  const sidebarDragRef = React.useRef<{ startX: number, startWidth: number } | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const ghostRef = React.useRef<HTMLDivElement>(null);
  const latestMouseX = React.useRef<number>(0); // Store latest mouse position

  const handleSidebarMouseDown = (e: React.MouseEvent) => {
      e.preventDefault();
      
      if (ghostRef.current) {
          ghostRef.current.style.left = `${sidebarWidth}px`;
          ghostRef.current.style.display = 'block';
      }
      
      sidebarDragRef.current = { startX: e.clientX, startWidth: sidebarWidth };
      latestMouseX.current = e.clientX; // Init
      document.addEventListener('mousemove', handleSidebarMouseMove);
      document.addEventListener('mouseup', handleSidebarMouseUp);
  };

  const handleSidebarMouseMove = (e: MouseEvent) => {
      if (!sidebarDragRef.current) return;
      
      latestMouseX.current = e.clientX; // Always update latest pos

      if (rafRef.current) return; // Schedule once per frame

      rafRef.current = requestAnimationFrame(() => {
          if (!sidebarDragRef.current || !ghostRef.current) return;
          // Use latestMouseX.current instead of stale closure 'e.clientX'
          const delta = latestMouseX.current - sidebarDragRef.current.startX;
          const newWidth = Math.max(200, Math.min(600, sidebarDragRef.current.startWidth + delta));
          ghostRef.current.style.left = `${newWidth}px`;
          rafRef.current = null;
      });
  };

  const handleSidebarMouseUp = (e: MouseEvent) => {
      if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
      }
      
      if (sidebarDragRef.current) {
          // Use latest position for final commit too
          const delta = e.clientX - sidebarDragRef.current.startX;
          const newWidth = Math.max(200, Math.min(600, sidebarDragRef.current.startWidth + delta));
          setSidebarWidth(newWidth);
      }

      if (ghostRef.current) {
          ghostRef.current.style.display = 'none';
      }
      
      sidebarDragRef.current = null;
      document.removeEventListener('mousemove', handleSidebarMouseMove);
      document.removeEventListener('mouseup', handleSidebarMouseUp);
  };

  useEffect(() => {
    document.body.style.backgroundColor = 'transparent';
    document.body.style.color = darkMode ? '#ffffff' : '#000000';
    document.body.setAttribute('data-theme', darkMode ? 'dark' : 'light');
    document.body.style.fontSize = `${effectiveFontSize}px`;
    document.documentElement.style.setProperty('--gonavi-font-size', `${effectiveFontSize}px`);
  }, [darkMode, effectiveFontSize]);

  useEffect(() => {
      isAboutOpenRef.current = isAboutOpen;
  }, [isAboutOpen]);

  useEffect(() => {
      if (isAboutOpen) {
          if (lastUpdateInfo?.hasUpdate) {
              const localDownloaded = updateDownloadedVersionRef.current === lastUpdateInfo.latestVersion;
              const hasDownloaded = Boolean(lastUpdateInfo.downloaded) || localDownloaded;
              setAboutUpdateStatus(
                  hasDownloaded
                      ? `发现新版本 ${lastUpdateInfo.latestVersion}（已下载，请点击“下载进度”后安装）`
                      : `发现新版本 ${lastUpdateInfo.latestVersion}（未下载）`
              );
          } else if (lastUpdateInfo) {
              setAboutUpdateStatus(`当前已是最新版本（${lastUpdateInfo.currentVersion || '未知'}）`);
          } else {
              setAboutUpdateStatus('未检查');
          }
          void loadAboutInfo();
      }
  }, [isAboutOpen, lastUpdateInfo, loadAboutInfo]);

  useEffect(() => {
      const startupTimer = window.setTimeout(() => {
          void checkForUpdates(true);
      }, 2000);
      const interval = window.setInterval(() => {
          void checkForUpdates(true);
      }, 30 * 60 * 1000);
      return () => {
          window.clearTimeout(startupTimer);
          window.clearInterval(interval);
      };
  }, [checkForUpdates]);

  useEffect(() => {
      const offDownloadProgress = EventsOn('update:download-progress', (event: UpdateDownloadProgressEvent) => {
          if (!event) return;
          const status = event.status || 'downloading';
          const nextStatus: 'idle' | 'start' | 'downloading' | 'done' | 'error' =
              status === 'start' || status === 'downloading' || status === 'done' || status === 'error'
                  ? status
                  : 'downloading';
          const downloaded = typeof event.downloaded === 'number' ? event.downloaded : 0;
          const total = typeof event.total === 'number' ? event.total : 0;
          const percentRaw = typeof event.percent === 'number'
              ? event.percent
              : (total > 0 ? (downloaded / total) * 100 : 0);
          const percent = Math.max(0, Math.min(100, percentRaw));
          setUpdateDownloadProgress(prev => ({
              open: prev.open,
              version: prev.version,
              status: nextStatus,
              percent,
              downloaded,
              total,
              message: String(event.message || '')
          }));
      });
      return () => {
          offDownloadProgress();
      };
  }, []);

  const linuxResizeHandleStyleBase = {
      position: 'fixed',
      zIndex: 12000,
      background: 'transparent',
      WebkitAppRegion: 'drag',
      '--wails-draggable': 'drag',
      userSelect: 'none'
  } as any;

  const showLinuxResizeHandles = isLinuxRuntime;
  const resizeGuideColor = darkMode ? 'rgba(246, 196, 83, 0.55)' : 'rgba(24, 144, 255, 0.5)';

  return (
    <ConfigProvider
        locale={zhCN}
        componentSize={appComponentSize}
        theme={{
            algorithm: darkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
            token: {
                fontSize: tokenFontSize,
                fontSizeSM: tokenFontSizeSM,
                fontSizeLG: tokenFontSizeLG,
                controlHeight: tokenControlHeight,
                controlHeightSM: tokenControlHeightSM,
                controlHeightLG: tokenControlHeightLG,
                colorBgLayout: 'transparent',
                colorBgContainer: darkMode 
                    ? `rgba(29, 29, 29, ${effectiveOpacity})` 
                    : `rgba(255, 255, 255, ${effectiveOpacity})`,
                colorBgElevated: darkMode 
                    ? '#1f1f1f' 
                    : '#ffffff',
                colorFillAlter: darkMode
                    ? `rgba(38, 38, 38, ${effectiveOpacity})`
                    : `rgba(250, 250, 250, ${effectiveOpacity})`,
                colorPrimary: darkMode ? '#f6c453' : '#1677ff',
                colorPrimaryHover: darkMode ? '#ffd666' : '#4096ff',
                colorPrimaryActive: darkMode ? '#d8a93b' : '#0958d9',
                colorInfo: darkMode ? '#f6c453' : '#1677ff',
                colorLink: darkMode ? '#ffd666' : '#1677ff',
                colorLinkHover: darkMode ? '#ffe58f' : '#4096ff',
                colorLinkActive: darkMode ? '#d8a93b' : '#0958d9',
                colorPrimaryBg: darkMode ? 'rgba(246, 196, 83, 0.22)' : '#e6f4ff',
                colorPrimaryBgHover: darkMode ? 'rgba(246, 196, 83, 0.30)' : '#bae0ff',
                colorPrimaryBorder: darkMode ? 'rgba(246, 196, 83, 0.45)' : '#91caff',
                colorPrimaryBorderHover: darkMode ? 'rgba(246, 196, 83, 0.60)' : '#69b1ff',
                controlItemBgActive: darkMode ? 'rgba(246, 196, 83, 0.20)' : 'rgba(22, 119, 255, 0.12)',
                controlItemBgActiveHover: darkMode ? 'rgba(246, 196, 83, 0.28)' : 'rgba(22, 119, 255, 0.18)',
                controlOutline: darkMode ? 'rgba(246, 196, 83, 0.50)' : 'rgba(5, 145, 255, 0.24)',
            },
            components: {
                Layout: {
                    colorBgBody: 'transparent', 
                    colorBgHeader: 'transparent',
                    bodyBg: 'transparent',
                    headerBg: 'transparent',
                    siderBg: 'transparent',
                    triggerBg: 'transparent'
                },
                Table: {
                    headerBg: 'transparent',
                    rowHoverBg: darkMode ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.02)',
                },
                Tabs: {
                    cardBg: 'transparent',
                    itemActiveColor: darkMode ? '#ffd666' : '#1890ff',
                    itemHoverColor: darkMode ? '#ffe58f' : '#40a9ff',
                    itemSelectedColor: darkMode ? '#ffd666' : '#1677ff',
                    inkBarColor: darkMode ? '#ffd666' : '#1677ff',
                }
            }
        }}
    >
        <Layout style={{ 
            height: '100vh', 
            overflow: 'hidden', 
            display: 'flex', 
            flexDirection: 'column',
            background: 'transparent',
            borderRadius: showLinuxResizeHandles ? 0 : windowCornerRadius,
            clipPath: showLinuxResizeHandles ? 'none' : `inset(0 round ${windowCornerRadius}px)`,
            backdropFilter: blurFilter,
            WebkitBackdropFilter: blurFilter,
        }}>
          {/* Custom Title Bar */}
          <div
            onDoubleClick={handleTitleBarDoubleClick}
            style={{
                height: titleBarHeight,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: bgMain,
                borderBottom: 'none',
                userSelect: 'none',
                WebkitAppRegion: 'drag', // Wails drag region
                '--wails-draggable': 'drag',
                paddingLeft: Math.max(12, Math.round(16 * effectiveUiScale)),
                fontSize: tokenFontSize
            } as any}
          >
              <div style={{ display: 'flex', alignItems: 'center', gap: Math.max(6, Math.round(8 * effectiveUiScale)), fontWeight: 600 }}>
                  {/* Logo can be added here if available */}
                  GoNavi
              </div>
              <div
                data-no-titlebar-toggle="true"
                onDoubleClick={(e) => e.stopPropagation()}
                style={{ display: 'flex', height: '100%', WebkitAppRegion: 'no-drag', '--wails-draggable': 'no-drag' } as any}
              >
                  <Button 
                    type="text" 
                    icon={<MinusOutlined />} 
                    style={{ height: '100%', borderRadius: 0, width: titleBarButtonWidth }} 
                    onClick={WindowMinimise} 
                  />
                  <Button 
                    type="text" 
                    icon={<BorderOutlined />} 
                    style={{ height: '100%', borderRadius: 0, width: titleBarButtonWidth }} 
                    onClick={WindowToggleMaximise} 
                  />
                  <Button 
                    type="text" 
                    icon={<CloseOutlined />} 
                    danger
                    className="titlebar-close-btn"
                    style={{ height: '100%', borderRadius: 0, width: titleBarButtonWidth }} 
                    onClick={Quit} 
                  />
              </div>
          </div>

          <div
            style={{
                height: toolbarHeight,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-start',
                gap: Math.max(2, Math.round(4 * effectiveUiScale)),
                padding: `0 ${Math.max(6, Math.round(8 * effectiveUiScale))}px`,
                borderBottom: 'none',
                background: bgMain,
            }}
          >
            <Dropdown menu={{ items: toolsMenu }} placement="bottomLeft">
                <Button type="text" icon={<ToolOutlined />} title="工具">工具</Button>
            </Dropdown>
            <Button type="text" icon={<GlobalOutlined />} title="代理" onClick={() => setIsProxyModalOpen(true)}>代理</Button>
            <Dropdown menu={{ items: themeMenu }} placement="bottomLeft">
                <Button type="text" icon={<SkinOutlined />} title="主题">主题</Button>
            </Dropdown>
            <Button type="text" icon={<InfoCircleOutlined />} title="关于" onClick={() => setIsAboutOpen(true)}>关于</Button>
          </div>
          <Layout style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
          <Sider 
            width={sidebarWidth} 
            style={{ 
                borderRight: '1px solid rgba(128,128,128,0.2)',
                position: 'relative',
                background: bgMain
            }}
          >
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{ padding: '10px', borderBottom: 'none', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', flexShrink: 0 }}>
                
                <div>
                    <Button type="text" icon={<ConsoleSqlOutlined />} onClick={handleNewQuery} title="新建查询" />
                    <Button type="text" icon={<PlusOutlined />} onClick={() => setIsModalOpen(true)} title="新建连接" />
                </div>
            </div>
                
                <div style={{ flex: 1, overflow: 'hidden', paddingBottom: 58 }}>
                    <Sidebar onEditConnection={handleEditConnection} />
                </div>

                {/* Floating SQL Log Toggle */}
                <div
                    style={{
                        position: 'absolute',
                        left: 10,
                        right: 14,
                        bottom: 10,
                        zIndex: 20,
                        pointerEvents: 'none'
                    }}
                >
                    <Button
                        type={isLogPanelOpen ? "primary" : "text"}
                        icon={<BugOutlined />}
                        onClick={() => setIsLogPanelOpen(!isLogPanelOpen)}
                        style={isLogPanelOpen ? {
                            width: '100%',
                            height: floatingLogButtonHeight,
                            borderRadius: 999,
                            boxShadow: floatingLogButtonShadow,
                            pointerEvents: 'auto'
                        } : {
                            width: '100%',
                            height: floatingLogButtonHeight,
                            borderRadius: 999,
                            border: `1px solid ${floatingLogButtonBorderColor}`,
                            color: floatingLogButtonTextColor,
                            background: floatingLogButtonBgColor,
                            boxShadow: floatingLogButtonShadow,
                            backdropFilter: blurFilter,
                            pointerEvents: 'auto'
                        }}
                    >
                        SQL 执行日志
                    </Button>
                </div>
            </div>
            
            {/* Sidebar Resize Handle */}
            <div 
                onMouseDown={handleSidebarMouseDown}
                style={{
                    position: 'absolute',
                    right: 0,
                    top: 0,
                    bottom: 0,
                    width: '5px',
                    cursor: 'col-resize',
                    zIndex: 100,
                    // background: 'transparent' // transparent usually, visible on hover if desired
                }}
                title="拖动调整宽度"
            />
          </Sider>
           <Content style={{ background: 'transparent', overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
             <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: bgContent }}>
                 <TabManager />
             </div>
             {isLogPanelOpen && (
                 <LogPanel 
                    height={logPanelHeight} 
                    onClose={() => setIsLogPanelOpen(false)} 
                    onResizeStart={handleLogResizeStart} 
                />
            )}
          </Content>
          </Layout>
          <ConnectionModal 
            open={isModalOpen} 
            onClose={handleCloseModal} 
            initialValues={editingConnection}
            onOpenDriverManager={handleOpenDriverManagerFromConnection}
          />
          <DataSyncModal
            open={isSyncModalOpen}
            onClose={() => setIsSyncModalOpen(false)}
          />
          <DriverManagerModal
            open={isDriverModalOpen}
            onClose={() => setIsDriverModalOpen(false)}
            onOpenGlobalProxySettings={() => setIsProxyModalOpen(true)}
          />
          <Modal
            title="关于 GoNavi"
            open={isAboutOpen}
            onCancel={() => setIsAboutOpen(false)}
            footer={[
                canShowProgressEntry ? (
                    <Button key="progress" icon={<DownloadOutlined />} onClick={showUpdateDownloadProgress}>下载进度</Button>
                ) : null,
                lastUpdateInfo?.hasUpdate && !isLatestUpdateDownloaded ? (
                    <Button key="download" icon={<DownloadOutlined />} onClick={() => downloadUpdate(lastUpdateInfo, false)}>下载更新</Button>
                ) : null,
                lastUpdateInfo?.hasUpdate ? (
                    <Button key="mute" onClick={() => { updateMutedVersionRef.current = lastUpdateInfo.latestVersion; setIsAboutOpen(false); }}>本次不再提示</Button>
                ) : null,
                <Button key="check" icon={<CloudDownloadOutlined />} onClick={() => checkForUpdates(false)}>检查更新</Button>,
                <Button key="close" type="primary" onClick={() => setIsAboutOpen(false)}>关闭</Button>
            ].filter(Boolean)}
          >
            {aboutLoading ? (
                <div style={{ padding: '16px 0', textAlign: 'center' }}>
                    <Spin />
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div>版本：{aboutInfo?.version || '未知'}</div>
                    <div>作者：{aboutInfo?.author || '未知'}</div>
                    {aboutInfo?.communityUrl ? (
                        <div>技术圈：<a onClick={(e) => { e.preventDefault(); if (aboutInfo?.communityUrl) BrowserOpenURL(aboutInfo.communityUrl); }} href={aboutInfo.communityUrl}>AI全书</a></div>
                    ) : null}
                    <div>更新状态：{aboutUpdateStatus || '未检查'}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <GithubOutlined />
                        {aboutInfo?.repoUrl ? (
                        <a onClick={(e) => { e.preventDefault(); if (aboutInfo?.repoUrl) BrowserOpenURL(aboutInfo.repoUrl); }} href={aboutInfo.repoUrl}>
                            {aboutInfo.repoUrl}
                        </a>
                    ) : '未知'}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <BugOutlined />
                    {aboutInfo?.issueUrl ? (
                        <a onClick={(e) => { e.preventDefault(); if (aboutInfo?.issueUrl) BrowserOpenURL(aboutInfo.issueUrl); }} href={aboutInfo.issueUrl}>
                            {aboutInfo.issueUrl}
                        </a>
                    ) : '未知'}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <CloudDownloadOutlined />
                    {aboutInfo?.releaseUrl ? (
                        <a onClick={(e) => { e.preventDefault(); if (aboutInfo?.releaseUrl) BrowserOpenURL(aboutInfo.releaseUrl); }} href={aboutInfo.releaseUrl}>
                            {aboutInfo.releaseUrl}
                        </a>
                    ) : '未知'}
                </div>
            </div>
            )}
          </Modal>

          <Modal
              title="外观设置"
              open={isAppearanceModalOpen}
              onCancel={() => setIsAppearanceModalOpen(false)}
              footer={null}
              width={460}
          >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24, padding: '12px 0' }}>
                  <div>
                      <div style={{ marginBottom: 8, fontWeight: 500 }}>界面缩放 (UI Scale)</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                          <Slider
                            min={MIN_UI_SCALE}
                            max={MAX_UI_SCALE}
                            step={0.05}
                            value={effectiveUiScale}
                            onChange={(v) => setUiScale(Number(v))}
                            style={{ flex: 1 }}
                          />
                          <span style={{ width: 56 }}>{Math.round(effectiveUiScale * 100)}%</span>
                      </div>
                      <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
                          * 建议小屏设备设置为 85%-95%
                      </div>
                  </div>
                  <div>
                      <div style={{ marginBottom: 8, fontWeight: 500 }}>基础字体大小 (Font Size)</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                          <Slider
                            min={MIN_FONT_SIZE}
                            max={MAX_FONT_SIZE}
                            step={1}
                            value={effectiveFontSize}
                            onChange={(v) => setFontSize(Number(v))}
                            style={{ flex: 1 }}
                          />
                          <span style={{ width: 56 }}>{effectiveFontSize}px</span>
                      </div>
                  </div>
                  <div>
                      <div style={{ marginBottom: 8, fontWeight: 500 }}>背景不透明度 (Opacity)</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                          <Slider 
                            min={0.1} 
                            max={1.0} 
                            step={0.05} 
                            value={appearance.opacity ?? 1.0} 
                            onChange={(v) => setAppearance({ opacity: v })} 
                            style={{ flex: 1 }}
                          />
                          <span style={{ width: 40 }}>{Math.round((appearance.opacity ?? 1.0) * 100)}%</span>
                      </div>
                  </div>
                  <div>
                      <div style={{ marginBottom: 8, fontWeight: 500 }}>高斯模糊 (Blur)</div>
                      {isWindowsPlatform() ? (
                          <div style={{ fontSize: 12, color: '#888' }}>
                              Windows 使用系统 Acrylic 效果，模糊程度由系统控制
                          </div>
                      ) : (
                          <>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                                  <Slider
                                    min={0}
                                    max={20}
                                    value={appearance.blur ?? 0}
                                    onChange={(v) => setAppearance({ blur: v })}
                                    style={{ flex: 1 }}
                                  />
                                  <span style={{ width: 40 }}>{appearance.blur}px</span>
                              </div>
                              <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
                                  * 仅控制应用内覆盖层的模糊效果
                              </div>
                          </>
                      )}
                  </div>
                  <div>
                      <div style={{ marginBottom: 8, fontWeight: 500 }}>启动窗口</div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <span>启动时全屏</span>
                          <Switch checked={startupFullscreen} onChange={(checked) => setStartupFullscreen(checked)} />
                      </div>
                      <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
                          * 修改后下次启动生效
                      </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <Button
                          onClick={() => {
                              setUiScale(DEFAULT_UI_SCALE);
                              setFontSize(DEFAULT_FONT_SIZE);
                              setAppearance({ opacity: 1.0, blur: 0 });
                          }}
                      >
                          恢复默认
                      </Button>
                  </div>
              </div>
          </Modal>

          <Modal
              title="全局代理设置"
              open={isProxyModalOpen}
              onCancel={() => setIsProxyModalOpen(false)}
              footer={null}
              width={460}
          >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24, padding: '12px 0' }}>
                  <div>
                      <div style={{ marginBottom: 8, fontWeight: 500 }}>全局代理</div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <span>启用全局代理</span>
                          <Switch checked={globalProxy.enabled} onChange={(checked) => setGlobalProxy({ enabled: checked })} />
                      </div>
                      <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, opacity: globalProxy.enabled ? 1 : 0.7 }}>
                          <div>
                              <div style={{ marginBottom: 6, fontSize: 12, color: '#8c8c8c' }}>代理类型</div>
                              <Select
                                  value={globalProxy.type}
                                  disabled={!globalProxy.enabled}
                                  options={[
                                      { value: 'socks5', label: 'SOCKS5' },
                                      { value: 'http', label: 'HTTP' },
                                  ]}
                                  onChange={(value) => setGlobalProxy({ type: value as 'socks5' | 'http' })}
                              />
                          </div>
                          <div>
                              <div style={{ marginBottom: 6, fontSize: 12, color: '#8c8c8c' }}>端口</div>
                              <InputNumber
                                  min={1}
                                  max={65535}
                                  style={{ width: '100%' }}
                                  value={globalProxy.port}
                                  disabled={!globalProxy.enabled}
                                  onChange={(value) => setGlobalProxy({
                                      port: typeof value === 'number' ? value : (globalProxy.type === 'http' ? 8080 : 1080),
                                  })}
                              />
                          </div>
                          <div style={{ gridColumn: '1 / span 2' }}>
                              <div style={{ marginBottom: 6, fontSize: 12, color: '#8c8c8c' }}>代理地址</div>
                              <Input
                                  placeholder="例如：127.0.0.1"
                                  value={globalProxy.host}
                                  disabled={!globalProxy.enabled}
                                  onChange={(e) => setGlobalProxy({ host: e.target.value })}
                              />
                          </div>
                          <div>
                              <div style={{ marginBottom: 6, fontSize: 12, color: '#8c8c8c' }}>用户名（可选）</div>
                              <Input
                                  placeholder="proxy-user"
                                  value={globalProxy.user}
                                  disabled={!globalProxy.enabled}
                                  onChange={(e) => setGlobalProxy({ user: e.target.value })}
                              />
                          </div>
                          <div>
                              <div style={{ marginBottom: 6, fontSize: 12, color: '#8c8c8c' }}>密码（可选）</div>
                              <Input.Password
                                  placeholder="proxy-password"
                                  value={globalProxy.password}
                                  disabled={!globalProxy.enabled}
                                  onChange={(e) => setGlobalProxy({ password: e.target.value })}
                              />
                          </div>
                      </div>
                      <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>
                          * 作用于更新检查、驱动管理网络请求，以及未单独配置代理的数据库连接
                      </div>
                  </div>
              </div>
          </Modal>

          <Modal
              title={updateDownloadProgress.version ? `下载更新 ${updateDownloadProgress.version}` : '下载更新'}
              open={updateDownloadProgress.open}
              closable
              maskClosable
              keyboard
              onCancel={hideUpdateDownloadProgress}
              footer={updateDownloadProgress.status === 'start' || updateDownloadProgress.status === 'downloading' ? [
                  <Button
                      key="background"
                      onClick={hideUpdateDownloadProgress}
                  >
                      隐藏到后台
                  </Button>
              ] : (updateDownloadProgress.status === 'done' ? [
                  <Button key="close" onClick={hideUpdateDownloadProgress}>关闭</Button>,
                  <Button key="install" type="primary" onClick={handleInstallFromProgress}>
                      {isMacRuntime ? '打开安装目录' : '安装更新'}
                  </Button>
              ] : (updateDownloadProgress.status === 'error' ? [
                  <Button key="close" onClick={hideUpdateDownloadProgress}>关闭</Button>
              ] : null))}
          >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <Progress
                      percent={Math.round(updateDownloadProgress.percent)}
                      status={updateDownloadProgress.status === 'error' ? 'exception' : (updateDownloadProgress.status === 'done' ? 'success' : 'active')}
                  />
                  <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                      {`${formatBytes(updateDownloadProgress.downloaded)} / ${formatBytes(updateDownloadProgress.total)}`}
                  </div>
                  {updateDownloadProgress.message ? (
                      <div style={{ fontSize: 12, color: '#ff4d4f' }}>{updateDownloadProgress.message}</div>
                  ) : null}
              </div>
          </Modal>

          {showLinuxResizeHandles && (
              <>
                  {/* Linux Mint 下 frameless 仅局部可缩放：补四边四角命中层 */}
                  <div style={{ ...linuxResizeHandleStyleBase, top: 0, left: 14, right: 14, height: 6, cursor: 'ns-resize' }} />
                  <div style={{ ...linuxResizeHandleStyleBase, bottom: 0, left: 14, right: 14, height: 6, cursor: 'ns-resize' }} />
                  <div style={{ ...linuxResizeHandleStyleBase, top: 14, bottom: 14, left: 0, width: 6, cursor: 'ew-resize' }} />
                  <div style={{ ...linuxResizeHandleStyleBase, top: 14, bottom: 14, right: 0, width: 6, cursor: 'ew-resize' }} />

                  <div style={{ ...linuxResizeHandleStyleBase, top: 0, left: 0, width: 14, height: 14, cursor: 'nwse-resize' }} />
                  <div style={{ ...linuxResizeHandleStyleBase, top: 0, right: 0, width: 14, height: 14, cursor: 'nesw-resize' }} />
                  <div style={{ ...linuxResizeHandleStyleBase, bottom: 0, left: 0, width: 14, height: 14, cursor: 'nesw-resize' }} />
                  <div style={{ ...linuxResizeHandleStyleBase, bottom: 0, right: 0, width: 14, height: 14, cursor: 'nwse-resize' }} />
              </>
          )}
          
          {/* Ghost Resize Line for Sidebar */}
          <div 
              ref={ghostRef}
              style={{
                  position: 'fixed',
                  top: 0,
                  bottom: 0,
                  left: 0,
                  width: '4px',
                  background: resizeGuideColor,
                  zIndex: 9999,
                  pointerEvents: 'none',
                  display: 'none'
              }}
          />
          
          {/* Ghost Resize Line for Log Panel */}
          <div 
              ref={logGhostRef}
              style={{
                  position: 'fixed',
                  left: sidebarWidth, // Start from sidebar edge
                  right: 0,
                  height: '4px',
                  background: resizeGuideColor,
                  zIndex: 9999,
                  pointerEvents: 'none',
                  display: 'none',
                  cursor: 'row-resize'
              }}
          />
        </Layout>
    </ConfigProvider>
  );
}

export default App;
