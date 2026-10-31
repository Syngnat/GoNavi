import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketSource } from './types';
const api = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn() }));
vi.mock('./sourceApi', () => ({ marketSourcesAPI: api }));
import { useMarketSources } from './useMarketSources';
const a: MarketSource = { baseUrl: 'https://plugin.gonavi.org', sourceId: 'a'.repeat(64), enabled: true, trustedOfficial: true };
const b: MarketSource = { baseUrl: 'https://private.test', sourceId: 'b'.repeat(64), enabled: true, trustedOfficial: false };
let renderer: ReturnType<typeof create> | undefined;
let manager: ReturnType<typeof useMarketSources>;
function Harness() { manager = useMarketSources(); return null; }
async function mount() { await act(async () => { renderer = create(<Harness />); }); }
beforeEach(() => { vi.resetAllMocks(); api.list.mockResolvedValue([a]); api.save.mockResolvedValue([a, b]); });
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; });
describe('saved market source lifecycle', () => {
  it('uses saved sources and persists opt-in flags through the API', async () => {
    await mount(); expect(manager.sources).toEqual([a]);
    await act(async () => { await manager.save([{ baseUrl: a.baseUrl, enabled: false }, { baseUrl: b.baseUrl, enabled: true }]); });
    expect(manager.sources).toEqual([a, b]); expect(manager.revision).toBe(1);
    expect(api.save).toHaveBeenCalledWith([{ baseUrl: a.baseUrl, enabled: false }, { baseUrl: b.baseUrl, enabled: true }]);
  });
  it('prevents late refresh results from replacing a completed save', async () => {
    let complete: (rows: MarketSource[]) => void = () => {};
    api.list.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    await mount(); await act(async () => { await manager.save([a, b]); });
    await act(async () => { complete([a]); }); expect(manager.sources).toEqual([a, b]); expect(manager.loading).toBe(false);
  });
  it('keeps the old list on a failed save', async () => {
    await mount(); api.save.mockRejectedValue(new Error('persist failed'));
    let result = true; await act(async () => { result = await manager.save([b]); });
    expect(result).toBe(false); expect(manager.sources).toEqual([a]); expect(manager.error).toBeTruthy();
  });
});
