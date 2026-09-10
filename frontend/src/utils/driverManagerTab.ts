import { t } from '../i18n';
import type { TabData } from '../types';

export const DRIVER_MANAGER_WORKBENCH_TAB_ID = 'driver-manager';
export const DOWNLOAD_SOURCE_CHANGED_EVENT = 'gonavi:download-source-changed';
export const OPEN_GLOBAL_PROXY_SETTINGS_EVENT = 'gonavi:open-global-proxy-settings';

export type DownloadSourceId = 'cst' | 'bero' | 'github';

export const normalizeDownloadSource = (value: unknown): DownloadSourceId => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'bero' || normalized === 'github' ? normalized : 'cst';
};

export const getNextDownloadSource = (value: unknown): DownloadSourceId => {
  const current = normalizeDownloadSource(value);
  if (current === 'cst') return 'bero';
  if (current === 'bero') return 'github';
  return 'cst';
};

export const buildDriverManagerWorkbenchTab = (): TabData => ({
  id: DRIVER_MANAGER_WORKBENCH_TAB_ID,
  title: t('app.tools.entry.drivers.title'),
  type: 'driver-manager',
  connectionId: '',
});

export const requestGlobalProxySettings = (): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_GLOBAL_PROXY_SETTINGS_EVENT));
};

export const notifyDownloadSourceChanged = (source: string): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(DOWNLOAD_SOURCE_CHANGED_EVENT, { detail: { source } }));
};
