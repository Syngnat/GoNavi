import { beforeEach, describe, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({ PluginList: vi.fn(), PluginInspect: vi.fn(), PluginInstall: vi.fn(),
  PluginSetEnabled: vi.fn(), PluginRemove: vi.fn(), PluginInvoke: vi.fn(), PluginOpenWindow: vi.fn(), PluginRuntimeInfo: vi.fn() }));
vi.mock('../../wailsjs/go/app/App', () => host);
import { pluginAPI } from './api';
import { pluginErrorText } from './apiResult';
const manifest = { schemaVersion: 1, apiVersion: 1, id: 'test.hello', name: 'Hello', version: '1.0.0', permissions: [] };
const status = { manifest, digest: 'a'.repeat(64), state: 'disabled', desiredEnabled: false, generation: 1, installedAt: '2026-01-01' };
beforeEach(() => vi.resetAllMocks());
describe('generated plugin adapter', () => {
  it('passes the exact inspected digest and explicit trust to installation', async () => {
    host.PluginInspect.mockResolvedValue({ success: true, data: { manifest, digest: status.digest, sourcePath: '/tmp/package', sizeBytes: 14 } });
    host.PluginInstall.mockResolvedValue({ success: true, data: status });
    const preview = await pluginAPI.inspect('/tmp/package');
    await pluginAPI.install(preview.sourcePath, preview.digest, true);
    expect(host.PluginInstall).toHaveBeenCalledWith('/tmp/package', status.digest, true);
  });
  it('unwraps success and never turns backend errors into fake data', async () => {
    host.PluginList.mockResolvedValue({ success: false, message: 'Localized host failure' });
    await expect(pluginAPI.list()).rejects.toThrow('plugin.backend.error.operation_failed');
    try { await pluginAPI.list(); } catch (cause) { expect(pluginErrorText(cause)).toBe('Localized host failure'); }
    host.PluginList.mockResolvedValue({ success: true, data: [{ bad: true }] });
    await expect(pluginAPI.list()).rejects.toThrow();
    host.PluginInspect.mockResolvedValue({ success: false, message: 'raw host text', data: { code: 'command_reserved' } });
    await expect(pluginAPI.inspect('pkg')).rejects.toThrow('plugin.backend.error.command_reserved');
    try { await pluginAPI.inspect('pkg'); } catch (cause) { expect(pluginErrorText(cause)).not.toContain('raw host text'); }
  });
  it('serializes bounded command arguments and validates returned data', async () => {
    host.PluginInvoke.mockResolvedValue({ success: true, data: { value: 42 } });
    expect(await pluginAPI.invoke('test.hello', 'hello', { who: 'Ada' })).toEqual({ value: 42 });
    expect(host.PluginInvoke).toHaveBeenCalledWith('test.hello', 'hello', '{"who":"Ada"}');
    expect(() => pluginAPI.invoke('test.hello', 'hello', { text: 'x'.repeat(9000) })).toThrow();
  });
  it('loads installed plugins with host-provided icons and preserves status updates', async () => {
    const withIcon = { ...status, manifest: { ...manifest, icon: 'frontend/icon.png' } };
    host.PluginList.mockResolvedValue({ success: true, data: [withIcon, status] });
    expect(await pluginAPI.list()).toEqual([withIcon, status]);
    host.PluginInspect.mockResolvedValue({ success: true, data: {
      manifest: withIcon.manifest, digest: status.digest, sourcePath: '/tmp/package', sizeBytes: 14,
    } });
    expect((await pluginAPI.inspect('/tmp/package')).manifest.icon).toBe('frontend/icon.png');
    host.PluginInstall.mockResolvedValue({ success: true, data: withIcon });
    expect(await pluginAPI.install('/tmp/package', status.digest, true)).toEqual(withIcon);
    host.PluginSetEnabled.mockResolvedValue({ success: true, data: withIcon });
    expect(await pluginAPI.setEnabled(manifest.id, false)).toEqual(withIcon);
  });
  it('never conflates an enable request with disable', async () => {
    host.PluginSetEnabled.mockResolvedValue({ success: true, data: status });
    await pluginAPI.setEnabled('test.hello', false);
    expect(host.PluginSetEnabled).toHaveBeenCalledWith('test.hello', false);
  });
});
