import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCurrentLanguage, t } from '../i18n';
import {
  buildDriverManagerWorkbenchTab,
  DOWNLOAD_SOURCE_CHANGED_EVENT,
  DRIVER_MANAGER_WORKBENCH_TAB_ID,
  getNextDownloadSource,
  normalizeDownloadSource,
  notifyDownloadSourceChanged,
} from './driverManagerTab';

describe('driverManagerTab', () => {
  afterEach(() => setCurrentLanguage('zh-CN'));

  it('builds one global driver manager workbench tab', () => {
    expect(buildDriverManagerWorkbenchTab()).toEqual({
      id: DRIVER_MANAGER_WORKBENCH_TAB_ID,
      title: t('app.tools.entry.drivers.title'),
      type: 'driver-manager',
      connectionId: '',
    });
  });

  it('localizes the workbench tab title', () => {
    setCurrentLanguage('en-US');
    expect(buildDriverManagerWorkbenchTab().title).toBe(t('app.tools.entry.drivers.title'));
  });

  it('cycles mirrors in place instead of opening the download source settings page', () => {
    expect(normalizeDownloadSource(' BERO ')).toBe('bero');
    expect(normalizeDownloadSource('GitHub')).toBe('github');
    expect(getNextDownloadSource('cst')).toBe('bero');
    expect(getNextDownloadSource('bero')).toBe('github');
    expect(getNextDownloadSource('github')).toBe('cst');
    expect(getNextDownloadSource('unknown')).toBe('bero');
  });

  it('notifies the workbench when the download source changes', () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const eventTarget = new EventTarget();
    const listener = vi.fn();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: eventTarget });
    try {
      window.addEventListener(DOWNLOAD_SOURCE_CHANGED_EVENT, listener);
      notifyDownloadSourceChanged('github');
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ detail: { source: 'github' } }));
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });
});
