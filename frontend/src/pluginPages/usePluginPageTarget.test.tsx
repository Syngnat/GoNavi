/** @vitest-environment jsdom */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ PluginList: vi.fn() }));
vi.mock('../../wailsjs/go/app/App', () => host);

import type { PluginNavigation, PluginPage, PluginStatus } from '../plugins/types';
import { usePluginPageTarget, type PluginPageTarget } from './usePluginPageTarget';
import { invalidatePluginContributions } from '../plugins/invalidation';
import { PLUGIN_LIFECYCLE_EVENT } from '../plugins/events';
import { t } from '../i18n';

const status = (
  over: Partial<PluginStatus> = {},
  pages: PluginPage[] = [{ id: 'overview', title: 'Overview', body: { type: 'text', text: 'hi' } }],
  navigation: PluginNavigation[] = [{ id: 'overview-tools', title: 'Overview', page: 'overview', location: 'tools' }],
): PluginStatus => ({
  manifest: {
    schemaVersion: 1,
    apiVersion: 1,
    id: 'test.pages',
    name: 'Pages',
    version: '1.0.0',
    permissions: ['ui.pages'],
    contributes: { pages, navigation },
  },
  digest: 'a'.repeat(64),
  state: 'running',
  desiredEnabled: true,
  generation: 1,
  installedAt: '2026-01-01',
  ...over,
});

const captured: { value?: PluginPageTarget } = {};
const Harness = ({ pluginID, pageID }: { pluginID: string; pageID: string }) => {
  captured.value = usePluginPageTarget(pluginID, pageID);
  return null;
};
let renderer: ReactTestRenderer | undefined;

const render = async (pluginID = 'test.pages', pageID = 'overview') => {
  await act(async () => {
    renderer = create(<Harness pluginID={pluginID} pageID={pageID} />);
    await vi.advanceTimersByTimeAsync(0);
  });
  return captured.value!;
};

const unmount = () => {
  act(() => renderer?.unmount());
  renderer = undefined;
};

beforeEach(() => {
  vi.useFakeTimers();
  captured.value = undefined;
  host.PluginList.mockReset();
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
});

describe('usePluginPageTarget', () => {
  it('revokes immediately and rejects old and late generations until a new generation arrives', async () => {
    host.PluginList.mockResolvedValue({ success: true, data: [status()] });
    await render();
    let resolve!: (value: unknown) => void;
    host.PluginList.mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
    act(() => { window.dispatchEvent(new Event('focus')); });
    act(() => invalidatePluginContributions({ pluginId: 'test.pages', reason: 'disabled' }));
    expect(captured.value?.available).toBe(false);
    await act(async () => { window.dispatchEvent(new Event(PLUGIN_LIFECYCLE_EVENT)); });
    expect(captured.value?.available).toBe(false);
    await act(async () => { resolve({ success: true, data: [status()] }); });
    expect(captured.value?.available).toBe(false);
    host.PluginList.mockResolvedValue({ success: true, data: [status({ generation: 2 })] });
    await act(async () => { window.dispatchEvent(new Event(PLUGIN_LIFECYCLE_EVENT)); });
    expect(captured.value?.available).toBe(true);
    expect(captured.value?.status?.generation).toBe(2);
  });
  it('bounds a hung discovery, ignores its late result and retries on focus', async () => {
    let resolve!: (value: unknown) => void;
    host.PluginList.mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
    host.PluginList.mockResolvedValue({ success: true, data: [status()] });
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(captured.value?.loading).toBe(false);
    expect(captured.value?.available).toBe(false);
    expect(captured.value?.error).toBe(t('plugin.backend.error.timeout'));
    await act(async () => { resolve({ success: true, data: [status()] }); });
    expect(captured.value?.available).toBe(false);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(captured.value?.available).toBe(true);
    expect(captured.value?.error).toBe('');
  });
  it('drops older focus responses, target changes and unmount results', async () => {
    let resolve!: (value: unknown) => void;
    host.PluginList.mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
    host.PluginList.mockResolvedValue({ success: true, data: [status({ generation: 2 })] });
    await render();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await act(async () => { resolve({ success: true, data: [status()] }); });
    expect(captured.value?.status?.generation).toBe(2);
    let obsolete!: (value: unknown) => void;
    host.PluginList.mockReturnValueOnce(new Promise(yes => { obsolete = yes; }));
    act(() => { window.dispatchEvent(new Event('focus')); });
    await act(async () => { renderer!.update(<Harness pluginID="other.pages" pageID="overview" />); });
    await act(async () => { obsolete({ success: true, data: [status()] }); });
    expect(captured.value?.available).toBe(false);
    let late!: (value: unknown) => void;
    host.PluginList.mockReturnValueOnce(new Promise(yes => { late = yes; }));
    act(() => { window.dispatchEvent(new Event('focus')); }); unmount();
    const snapshot = captured.value; const calls = host.PluginList.mock.calls.length;
    await act(async () => { late({ success: true, data: [status()] }); window.dispatchEvent(new Event(PLUGIN_LIFECYCLE_EVENT)); });
    expect(captured.value).toBe(snapshot); expect(host.PluginList).toHaveBeenCalledTimes(calls);
  });
  it.each(['removed', 'root'] as const)('invalidates %s immediately even while the document is hidden', async reason => {
    host.PluginList.mockResolvedValue({ success: true, data: [status()] });
    await render();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    try {
      act(() => invalidatePluginContributions({ pluginId: 'test.pages', reason }));
      expect(captured.value?.available).toBe(false); expect(captured.value?.loading).toBe(false);
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(captured.value?.available).toBe(false);
    } finally { delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState; }
  });
  it('keeps the revoked pin across repeated invalidations so a genuinely new generation remains usable', async () => {
    host.PluginList.mockResolvedValue({ success: true, data: [status()] });
    await render();
    act(() => invalidatePluginContributions({ pluginId: 'test.pages', reason: 'disabled' }));
    act(() => invalidatePluginContributions({ pluginId: 'test.pages', reason: 'removed' }));
    host.PluginList.mockResolvedValue({ success: true, data: [status({ generation: 2 })] });
    await act(async () => { window.dispatchEvent(new Event(PLUGIN_LIFECYCLE_EVENT)); });
    expect(captured.value?.available).toBe(true); expect(captured.value?.status?.generation).toBe(2);
  });
  it('does not keep the previous plugin frame available while resolving a different plugin target', async () => {
    host.PluginList.mockResolvedValue({ success: true, data: [status()] });
    await render();
    host.PluginList.mockReturnValueOnce(new Promise(() => undefined));
    act(() => { renderer!.update(<Harness pluginID="other.pages" pageID="overview" />); });
    expect(captured.value?.available).toBe(false);
  });
  it('resolves a declared page of a running plugin', async () => {
    host.PluginList.mockResolvedValue({ success: true, data: [status()] });
    const target = await render();
    expect(target.loading).toBe(false);
    expect(target.available).toBe(true);
    expect(target.page?.id).toBe('overview');
    expect(target.status?.state).toBe('running');
  });

  it('marks the page unavailable when the plugin stops', async () => {
    host.PluginList.mockResolvedValue({ success: true, data: [status({ state: 'disabled', desiredEnabled: false })] });
    const target = await render();
    expect(target.available).toBe(false);
    expect(target.page?.id).toBe('overview');
  });

  it('marks the page unavailable when the plugin disappears or never declared it', async () => {
    host.PluginList.mockResolvedValueOnce({ success: true, data: [] });
    expect((await render()).available).toBe(false);
    unmount();
    host.PluginList.mockResolvedValueOnce({
      success: true,
      data: [status({}, [{ id: 'other', title: 'Other', body: { type: 'text', text: 'x' } }],
        [{ id: 'other-tools', title: 'Other', page: 'other', location: 'tools' }])],
    });
    const target = await render();
    expect(target.available).toBe(false);
    expect(target.page).toBeUndefined();
  });

  it('surfaces a host failure instead of pretending the page exists', async () => {
    host.PluginList.mockResolvedValue({ success: false, message: 'host down' });
    const target = await render();
    expect(target.loading).toBe(false);
    expect(target.error).toBe('host down');
    expect(target.available).toBe(false);
  });

  it('refreshes the plugin state while the tab stays open', async () => {
    host.PluginList.mockResolvedValue({ success: true, data: [status()] });
    await render();
    const calls = host.PluginList.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(host.PluginList.mock.calls.length).toBeGreaterThan(calls);
  });

  it('pauses polling while the window is hidden and refreshes when it returns', async () => {
    host.PluginList.mockResolvedValue({ success: true, data: [status()] });
    let visibility: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    try {
      await render();
      const calls = host.PluginList.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(host.PluginList.mock.calls.length).toBe(calls);
      visibility = 'visible';
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(host.PluginList.mock.calls.length).toBe(calls + 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(host.PluginList.mock.calls.length).toBe(calls + 2);
    } finally {
      delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
    }
  });
});
