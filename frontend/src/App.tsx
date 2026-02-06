import React, { useState, useEffect } from 'react';
import { Layout, Button, ConfigProvider, theme, Dropdown, MenuProps, message, Modal, Spin, Slider, Progress } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { PlusOutlined, BulbOutlined, BulbFilled, ConsoleSqlOutlined, UploadOutlined, DownloadOutlined, CloudDownloadOutlined, BugOutlined, ToolOutlined, InfoCircleOutlined, GithubOutlined, SkinOutlined, CheckOutlined, MinusOutlined, BorderOutlined, CloseOutlined, SettingOutlined } from '@ant-design/icons';
import { EventsOn } from '../wailsjs/runtime/runtime';
import Sidebar from './components/Sidebar';
import TabManager from './components/TabManager';
import ConnectionModal from './components/ConnectionModal';
import DataSyncModal from './components/DataSyncModal';
import LogPanel from './components/LogPanel';
import { useStore } from './store';
import { SavedConnection } from './types';
import { blurToFilter, normalizeBlurForPlatform, normalizeOpacityForPlatform } from './utils/appearance';
import './App.css';

const { Sider, Content } = Layout;

function App() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<SavedConnection | null>(null);
  const themeMode = useStore(state => state.theme);
  const setTheme = useStore(state => state.setTheme);
  const appearance = useStore(state => state.appearance);
  const setAppearance = useStore(state => state.setAppearance);
  const darkMode = themeMode === 'dark';
  const effectiveOpacity = normalizeOpacityForPlatform(appearance.opacity);
  const effectiveBlur = normalizeBlurForPlatform(appearance.blur);
  const blurFilter = blurToFilter(effectiveBlur);
  const windowCornerRadius = 14;

  // Background Helper
  const getBg = (darkHex: string, lightHex: string) => {
      if (!darkMode) return `rgba(255, 255, 255, ${effectiveOpacity})`; // Light mode usually white
      
      // Parse hex to rgb
      const hex = darkHex.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${effectiveOpacity})`;
  };
  // Specific colors
  const bgMain = getBg('#141414', '#ffffff');
  const bgContent = getBg('#1d1d1d', '#ffffff');
  
  const addTab = useStore(state => state.addTab);
  const activeContext = useStore(state => state.activeContext);
  const connections = useStore(state => state.connections);
  const addConnection = useStore(state => state.addConnection);
  const tabs = useStore(state => state.tabs);
  const activeTabId = useStore(state => state.activeTabId);
  const updateCheckInFlightRef = React.useRef(false);
  const updateDownloadInFlightRef = React.useRef(false);
  const updateDownloadedVersionRef = React.useRef<string | null>(null);
  const updateDownloadMetaRef = React.useRef<UpdateDownloadResultData | null>(null);
  const updateDeferredVersionRef = React.useRef<string | null>(null);
  const updateNotifiedVersionRef = React.useRef<string | null>(null);
  const updateMutedVersionRef = React.useRef<string | null>(null);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [aboutLoading, setAboutLoading] = useState(false);
  const [aboutInfo, setAboutInfo] = useState<{ version: string; author: string; buildTime?: string; repoUrl?: string; issueUrl?: string; releaseUrl?: string } | null>(null);
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

  const promptRestartForUpdate = (info: UpdateInfo, resultData?: UpdateDownloadResultData) => {
      const downloadPathHint = resultData?.downloadPath
          ? `更新包路径：${resultData.downloadPath}`
          : '';
      const installLogHint = resultData?.installLogPath
          ? `安装日志：${resultData.installLogPath}`
          : '';
      Modal.confirm({
          title: '更新已下载',
          content: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, userSelect: 'text' }}>
                  <div>{`版本 ${info.latestVersion} 已下载完成，是否现在重启完成更新？`}</div>
                  {downloadPathHint ? <div style={{ fontSize: 12, color: '#8c8c8c' }}>{downloadPathHint}</div> : null}
                  {installLogHint ? <div style={{ fontSize: 12, color: '#8c8c8c' }}>{installLogHint}</div> : null}
              </div>
          ),
          okText: '立即重启',
          cancelText: '稍后',
          onOk: async () => {
              updateDeferredVersionRef.current = null;
              const res = await (window as any).go.app.App.InstallUpdateAndRestart();
              if (!res?.success) {
                  message.error('更新安装失败: ' + (res?.message || '未知错误'));
              }
          },
          onCancel: () => {
              updateDeferredVersionRef.current = info.latestVersion;
          }
      });
  };

  const downloadUpdate = React.useCallback(async (info: UpdateInfo, silent: boolean) => {
      if (updateDownloadInFlightRef.current) return;
      if (updateDownloadedVersionRef.current === info.latestVersion) {
          if (!silent) {
              const cachedDownloadPath = updateDownloadMetaRef.current?.downloadPath;
              message.info(cachedDownloadPath ? `更新包已就绪（${info.latestVersion}），路径：${cachedDownloadPath}` : `更新包已就绪（${info.latestVersion}）`);
          }
          if (!silent || updateDeferredVersionRef.current !== info.latestVersion) {
              promptRestartForUpdate(info, updateDownloadMetaRef.current || undefined);
          }
          return;
      }
      updateDownloadInFlightRef.current = true;
      updateDownloadMetaRef.current = null;
      const key = 'update-download';
      setUpdateDownloadProgress({
          open: true,
          version: info.latestVersion,
          status: 'start',
          percent: 0,
          downloaded: 0,
          total: info.assetSize || 0,
          message: ''
      });
      message.loading({ content: `正在下载更新 ${info.latestVersion}...`, key, duration: 0 });
      const res = await (window as any).go.app.App.DownloadUpdate();
      updateDownloadInFlightRef.current = false;
      if (res?.success) {
          const resultData = (res?.data || {}) as UpdateDownloadResultData;
          updateDownloadMetaRef.current = resultData;
          updateDownloadedVersionRef.current = info.latestVersion;
          setUpdateDownloadProgress(prev => ({ ...prev, status: 'done', percent: 100, open: false }));
          if (resultData?.downloadPath) {
              message.success({ content: `更新下载完成，更新包路径：${resultData.downloadPath}`, key, duration: 5 });
          } else {
              message.success({ content: '更新下载完成', key, duration: 2 });
          }
          setAboutUpdateStatus(`发现新版本 ${info.latestVersion}（已下载，待重启安装）`);
          if (!silent || updateDeferredVersionRef.current !== info.latestVersion) {
              promptRestartForUpdate(info, resultData);
          }
      } else {
          setUpdateDownloadProgress(prev => ({
              ...prev,
              status: 'error',
              message: res?.message || '未知错误'
          }));
          message.error({ content: '更新下载失败: ' + (res?.message || '未知错误'), key, duration: 4 });
      }
  }, []);

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
              message.error('检查更新失败: ' + (res?.message || '未知错误'));
              setAboutUpdateStatus('检查更新失败: ' + (res?.message || '未知错误'));
          }
          return;
      }
      const info: UpdateInfo = res.data;
      if (!info) return;
      setLastUpdateInfo(info);
      if (info.hasUpdate) {
          if (!silent) {
              message.info(`发现新版本 ${info.latestVersion}`);
              setAboutUpdateStatus(`发现新版本 ${info.latestVersion}（未下载）`);
          }
          if (silent && isAboutOpen) {
              setAboutUpdateStatus(`发现新版本 ${info.latestVersion}（未下载）`);
          }
          if (silent && !isAboutOpen && updateMutedVersionRef.current !== info.latestVersion && updateNotifiedVersionRef.current !== info.latestVersion) {
              updateNotifiedVersionRef.current = info.latestVersion;
              setIsAboutOpen(true);
          }
      } else if (!silent) {
          const text = `当前已是最新版本（${info.currentVersion || '未知'}）`;
          message.success(text);
          setAboutUpdateStatus(text);
      } else if (silent && isAboutOpen) {
          const text = `当前已是最新版本（${info.currentVersion || '未知'}）`;
          setAboutUpdateStatus(text);
      }
  }, [downloadUpdate]);

  const loadAboutInfo = React.useCallback(async () => {
      setAboutLoading(true);
      const res = await (window as any).go.app.App.GetAppInfo();
      if (res?.success) {
          setAboutInfo(res.data);
      } else {
          message.error('获取应用信息失败: ' + (res?.message || '未知错误'));
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
                  message.success(`成功导入 ${count} 个连接`);
              } else {
                  message.error("文件格式错误：需要 JSON 数组");
              }
          } catch (e) {
              message.error("解析 JSON 失败");
          }
      } else if (res.message !== "Cancelled") {
          message.error("导入失败: " + res.message);
      }
  };

  const handleExportConnections = async () => {
      if (connections.length === 0) {
          message.warning("没有连接可导出");
          return;
      }
      const res = await (window as any).go.app.App.ExportData(connections, [], "connections", "json");
      if (res.success) {
          message.success("导出成功");
      } else if (res.message !== "Cancelled") {
          message.error("导出失败: " + res.message);
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


  // Log Panel
  const [logPanelHeight, setLogPanelHeight] = useState(200);
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
          const newHeight = Math.max(100, Math.min(800, logResizeRef.current.startHeight + delta));
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

  const handleTitleBarDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-no-titlebar-toggle="true"]')) {
          return;
      }
      (window as any).runtime.WindowToggleMaximise();
  };
  
  // Sidebar Resizing
  const [sidebarWidth, setSidebarWidth] = useState(300);
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
  }, [darkMode]);

  useEffect(() => {
      if (isAboutOpen) {
          if (lastUpdateInfo?.hasUpdate) {
              setAboutUpdateStatus(`发现新版本 ${lastUpdateInfo.latestVersion}（未下载）`);
          } else if (lastUpdateInfo) {
              setAboutUpdateStatus(`当前已是最新版本（${lastUpdateInfo.currentVersion || '未知'}）`);
          } else {
              setAboutUpdateStatus('未检查');
          }
          loadAboutInfo();
      }
  }, [isAboutOpen, lastUpdateInfo, loadAboutInfo]);

  useEffect(() => {
      const startupTimer = window.setTimeout(() => {
          checkForUpdates(true);
      }, 2000);
      const interval = window.setInterval(() => {
          checkForUpdates(true);
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
              open: nextStatus === 'start' || nextStatus === 'downloading' || nextStatus === 'error',
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

  return (
    <ConfigProvider
        locale={zhCN}
        theme={{
            algorithm: darkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
            token: {
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
                    itemActiveColor: darkMode ? '#177ddc' : '#1890ff',
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
            borderRadius: windowCornerRadius,
            clipPath: `inset(0 round ${windowCornerRadius}px)`,
            backdropFilter: blurFilter,
            WebkitBackdropFilter: blurFilter,
        }}>
          {/* Custom Title Bar */}
          <div
            onDoubleClick={handleTitleBarDoubleClick}
            style={{
                height: 32,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: bgMain,
                backdropFilter: blurFilter,
                WebkitBackdropFilter: blurFilter,
                borderBottom: 'none',
                userSelect: 'none',
                WebkitAppRegion: 'drag', // Wails drag region
                '--wails-draggable': 'drag',
                paddingLeft: 16
            } as any}
          >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
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
                    style={{ height: '100%', borderRadius: 0, width: 46 }} 
                    onClick={() => (window as any).runtime.WindowMinimise()} 
                  />
                  <Button 
                    type="text" 
                    icon={<BorderOutlined />} 
                    style={{ height: '100%', borderRadius: 0, width: 46 }} 
                    onClick={() => (window as any).runtime.WindowToggleMaximise()} 
                  />
                  <Button 
                    type="text" 
                    icon={<CloseOutlined />} 
                    danger
                    className="titlebar-close-btn"
                    style={{ height: '100%', borderRadius: 0, width: 46 }} 
                    onClick={() => (window as any).runtime.Quit()} 
                  />
              </div>
          </div>

          <div
            style={{
                height: 36,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-start',
                gap: 4,
                padding: '0 8px',
                borderBottom: 'none',
                background: bgMain,
                backdropFilter: blurFilter,
                WebkitBackdropFilter: blurFilter,
            }}
          >
            <Dropdown menu={{ items: toolsMenu }} placement="bottomLeft">
                <Button type="text" icon={<ToolOutlined />} title="工具">工具</Button>
            </Dropdown>
            <Dropdown menu={{ items: themeMenu }} placement="bottomLeft">
                <Button type="text" icon={<SkinOutlined />} title="主题">主题</Button>
            </Dropdown>
            <Button type="text" icon={<InfoCircleOutlined />} title="关于" onClick={() => setIsAboutOpen(true)}>关于</Button>
          </div>
          <Layout style={{ flex: 1, minHeight: 0 }}>
          <Sider 
            width={sidebarWidth} 
            style={{ 
                borderRight: 'none', 
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
                
                <div style={{ flex: 1, overflow: 'hidden' }}>
                    <Sidebar onEditConnection={handleEditConnection} />
                </div>

                {/* Sidebar Footer for Log Toggle */}
                <div style={{ padding: '8px', borderTop: 'none', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
                    <Button 
                        type={isLogPanelOpen ? "primary" : "text"}  
                        icon={<BugOutlined />} 
                        onClick={() => setIsLogPanelOpen(!isLogPanelOpen)}
                        block
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
           <Content style={{ background: 'transparent', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
             <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: bgContent, backdropFilter: blurFilter, WebkitBackdropFilter: blurFilter }}>
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
          />
          <DataSyncModal
            open={isSyncModalOpen}
            onClose={() => setIsSyncModalOpen(false)}
          />
          <Modal
            title="关于 GoNavi"
            open={isAboutOpen}
            onCancel={() => setIsAboutOpen(false)}
            footer={[
                lastUpdateInfo?.hasUpdate ? (
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
                    <div>更新状态：{aboutUpdateStatus || '未检查'}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <GithubOutlined />
                        {aboutInfo?.repoUrl ? (
                        <a onClick={(e) => { e.preventDefault(); (window as any).runtime.BrowserOpenURL(aboutInfo.repoUrl); }} href={aboutInfo.repoUrl}>
                            {aboutInfo.repoUrl}
                        </a>
                    ) : '未知'}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <BugOutlined />
                    {aboutInfo?.issueUrl ? (
                        <a onClick={(e) => { e.preventDefault(); (window as any).runtime.BrowserOpenURL(aboutInfo.issueUrl); }} href={aboutInfo.issueUrl}>
                            {aboutInfo.issueUrl}
                        </a>
                    ) : '未知'}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <CloudDownloadOutlined />
                    {aboutInfo?.releaseUrl ? (
                        <a onClick={(e) => { e.preventDefault(); (window as any).runtime.BrowserOpenURL(aboutInfo.releaseUrl); }} href={aboutInfo.releaseUrl}>
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
              width={400}
          >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24, padding: '12px 0' }}>
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
                  </div>
              </div>
          </Modal>

          <Modal
              title={updateDownloadProgress.version ? `下载更新 ${updateDownloadProgress.version}` : '下载更新'}
              open={updateDownloadProgress.open}
              closable={updateDownloadProgress.status === 'error'}
              maskClosable={false}
              keyboard={updateDownloadProgress.status === 'error'}
              onCancel={() => {
                  if (updateDownloadProgress.status === 'error') {
                      setUpdateDownloadProgress({
                          open: false,
                          version: '',
                          status: 'idle',
                          percent: 0,
                          downloaded: 0,
                          total: 0,
                          message: ''
                      });
                  }
              }}
              footer={updateDownloadProgress.status === 'error' ? [
                  <Button
                      key="close"
                      onClick={() => setUpdateDownloadProgress({
                          open: false,
                          version: '',
                          status: 'idle',
                          percent: 0,
                          downloaded: 0,
                          total: 0,
                          message: ''
                      })}
                  >
                      关闭
                  </Button>
              ] : null}
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
          
          {/* Ghost Resize Line for Sidebar */}
          <div 
              ref={ghostRef}
              style={{
                  position: 'fixed',
                  top: 0,
                  bottom: 0,
                  left: 0,
                  width: '4px',
                  background: 'rgba(24, 144, 255, 0.5)',
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
                  background: 'rgba(24, 144, 255, 0.5)',
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
