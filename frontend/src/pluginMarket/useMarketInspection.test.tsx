import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketInspectionQuote, MarketInspectionRequest } from './types';
const host = vi.hoisted(() => ({ PluginMarketSettings: vi.fn(), PluginMarketConfigure: vi.fn(), PluginMarketCatalog: vi.fn(),
  PluginMarketDetail: vi.fn(), PluginMarketRatings: vi.fn(),
  PluginMarketInstall: vi.fn(),
  PluginMarketInspect: vi.fn(), PluginMarketCancelInspection: vi.fn() }));
vi.mock('../../wailsjs/go/app/App', () => host);
import { useMarketInspection } from './useMarketInspection';
const request: MarketInspectionRequest = { id: 'test.hello', version: '1.0.0', artifactDigest: 'b'.repeat(64), sourceId: 'a'.repeat(64) };
const now = new Date('2026-10-19T00:00:00Z');
const makeQuote = (): MarketInspectionQuote => ({ sourceId: request.sourceId, artifactDigest: request.artifactDigest, approvalToken: 'opaque-token', expiresAt: new Date(now.getTime() + 10000).toISOString(),
  inspection: { manifest: { schemaVersion: 1, apiVersion: 1, id: request.id, name: 'Actual bytes', version: request.version, permissions: ['database.write'] },
    digest: 'c'.repeat(64), sourcePath: '/staged/package', sizeBytes: 120 } });
const ok = (data: unknown) => ({ success: true, data });
let state: ReturnType<typeof useMarketInspection>;
let renderer: ReturnType<typeof create> | undefined;
function Harness({ input = request, allowed = true }: { input?: MarketInspectionRequest; allowed?: boolean }) { state = useMarketInspection(input, allowed); return null; }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.resetAllMocks();
  host.PluginMarketInspect.mockResolvedValue(ok(makeQuote()));
  host.PluginMarketCancelInspection.mockResolvedValue(ok(null));
  host.PluginMarketInstall.mockResolvedValue(ok({ manifest: makeQuote().inspection.manifest, digest: 'c'.repeat(64), state: 'disabled', desiredEnabled: false, generation: 1, installedAt: now.toISOString() }));
});
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; vi.useRealTimers(); });
async function mount(input = request) { await act(async () => { renderer = create(<Harness input={input} />); }); }
describe('one-use inspected package approval', () => {
  it('binds inspect to source and commits exact quote transport digest plus token once', async () => {
    await mount();
    expect(host.PluginMarketInspect).toHaveBeenCalledWith(request.id, request.version, request.artifactDigest, request.sourceId);
    expect(state.quote?.inspection.manifest.permissions).toEqual(['database.write']);
    expect(state.canInstall).toBe(true);
    await act(async () => { await state.commit(); });
    expect(host.PluginMarketInstall).toHaveBeenCalledWith(request.id, request.version, request.artifactDigest, true, 'opaque-token');
    expect(host.PluginMarketInstall).not.toHaveBeenCalledWith(request.id, request.version, 'c'.repeat(64), true, 'opaque-token');
    await act(async () => { await expect(state.commit()).rejects.toThrow('plugin.market.inspection_used'); });
    expect(host.PluginMarketInstall).toHaveBeenCalledTimes(1);
    expect(state.canInstall).toBe(false);
  });
  it.each(['source', 'version', 'id', 'digest'] as const)('rejects and releases a %s mismatch', async (kind) => {
    const quote = makeQuote();
    if (kind === 'source') quote.sourceId = 'd'.repeat(64);
    if (kind === 'version') quote.inspection.manifest.version = '2.0.0';
    if (kind === 'id') quote.inspection.manifest.id = 'other.plugin';
    if (kind === 'digest') quote.artifactDigest = 'e'.repeat(64);
    host.PluginMarketInspect.mockResolvedValue(ok(quote));
    await mount();
    expect(state.quote).toBeNull(); expect(state.canInstall).toBe(false); expect(state.error).toBeTruthy();
    expect(host.PluginMarketCancelInspection).toHaveBeenCalledWith('opaque-token');
    expect(host.PluginMarketInstall).not.toHaveBeenCalled();
  });
  it('expires approval, releases staging and rejects commit', async () => {
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10001); });
    expect(state.expired).toBe(true); expect(state.canInstall).toBe(false);
    await act(async () => { await expect(state.commit()).rejects.toThrow('plugin.market.inspection_expired'); });
    expect(host.PluginMarketCancelInspection).toHaveBeenCalledOnce();
    expect(host.PluginMarketInstall).not.toHaveBeenCalled();
  });
  it('releases malformed issued quotes rejected by the typed adapter', async () => {
    host.PluginMarketInspect.mockResolvedValue(ok({ ...makeQuote(), sourceId: 'invalid-source' }));
    await mount();
    expect(state.quote).toBeNull(); expect(state.error).toBeTruthy();
    expect(host.PluginMarketCancelInspection).toHaveBeenCalledWith('opaque-token');
  });
  it('checks wall-clock expiry again on commit even when timer delivery is delayed', async () => {
    await mount();
    vi.setSystemTime(new Date(now.getTime() + 20000));
    await act(async () => { await expect(state.commit()).rejects.toThrow('plugin.market.inspection_expired'); });
    expect(host.PluginMarketInstall).not.toHaveBeenCalled();
    expect(host.PluginMarketCancelInspection).toHaveBeenCalledWith('opaque-token');
    expect(state.canInstall).toBe(false);
  });
  it('rejects already-expired quotes without ever offering consent', async () => {
    host.PluginMarketInspect.mockResolvedValue(ok({ ...makeQuote(), expiresAt: now.toISOString() }));
    await mount();
    expect(state.quote).toBeNull(); expect(state.error).toBeTruthy();
    expect(host.PluginMarketCancelInspection).toHaveBeenCalledWith('opaque-token');
  });
  it('closes immediately while download is pending and releases the late quote', async () => {
    let resolve: (value: unknown) => void = () => {};
    host.PluginMarketInspect.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await mount();
    expect(state.loading).toBe(true);
    act(() => state.cancel());
    await act(async () => { resolve(ok(makeQuote())); });
    expect(state.quote).toBeNull();
    expect(host.PluginMarketCancelInspection).toHaveBeenCalledWith('opaque-token');
    expect(host.PluginMarketInstall).not.toHaveBeenCalled();
  });
  it('releases an inspected quote on unmount and prevents cancel-then-commit', async () => {
    await mount();
    await act(async () => { state.cancel(); await expect(state.commit()).rejects.toThrow(); renderer!.unmount(); renderer = undefined; });
    expect(host.PluginMarketCancelInspection).toHaveBeenCalledOnce();
    expect(host.PluginMarketInstall).not.toHaveBeenCalled();
  });
  it('requires a source identity before contacting the host', async () => {
    await mount({ ...request, sourceId: '' });
    expect(state.error).toBeTruthy(); expect(state.canInstall).toBe(false);
    expect(host.PluginMarketInspect).not.toHaveBeenCalled();
  });
  it('does not reuse an approval after a failed or partial commit', async () => {
    host.PluginMarketInstall.mockResolvedValue({ success: false, message: 'Commit rejected' });
    await mount();
    await act(async () => { await expect(state.commit()).rejects.toThrow(); });
    expect(state.canInstall).toBe(false);
    await act(async () => { await expect(state.commit()).rejects.toThrow('plugin.market.inspection_used'); });
    expect(host.PluginMarketInstall).toHaveBeenCalledTimes(1);
  });
  it('fences an old pending quote after source changes', async () => {
    let resolve: (value: unknown) => void = () => {};
    const nextRequest = { ...request, sourceId: 'f'.repeat(64) };
    host.PluginMarketInspect.mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
      .mockResolvedValue(ok({ ...makeQuote(), sourceId: nextRequest.sourceId, approvalToken: 'next-token' }));
    await mount();
    await act(async () => { renderer!.update(<Harness input={nextRequest} />); });
    await act(async () => { resolve(ok(makeQuote())); });
    expect(state.quote?.approvalToken).toBe('next-token');
    expect(host.PluginMarketCancelInspection).toHaveBeenCalledWith('opaque-token');
    await act(async () => { await state.commit(); });
    expect(host.PluginMarketInstall).toHaveBeenCalledWith(request.id, request.version, request.artifactDigest, true, 'next-token');
  });
});
