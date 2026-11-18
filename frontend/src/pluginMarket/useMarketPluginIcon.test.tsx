import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MarketPlugin } from './types';

const resolver = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('./marketPluginIcon', () => ({ resolveMarketPluginIcon: resolver.resolve }));
import { useMarketPluginIcon } from './useMarketPluginIcon';

const plugin: MarketPlugin = {
  id: 'gh-author.remote-logo', name: 'Remote', description: '', author: '', publisherId: 'gh-author', official: false,
  version: '1.0.0', platforms: ['any'], ratingAverage: 0, ratingCount: 0, downloadCount: 0, updatedAt: 'now',
  sourceUrl: 'https://github.com/author/repo',
};
const sourceId = 'a'.repeat(64);
let renderer: ReturnType<typeof create> | undefined;

function Harness({ enabled = true, id = plugin.id, retryKey = 0 }: { enabled?: boolean; id?: string; retryKey?: number }) {
  const src = useMarketPluginIcon({ ...plugin, id }, sourceId, enabled, retryKey);
  return <span data-src={src.join('|')} />;
}

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
  resolver.resolve.mockReset();
  vi.useRealTimers();
});

describe('market plugin remote icon', () => {
  it('resolves candidate addresses once and reuses the cache across mounts', async () => {
    resolver.resolve.mockResolvedValue([
      'https://raw.githubusercontent.com/author/repo/HEAD/frontend/icon.png',
      'https://raw.githubusercontent.com/author/repo/HEAD/frontend/public/icon.png',
    ]);
    await act(async () => { renderer = create(<Harness />); });
    await act(async () => { await Promise.resolve(); });
    expect(renderer!.root.findByProps({ 'data-src': 'https://raw.githubusercontent.com/author/repo/HEAD/frontend/icon.png|https://raw.githubusercontent.com/author/repo/HEAD/frontend/public/icon.png' })).toBeTruthy();
    expect(resolver.resolve).toHaveBeenCalledOnce();
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    await act(async () => { renderer = create(<Harness />); });
    expect(renderer!.root.findByProps({ 'data-src': 'https://raw.githubusercontent.com/author/repo/HEAD/frontend/icon.png|https://raw.githubusercontent.com/author/repo/HEAD/frontend/public/icon.png' })).toBeTruthy();
    expect(resolver.resolve).toHaveBeenCalledOnce();
  });

  it('does not resolve a remote icon for an installed plugin', async () => {
    await act(async () => { renderer = create(<Harness enabled={false} />); });
    expect(renderer!.root.findByProps({ 'data-src': '' })).toBeTruthy();
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('retries a failed detail request before giving up', async () => {
    vi.useFakeTimers();
    resolver.resolve.mockRejectedValueOnce(new Error('cold start')).mockResolvedValueOnce(['https://raw.githubusercontent.com/author/retry/HEAD/icon.png']);
    await act(async () => { renderer = create(<Harness id="gh-author.retry" />); });
    await act(async () => { await Promise.resolve(); });
    expect(renderer!.root.findByProps({ 'data-src': '' })).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => { await Promise.resolve(); });
    expect(renderer!.root.findByProps({ 'data-src': 'https://raw.githubusercontent.com/author/retry/HEAD/icon.png' })).toBeTruthy();
    expect(resolver.resolve).toHaveBeenCalledTimes(2);
  });
});
