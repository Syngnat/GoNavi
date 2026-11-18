import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginStatus } from '../plugins/types';
import type { MarketSource } from './types';

const mocks = vi.hoisted(() => ({ detail: vi.fn(), resolveIcon: vi.fn() }));
vi.mock('./sourceApi', () => ({ sourceMarketAPI: () => ({ detail: mocks.detail }) }));
vi.mock('./marketPluginIcon', () => ({ resolveMarketPluginIcon: mocks.resolveIcon }));
import { useInstalledPluginIconSources } from './useInstalledPluginIconSources';

const official: MarketSource = { sourceId: 'a'.repeat(64), baseUrl: 'https://official.test', trustedOfficial: true, enabled: true };
const thirdParty: MarketSource = { sourceId: 'b'.repeat(64), baseUrl: 'https://third.test', trustedOfficial: false, enabled: true };
const plugin = (id: string): PluginStatus => ({
  manifest: { schemaVersion: 1, apiVersion: 1, id, name: id, version: '1.0.0', permissions: [] },
  digest: 'c'.repeat(64), state: 'running', desiredEnabled: true, generation: 1, installedAt: '',
});

function Probe({ plugins, sources, enabled }: { plugins: PluginStatus[]; sources: MarketSource[]; enabled: boolean }) {
  const map = useInstalledPluginIconSources(plugins, sources, enabled);
  return <div data-logos={JSON.stringify(Array.from(map.entries()))} />;
}

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const logos = (view: ReturnType<typeof create>) => JSON.parse(view.root.findByType('div').props['data-logos']) as [string, string[]][];

beforeEach(() => { mocks.detail.mockReset(); mocks.resolveIcon.mockReset(); });

describe('installed plugin market logos', () => {
  it('resolves the logo declared by the first source that knows the plugin', async () => {
    mocks.detail.mockImplementation((id: string) => id === 'com.example.a'
      ? Promise.resolve({ id, name: id, sourceUrl: 'https://github.com/o/r' })
      : Promise.reject(new Error('not found')));
    mocks.resolveIcon.mockResolvedValue(['https://raw.githubusercontent.com/o/r/HEAD/icon.png']);
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(<Probe plugins={[plugin('com.example.a')]} sources={[official, thirdParty]} enabled />); });
    await flush();
    expect(logos(view)).toEqual([['com.example.a', ['https://raw.githubusercontent.com/o/r/HEAD/icon.png']]]);
    // 第一个来源就命中，不必再问第二个来源。
    expect(mocks.detail).toHaveBeenCalledTimes(1);
    await act(async () => { view.unmount(); });
  });

  it('falls through to the next source when one has no icon', async () => {
    mocks.detail.mockResolvedValue({ id: 'com.example.b', name: 'b' });
    mocks.resolveIcon.mockResolvedValueOnce([]).mockResolvedValueOnce(['https://raw.githubusercontent.com/x/y/HEAD/icon.png']);
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(<Probe plugins={[plugin('com.example.b')]} sources={[official, thirdParty]} enabled />); });
    await flush();
    expect(logos(view)).toEqual([['com.example.b', ['https://raw.githubusercontent.com/x/y/HEAD/icon.png']]]);
    await act(async () => { view.unmount(); });
  });

  it('returns an empty candidate list when no source knows the plugin', async () => {
    mocks.detail.mockRejectedValue(new Error('not found'));
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(<Probe plugins={[plugin('com.example.c')]} sources={[official]} enabled />); });
    await flush();
    expect(logos(view)).toEqual([['com.example.c', []]]);
    await act(async () => { view.unmount(); });
  });

  it('does not query sources while the installed tab is hidden', async () => {
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(<Probe plugins={[plugin('com.example.d')]} sources={[official]} enabled={false} />); });
    await flush();
    expect(logos(view)).toEqual([]);
    expect(mocks.detail).not.toHaveBeenCalled();
    await act(async () => { view.unmount(); });
  });

  it('prefers a trusted official source and reuses the cached result', async () => {
    mocks.detail.mockResolvedValue({ id: 'com.example.e', name: 'e' });
    mocks.resolveIcon.mockResolvedValue(['https://raw.githubusercontent.com/o/r/HEAD/icon.png']);
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(<Probe plugins={[plugin('com.example.e')]} sources={[thirdParty, official]} enabled />); });
    await flush();
    expect(logos(view)).toHaveLength(1);
    // 官方来源排在第三方之前。
    expect(mocks.detail.mock.calls[0]).toEqual(['com.example.e']);
    expect(mocks.resolveIcon.mock.calls[0][1]).toBe(official.sourceId);
    const calls = mocks.detail.mock.calls.length;
    await act(async () => { view.update(<Probe plugins={[plugin('com.example.e')]} sources={[thirdParty, official]} enabled />); });
    await flush();
    expect(mocks.detail.mock.calls.length).toBe(calls);
    await act(async () => { view.unmount(); });
  });
});
