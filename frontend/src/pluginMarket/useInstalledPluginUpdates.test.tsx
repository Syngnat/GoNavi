import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginAPIError } from '../plugins/apiResult';
import type { PluginStatus } from '../plugins/types';
import type { MarketSource } from './types';
import type { MarketVersionPage } from './versionsApi';
import { useInstalledPluginUpdates } from './useInstalledPluginUpdates';

const mocks = vi.hoisted(() => ({ sources: vi.fn(), versions: vi.fn() }));
vi.mock('./sourceApi', () => ({ marketSourcesAPI: { list: mocks.sources } }));
vi.mock('./versionsApi', () => ({ loadMarketVersions: mocks.versions }));
const source: MarketSource = { sourceId: 'a'.repeat(64), baseUrl: 'https://market.test', enabled: true, trustedOfficial: true };
const plugin: PluginStatus = { manifest: { schemaVersion: 1, apiVersion: 1, id: 'com.gonavi.mongo-shell', name: 'MongoShell', version: '1.0.1', permissions: [] }, generation: 1, state: 'running', desiredEnabled: true, digest: 'b'.repeat(64), installedAt: '' };
const page: MarketVersionPage = { versions: [{ compatible: true, reason: '', plugin: {
  id: plugin.manifest.id, name: 'MongoShell', version: '1.0.2', sourceId: source.sourceId, official: true, description: '', author: '', publisherId: '', platforms: ['any'], updatedAt: '', ratingAverage: 0, ratingCount: 0, downloadCount: 0,
  artifact: { url: 'https://market.test/file', sha256: 'c'.repeat(64), sizeBytes: 100, version: '1.0.2', platform: 'all' },
} }] };
let latest: ReturnType<typeof useInstalledPluginUpdates>;
let view: ReactTestRenderer | undefined;
function Probe({ plugins = [plugin], enabled = true }: { plugins?: PluginStatus[]; enabled?: boolean }) { latest = useInstalledPluginUpdates(plugins, enabled); return null; }
async function mount(plugins = [plugin], enabled = true) { await act(async () => { view = create(<Probe plugins={plugins} enabled={enabled} />); }); }
beforeEach(() => { vi.resetAllMocks(); mocks.sources.mockResolvedValue([source]); mocks.versions.mockResolvedValue(page); });
afterEach(() => { if (view) act(() => view!.unmount()); view = undefined; vi.useRealTimers(); });

describe('installed update checking lifecycle', () => {
  it('queries only enabled sources and installed IDs without downloading packages', async () => {
    mocks.sources.mockResolvedValue([source, { ...source, sourceId: 'd'.repeat(64), enabled: false }]);
    await mount();
    expect(mocks.versions).toHaveBeenCalledTimes(1);
    expect(mocks.versions).toHaveBeenCalledWith(plugin.manifest.id, source.sourceId, true);
    expect(latest.updates.get(plugin.manifest.id)?.plugin.version).toBe('1.0.2');
    expect(latest.checked).toBe(true);
    expect(latest.loading).toBe(false);
  });
  it('does not recheck each local running-state poll but rechecks installed version changes', async () => {
    await mount();
    await act(async () => { view!.update(<Probe plugins={[{ ...plugin, generation: 2 }]} />); });
    expect(mocks.sources).toHaveBeenCalledTimes(1);
    const updated = { ...plugin, manifest: { ...plugin.manifest, version: '1.0.2' } };
    await act(async () => { view!.update(<Probe plugins={[updated]} />); });
    expect(mocks.sources).toHaveBeenCalledTimes(2);
    expect(latest.updates.size).toBe(0);
  });
  it('manual refresh uses newly enabled sources and discards stale results', async () => {
    let resolve!: (value: MarketVersionPage) => void;
    const waiting = new Promise<MarketVersionPage>((done) => { resolve = done; });
    mocks.versions.mockReturnValueOnce(waiting).mockResolvedValueOnce({ versions: [{ ...page.versions[0], plugin: { ...page.versions[0].plugin, version: '1.0.1', artifact: { ...page.versions[0].plugin.artifact!, version: '1.0.1' } } }] });
    await mount();
    act(() => { void latest.reload(); });
    await act(async () => { resolve(page); });
    expect(latest.updates.size).toBe(0);
    expect(latest.loading).toBe(false);
  });
  it('coalesces repeated refresh clicks while an update check is in flight', async () => {
    let resolve!: (value: MarketVersionPage) => void;
    mocks.versions.mockReturnValue(new Promise<MarketVersionPage>((done) => { resolve = done; }));
    await mount();
    act(() => { for (let i = 0; i < 10; i++) void latest.reload(); });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.sources).toHaveBeenCalledTimes(1);
    expect(mocks.versions).toHaveBeenCalledTimes(1);
    mocks.versions.mockResolvedValue(page);
    await act(async () => { resolve(page); });
    expect(mocks.sources).toHaveBeenCalledTimes(2);
    expect(latest.updates.get(plugin.manifest.id)?.plugin.version).toBe('1.0.2');
  });
  it('reports partial source failure while keeping successful update results', async () => {
    const second = { ...source, sourceId: 'd'.repeat(64), trustedOfficial: false };
    mocks.sources.mockResolvedValue([source, second]);
    mocks.versions.mockImplementation((_id: string, sid: string) => sid === source.sourceId ? Promise.resolve(page) : Promise.reject(new Error('offline')));
    await mount();
    expect(latest.failed).toBe(true);
    expect(latest.updates.get(plugin.manifest.id)?.source.sourceId).toBe(source.sourceId);
  });
  it('does not call a plugin absent from a source an update-check outage', async () => {
    mocks.versions.mockRejectedValue(new PluginAPIError('plugin.backend.error.not_found'));
    await mount();
    expect(latest.failed).toBe(false);
    expect(latest.checked).toBe(true);
    expect(latest.updates.size).toBe(0);
  });
  it('never presents a failed source request as a successful no-update check', async () => {
    mocks.sources.mockRejectedValue(new Error('offline'));
    await mount();
    expect(latest.failed).toBe(true);
    expect(latest.updates.size).toBe(0);
  });
  it('checks periodically and stops timers when the installed page is inactive', async () => {
    vi.useFakeTimers();
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });
    expect(mocks.sources).toHaveBeenCalledTimes(2);
    await act(async () => { view!.update(<Probe enabled={false} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60 * 1000); });
    expect(mocks.sources).toHaveBeenCalledTimes(2);
    expect(latest.updates.size).toBe(0);
  });
  it('does not recheck empty libraries', async () => {
    await mount([]);
    expect(mocks.sources).not.toHaveBeenCalled();
    expect(latest.loading).toBe(false);
  });
});
