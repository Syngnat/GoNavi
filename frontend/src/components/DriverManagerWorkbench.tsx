import { Button, message, theme } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../i18n/provider';
import { useStore } from '../store';
import type { TabData } from '../types';
import {
  DOWNLOAD_SOURCE_CHANGED_EVENT,
  getNextDownloadSource,
  normalizeDownloadSource,
  notifyDownloadSourceChanged,
  requestGlobalProxySettings,
  type DownloadSourceId,
} from '../utils/driverManagerTab';
import DriverManagerModal from './DriverManagerModal';
import './DriverManagerWorkbench.css';

interface DriverManagerWorkbenchProps {
  tab: TabData;
  isActive?: boolean;
  onRequestClose?: () => void;
}

export default function DriverManagerWorkbench({
  tab,
  isActive = true,
  onRequestClose,
}: DriverManagerWorkbenchProps) {
  const { t } = useI18n();
  const { token } = theme.useToken();
  const closeTab = useStore((state) => state.closeTab);
  const [downloadSource, setDownloadSource] = useState<DownloadSourceId>('cst');
  const [downloadSourceSwitching, setDownloadSourceSwitching] = useState(false);
  const loadDownloadSource = useCallback(async () => {
    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.GetDownloadSourceConfig !== 'function') return;
    try {
      const result = await backendApp.GetDownloadSourceConfig();
      setDownloadSource(normalizeDownloadSource(result?.source));
    } catch (error) {
      console.warn('Failed to load download source preference in driver workbench', error);
    }
  }, []);

  useEffect(() => {
    if (isActive) void loadDownloadSource();
  }, [isActive, loadDownloadSource]);

  useEffect(() => {
    const handleDownloadSourceChanged = (event: Event) => {
      setDownloadSource(normalizeDownloadSource((event as CustomEvent<{ source?: unknown }>).detail?.source));
    };
    const handleWindowFocus = () => void loadDownloadSource();
    window.addEventListener(DOWNLOAD_SOURCE_CHANGED_EVENT, handleDownloadSourceChanged);
    window.addEventListener('focus', handleWindowFocus);
    return () => {
      window.removeEventListener(DOWNLOAD_SOURCE_CHANGED_EVENT, handleDownloadSourceChanged);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [loadDownloadSource]);

  const handleSwitchDownloadSource = useCallback(async () => {
    if (downloadSourceSwitching) return;
    const previousSource = downloadSource;
    const nextSource = getNextDownloadSource(downloadSource);
    setDownloadSource(nextSource);
    notifyDownloadSourceChanged(nextSource);
    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.SaveDownloadSourceConfig !== 'function') return;

    setDownloadSourceSwitching(true);
    try {
      const result = await backendApp.SaveDownloadSourceConfig(nextSource);
      const savedSource = normalizeDownloadSource(result?.source ?? nextSource);
      setDownloadSource(savedSource);
      notifyDownloadSourceChanged(savedSource);
      void message.success(t('app.download_source.message.saved'));
    } catch (error) {
      setDownloadSource(previousSource);
      notifyDownloadSourceChanged(previousSource);
      void message.error(error instanceof Error ? error.message : t('app.download_source.message.save_failed'));
    } finally {
      setDownloadSourceSwitching(false);
    }
  }, [downloadSource, downloadSourceSwitching, t]);
  const workbenchStyle = {
    '--driver-manager-workbench-surface': token.colorBgContainer,
    '--driver-manager-workbench-text': token.colorText,
    '--driver-manager-workbench-muted': token.colorTextSecondary,
    '--driver-manager-workbench-primary': token.colorPrimary,
  } as React.CSSProperties;

  return (
    <main
      className="gn-driver-manager-workbench"
      style={workbenchStyle}
      aria-labelledby="driver-manager-workbench-title"
    >
      <section className="preview-settings">
        <header className="preview-settings-pane-head">
          <div className="preview-settings-pane-copy">
            <div className="preview-settings-pane-title" id="driver-manager-workbench-title">
              {t('driver_manager.title')}
            </div>
            <div className="preview-settings-pane-sub">
              {t('app.tools.entry.drivers.description')}
            </div>
          </div>
          <Button
            className="preview-settings-source"
            type="text"
            size="small"
            onClick={() => void handleSwitchDownloadSource()}
            loading={downloadSourceSwitching}
            disabled={downloadSourceSwitching}
            aria-label={`${t('driver_manager.mirror_source.label')}: ${t(`app.download_source.option.${downloadSource}`)}. ${t('driver_manager.mirror_source.switch')}`}
          >
            <span className="preview-settings-source-dot" data-download-source={downloadSource} aria-hidden="true" />
            <span className="preview-settings-source-name" title={t(`app.download_source.option.${downloadSource}`)}>{t(`app.download_source.option.${downloadSource}`)}</span>
            <span className="preview-settings-source-action">{t('driver_manager.mirror_source.switch')}</span>
          </Button>
        </header>

        <div className="gn-driver-manager-workbench-content">
          <DriverManagerModal
            embedded
            open={isActive}
            onClose={() => (onRequestClose ? onRequestClose() : closeTab(tab.id))}
            onOpenGlobalProxySettings={requestGlobalProxySettings}
            onSwitchDownloadSource={() => void handleSwitchDownloadSource()}
            downloadSourceSwitching={downloadSourceSwitching}
            downloadSource={downloadSource}
          />
        </div>
      </section>
    </main>
  );
}
