import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginStatus } from './types';
const host = vi.hoisted(() => ({ PluginList: vi.fn(), PluginInspect: vi.fn(), PluginInstall: vi.fn(),
  PluginSetEnabled: vi.fn(), PluginRemove: vi.fn(), PluginInvoke: vi.fn(), PluginOpenWindow: vi.fn(), PluginRuntimeInfo: vi.fn() }));
vi.mock('../../wailsjs/go/app/App', () => host);
import { usePluginManager, type PluginManagerState } from './usePluginManager';
const plugin: PluginStatus = { manifest: { schemaVersion: 1, apiVersion: 1, id: 'test.hello', name: 'Hello', version: '1.0.0', permissions: [] },
  digest: 'a'.repeat(64), state: 'starting', desiredEnabled: true, generation: 1, installedAt: 'now' };
const ok = (data: unknown) => ({ success: true, data });
let renderer: ReturnType<typeof create> | undefined;
let manager: PluginManagerState;
function Harness() { manager = usePluginManager(); return null; }
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  host.PluginList.mockResolvedValue(ok([plugin]));
  host.PluginRuntimeInfo.mockResolvedValue(ok({ safeMode: false, managementAllowed: true }));
});
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; vi.useRealTimers(); });
describe('plugin lifecycle priority and fencing', () => {
  it('restores availability after removing a running plugin fails', async () => {
    host.PluginList.mockResolvedValue(ok([{ ...plugin, state: 'running' }]));
    host.PluginRemove.mockResolvedValue({ success: false, message: 'disable plugin before removal' });
    await act(async () => { renderer = create(<Harness />); });
    await act(async () => { await manager.remove(plugin.manifest.id, false); });
    expect(manager.error).toContain('disable plugin before removal');
    expect(manager.plugins[0].state).toBe('running');
    expect(manager.revoked.has(plugin.manifest.id)).toBe(false);
    expect(manager.busy[plugin.manifest.id]).toBe(false);
  });
  it('does not undo a newer disable when an earlier removal fails', async () => {
    let rejectRemove: (error: Error) => void = () => {};
    host.PluginRemove.mockImplementation(() => new Promise((_resolve, reject) => { rejectRemove = reject; }));
    host.PluginSetEnabled.mockResolvedValue(ok({ ...plugin, state: 'stopping', desiredEnabled: false }));
    await act(async () => { renderer = create(<Harness />); });
    let removing: Promise<void>;
    await act(async () => { removing = manager.remove(plugin.manifest.id, false); });
    await act(async () => { await manager.setEnabled(plugin.manifest.id, false); });
    await act(async () => { rejectRemove(new Error('remove failed')); await removing!; });
    expect(manager.revoked.has(plugin.manifest.id)).toBe(true);
    expect(manager.error).toBe('');
  });
  it('restores availability when a disable request fails', async () => {
    host.PluginList.mockResolvedValue(ok([{ ...plugin, state: 'running' }]));
    host.PluginSetEnabled.mockResolvedValue({ success: false, message: 'plugin busy' });
    await act(async () => { renderer = create(<Harness />); });
    await act(async () => { await manager.setEnabled(plugin.manifest.id, false); });
    expect(manager.revoked.has(plugin.manifest.id)).toBe(false);
    expect(manager.error).toContain('plugin busy');
  });

  it('keeps an existing revocation when removal fails', async () => {
    host.PluginSetEnabled.mockResolvedValue(ok({ ...plugin, state: 'disabled', desiredEnabled: false }));
    host.PluginRemove.mockRejectedValue(new Error('remove failed'));
    await act(async () => { renderer = create(<Harness />); });
    await act(async () => { await manager.setEnabled(plugin.manifest.id, false); });
    await act(async () => { await manager.remove(plugin.manifest.id, false); });
    expect(manager.revoked.has(plugin.manifest.id)).toBe(true);
  });
  it('sends disable while enable is unresolved, immediately revokes UI, and ignores late enable response', async () => {
    let finishEnable: (value: unknown) => void = () => {};
    host.PluginSetEnabled.mockImplementation((_id: string, enabled: boolean) => enabled
      ? new Promise((resolve) => { finishEnable = resolve; })
      : Promise.resolve(ok({ ...plugin, desiredEnabled: false, state: 'stopping', generation: 2 })));
    await act(async () => { renderer = create(<Harness />); });
    let enabling: Promise<void>;
    await act(async () => { enabling = manager.setEnabled(plugin.manifest.id, true); });
    expect(manager.busy[plugin.manifest.id]).toBe(true);
    await act(async () => { await manager.setEnabled(plugin.manifest.id, false); });
    expect(host.PluginSetEnabled.mock.calls).toEqual([[plugin.manifest.id, true], [plugin.manifest.id, false]]);
    expect(manager.revoked.has(plugin.manifest.id)).toBe(true);
    await act(async () => { finishEnable(ok({ ...plugin, state: 'running', generation: 1 })); await enabling!; });
    expect(manager.revoked.has(plugin.manifest.id)).toBe(true);
    expect(manager.plugins[0].state).not.toBe('running');
  });
  it.each(['starting', 'stopping', 'faulted'] as const)('accepts repeated disable in %s state', async (state) => {
    host.PluginList.mockResolvedValue(ok([{ ...plugin, state }]));
    host.PluginSetEnabled.mockResolvedValue(ok({ ...plugin, state: 'stopping', desiredEnabled: false }));
    await act(async () => { renderer = create(<Harness />); });
    await act(async () => { await manager.setEnabled(plugin.manifest.id, false); });
    await act(async () => { await manager.setEnabled(plugin.manifest.id, false); });
    expect(host.PluginSetEnabled).toHaveBeenCalledTimes(2);
  });
  it('preserves local status and reports refresh errors without invented plugins', async () => {
    await act(async () => { renderer = create(<Harness />); });
    host.PluginList.mockRejectedValue(new Error('network'));
    await act(async () => { await manager.refresh(); });
    expect(manager.error).toBeTruthy();
    expect(manager.plugins).toHaveLength(1);
    expect(manager.plugins[0].manifest.id).toBe(plugin.manifest.id);
  });
});
