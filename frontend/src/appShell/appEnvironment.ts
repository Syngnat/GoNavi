import { SecurityUpdateStatus, SavedConnection } from '../types';
import { isMacLikePlatform } from '../utils/appearance';
import { resolveWailsWindowVisibleViewport } from '../utils/wailsWindowViewport';

export const createEmptySecurityUpdateStatus = (): SecurityUpdateStatus => ({
  overallStatus: 'not_detected',
  summary: {
    total: 0,
    updated: 0,
    pending: 0,
    skipped: 0,
    failed: 0,
  },
  issues: [],
});

export const detectNavigatorPlatform = (): string => {
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

export const readCurrentVisibleViewport = () => resolveWailsWindowVisibleViewport(
  window.screen as Screen & { availLeft?: number; availTop?: number },
  { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
  { useMonitorLocalOrigin: isMacLikePlatform() },
);

export const getSystemThemeMode = (): 'light' | 'dark' => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

export const mergeSavedConnections = (current: SavedConnection[], imported: SavedConnection[]): SavedConnection[] => {
  const merged = new Map<string, SavedConnection>();
  current.forEach((conn) => merged.set(conn.id, conn));
  imported.forEach((conn) => merged.set(conn.id, conn));
  return Array.from(merged.values());
};
