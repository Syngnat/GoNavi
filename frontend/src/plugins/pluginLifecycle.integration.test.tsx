// @vitest-environment jsdom
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PluginStatus } from './types';
const api = vi.hoisted(() => ({ list: vi.fn(), runtimeInfo: vi.fn(), setEnabled: vi.fn() }));
vi.mock('./api', () => ({ pluginAPI: api }));
vi.mock('./dataSource/discovery', () => ({ refreshPluginDataSources: vi.fn(), revokePluginDataSourceAvailability: vi.fn() }));
import { usePluginManager, type PluginManagerState } from './usePluginManager';
import { usePluginConnectionActions } from './usePluginConnectionActions';
import type { PluginConnectionActionEntry } from './connectionActions';
import { PLUGIN_LIFECYCLE_EVENT } from './events';
const plugin: PluginStatus = {
  manifest: { schemaVersion: 1, apiVersion: 1, id: 'test.actions', name: 'Actions', version: '1.0.0', permissions: [],
    contributes: { connectionActions: [{ id: 'open', title: 'Open', connectionTypes: ['mongodb'], scopes: ['collection'], target: { type: 'window' } }] } },
  digest: 'a'.repeat(64), state: 'disabled', desiredEnabled: false, generation: 1, installedAt: 'now',
};
let current = plugin;
let manager: PluginManagerState;
let actions: PluginConnectionActionEntry[];
let renderer: ReturnType<typeof create> | undefined;
function ManagerHarness() { manager = usePluginManager(); return null; }
function ActionsHarness() { actions = usePluginConnectionActions().actions; return null; }
function Harness({ managed = true }: { managed?: boolean }) { return <>{managed && <ManagerHarness />}<ActionsHarness /></>; }
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); current = plugin;
  api.list.mockImplementation(async () => [current]);
  api.runtimeInfo.mockResolvedValue({ safeMode: false, managementAllowed: true, webRuntime: false });
  api.setEnabled.mockImplementation(async () => { current = { ...plugin, state: 'starting', desiredEnabled: true }; return current; });
});
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; vi.useRealTimers(); });
it('finishes startup discovery after the management surface is closed and clears timers on unmount', async () => {
  await act(async () => { renderer = create(<Harness />); });
  await act(async () => { await manager.setEnabled(plugin.manifest.id, true); });
  expect(actions).toEqual([]);
  await act(async () => { renderer!.update(<Harness managed={false} />); });
  current = { ...current, state: 'running' };
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(actions.map((entry) => entry.pluginID)).toEqual([plugin.manifest.id]);
  act(() => renderer!.unmount()); renderer = undefined;
  expect(vi.getTimerCount()).toBe(0);
});
it('bounds startup polling and cancels pending startup retries on unmount', async () => {
  current = { ...plugin, state: 'starting', desiredEnabled: true };
  await act(async () => { renderer = create(<Harness managed={false} />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(61000); });
  expect(api.list.mock.calls.length).toBeGreaterThan(1);
  expect(api.list.mock.calls.length).toBeLessThanOrEqual(41);
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => { window.dispatchEvent(new Event(PLUGIN_LIFECYCLE_EVENT)); });
  current = { ...plugin, state: 'disabled' };
  await act(async () => { window.dispatchEvent(new Event(PLUGIN_LIFECYCLE_EVENT)); });
  current = { ...plugin, state: 'starting', desiredEnabled: true };
  await act(async () => { window.dispatchEvent(new Event(PLUGIN_LIFECYCLE_EVENT)); });
  expect(vi.getTimerCount()).toBe(1);
  act(() => renderer!.unmount()); renderer = undefined;
  expect(vi.getTimerCount()).toBe(0);
});
it('refreshes subscribed sidebar actions when enable finishes starting on a later manager poll', async () => {
  const lifecycle = vi.fn();
  window.addEventListener(PLUGIN_LIFECYCLE_EVENT, lifecycle);
  try {
    await act(async () => { renderer = create(<Harness />); });
    await act(async () => { await manager.setEnabled(plugin.manifest.id, true); });
    expect(actions).toEqual([]);
    lifecycle.mockClear();
    current = { ...current, state: 'running' };
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(actions.map((entry) => entry.pluginID)).toEqual([plugin.manifest.id]);
    expect(lifecycle).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(lifecycle).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener(PLUGIN_LIFECYCLE_EVENT, lifecycle); }
});
