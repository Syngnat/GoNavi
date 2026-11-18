import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ PluginIcon: vi.fn() }));
vi.mock('../../../wailsjs/go/app/App', () => host);
import { PluginLogo } from './PluginLogo';

const flush = async () => { await act(async () => { await Promise.resolve(); }); };

beforeEach(() => { host.PluginIcon.mockReset(); });

describe('plugin logo', () => {
  it('uses the toolbar variant without changing the installed-card appearance', async () => {
    host.PluginIcon.mockResolvedValue('data:image/png;base64,AAAA');
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(<PluginLogo pluginId="test.toolbar-variant" name="Toolbar" version="1.0.0" variant="toolbar" fallback={<svg data-fallback="true" />} />); });
    await flush();
    expect(view.root.findByProps({ className: 'plugin-toolbar-logo' }).type).toBe('span');
    expect(view.root.findByType('img').props.src).toBe('data:image/png;base64,AAAA');
    expect(view.root.findAllByProps({ className: 'plugin-logo' })).toHaveLength(0);
    await act(async () => { view.unmount(); });
  });
  it('restores the toolbar fallback if the browser cannot decode the icon', async () => {
    host.PluginIcon.mockResolvedValue('data:image/png;base64,AAAA');
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(<PluginLogo pluginId="test.broken-raster" name="Broken" version="1.0.0" variant="toolbar" fallback={<svg data-fallback="true" />} />); });
    await flush();
    await act(async () => { view.root.findByType('img').props.onError(); });
    expect(view.root.findAllByType('img')).toHaveLength(0);
    expect(view.root.findByProps({ 'data-fallback': 'true' }).type).toBe('svg');
    await act(async () => { view.unmount(); });
  });
  it('does not retain an earlier version icon while the new version loads or fails', async () => {
    host.PluginIcon.mockResolvedValueOnce('data:image/png;base64,AAAA');
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(<PluginLogo pluginId="test.version-change" name="Version" version="1.0.0" variant="toolbar" fallback={<svg data-fallback="true" />} />); });
    await flush();
    let reject!: (error: Error) => void;
    host.PluginIcon.mockImplementationOnce(() => new Promise<string>((_resolve, no) => { reject = no; }));
    await act(async () => { view.update(<PluginLogo pluginId="test.version-change" name="Version" version="2.0.0" variant="toolbar" fallback={<svg data-fallback="true" />} />); });
    expect(view.root.findAllByType('img')).toHaveLength(0);
    await act(async () => { reject(new Error('icon read failed')); });
    expect(view.root.findAllByType('img')).toHaveLength(0);
    expect(view.root.findByProps({ 'data-fallback': 'true' }).type).toBe('svg');
    await act(async () => { view.unmount(); });
  });
  it('ignores a late icon response from an earlier version', async () => {
    let finish!: (src: string) => void;
    host.PluginIcon.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(<PluginLogo pluginId="test.late-version" name="Late" version="1.0.0" variant="toolbar" fallback={<svg />} />); });
    host.PluginIcon.mockResolvedValueOnce('data:image/png;base64,BBBB');
    await act(async () => { view.update(<PluginLogo pluginId="test.late-version" name="Late" version="2.0.0" variant="toolbar" fallback={<svg />} />); });
    await flush();
    expect(view.root.findByType('img').props.src).toBe('data:image/png;base64,BBBB');
    await act(async () => { finish('data:image/png;base64,AAAA'); });
    expect(view.root.findByType('img').props.src).toBe('data:image/png;base64,BBBB');
    await act(async () => { view.unmount(); });
  });

  it('renders the host-provided raster data URL', async () => {
    host.PluginIcon.mockResolvedValue('data:image/png;base64,AAAA');
    let view: ReturnType<typeof create> | undefined;
    await act(async () => { view = create(<PluginLogo pluginId="test.one" name="MongoShell" version="1.0.0" />); });
    await flush();
    const image = view!.root.findByType('img');
    expect(image.props.src).toBe('data:image/png;base64,AAAA');
    expect(image.props.alt).toBe('');
    view!.unmount();
  });

  it('falls back to the name monogram when no logo is declared', async () => {
    host.PluginIcon.mockResolvedValue('');
    let view: ReturnType<typeof create> | undefined;
    await act(async () => { view = create(<PluginLogo pluginId="test.two" name="華龍算力" version="1.0.0" />); });
    await flush();
    expect(view!.root.findByProps({ className: 'plugin-logo-monogram' }).props.children).toBe('華');
    expect(view!.root.findAllByType('img')).toHaveLength(0);
    view!.unmount();
  });

  it('keeps the monogram when the host call fails', async () => {
    host.PluginIcon.mockRejectedValue(new Error('runtime unavailable'));
    let view: ReturnType<typeof create> | undefined;
    await act(async () => { view = create(<PluginLogo pluginId="test.three" name="shell" version="1.0.0" />); });
    await flush();
    expect(view!.root.findByProps({ className: 'plugin-logo-monogram' }).props.children).toBe('S');
    view!.unmount();
  });

  it('retries an empty icon cache after the plugin becomes installed', async () => {
    host.PluginIcon.mockResolvedValueOnce('');
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(<PluginLogo pluginId="test.install-retry" name="Retry" version="1.0.0" installed={false} fallback={<svg data-fallback="true" />} />); });
    await flush();
    expect(view.root.findByProps({ 'data-fallback': 'true' }).type).toBe('svg');
    host.PluginIcon.mockResolvedValueOnce('data:image/png;base64,CCCC');
    await act(async () => { view.update(<PluginLogo pluginId="test.install-retry" name="Retry" version="1.0.0" installed fallback={<svg data-fallback="true" />} />); });
    await flush();
    expect(view.root.findByType('img').props.src).toBe('data:image/png;base64,CCCC');
    expect(host.PluginIcon).toHaveBeenCalledTimes(2);
    await act(async () => { view.unmount(); });
  });

  it('uses the remote market icon when the local plugin package has no logo', async () => {
    host.PluginIcon.mockResolvedValue('');
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(<PluginLogo pluginId="test.remote" name="Remote" version="1.0.0" remoteSrc="https://raw.githubusercontent.com/author/repo/HEAD/icon.png" fallback={<svg data-fallback="true" />} />); });
    await flush();
    expect(view.root.findByType('img').props.src).toBe('https://raw.githubusercontent.com/author/repo/HEAD/icon.png');
    expect(view.root.findByProps({ className: 'plugin-logo' }).props['data-loaded']).toBe('true');
    await act(async () => { view.unmount(); });
  });

  it('keeps the local plugin icon ahead of the remote market icon', async () => {
    host.PluginIcon.mockResolvedValue('data:image/png;base64,DDDD');
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(<PluginLogo pluginId="test.local-first" name="Local" version="1.0.0" remoteSrc="https://raw.githubusercontent.com/author/repo/HEAD/icon.png" fallback={<svg data-fallback="true" />} />); });
    await flush();
    expect(view.root.findByType('img').props.src).toBe('data:image/png;base64,DDDD');
    await act(async () => { view.unmount(); });
  });

  it('falls back when the remote market icon cannot be decoded', async () => {
    host.PluginIcon.mockResolvedValue('');
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(<PluginLogo pluginId="test.remote-broken" name="Broken" version="1.0.0" remoteSrc="https://raw.githubusercontent.com/author/repo/HEAD/icon.png" fallback={<svg data-fallback="true" />} />); });
    await flush();
    await act(async () => { view.root.findByType('img').props.onError(); });
    expect(view.root.findAllByType('img')).toHaveLength(0);
    expect(view.root.findByProps({ 'data-fallback': 'true' })).toBeTruthy();
    await act(async () => { view.unmount(); });
  });

  it('reuses the cached logo across mounts', async () => {
    host.PluginIcon.mockResolvedValue('data:image/png;base64,BBBB');
    let view: ReturnType<typeof create> | undefined;
    await act(async () => { view = create(<PluginLogo pluginId="test.cache" name="Cached" version="1.0.0" />); });
    await flush();
    view!.unmount();
    await act(async () => { view = create(<PluginLogo pluginId="test.cache" name="Cached" version="1.0.0" />); });
    await flush();
    expect(view!.root.findByType('img').props.src).toBe('data:image/png;base64,BBBB');
    expect(host.PluginIcon).toHaveBeenCalledTimes(1);
    view!.unmount();
  });

  it('tries remote market icon candidates in order', async () => {
    host.PluginIcon.mockResolvedValue('');
    const first = 'https://raw.githubusercontent.com/author/repo/HEAD/icons/icon.png';
    const second = 'https://raw.githubusercontent.com/author/repo/HEAD/icons/provider.png';
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(<PluginLogo pluginId="test.remote-candidates" name="Candidates" version="1.0.0" remoteSources={[first, second]} fallback={<svg data-fallback="true" />} />); });
    await flush();
    expect(view.root.findByType('img').props.src).toBe(first);
    await act(async () => { view.root.findByType('img').props.onError(); });
    expect(view.root.findByType('img').props.src).toBe(second);
    await act(async () => { view.unmount(); });
  });

  it('retries remote market icons after a short delay when the first attempt fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    host.PluginIcon.mockResolvedValue('');
    const remote = 'https://raw.githubusercontent.com/author/repo/HEAD/icon.png';
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(<PluginLogo pluginId="test.remote-delay" name="Delayed" version="1.0.0" remoteSources={[remote]} fallback={<svg data-fallback="true" />} />); });
    await flush();
    await act(async () => { view.root.findByType('img').props.onError(); });
    expect(view.root.findAllByType('img')).toHaveLength(0);
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(view.root.findByType('img').props.src).toBe(remote);
    await act(async () => { view.unmount(); });
    vi.useRealTimers();
  });

  it('retries a failed remote icon when the catalog is refreshed', async () => {
    host.PluginIcon.mockResolvedValue('');
    const remote = 'https://raw.githubusercontent.com/author/repo/HEAD/icon.png';
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(<PluginLogo pluginId="test.remote-refresh" name="Refresh" version="1.0.0" remoteSources={[remote]} retryKey="1:0" fallback={<svg data-fallback="true" />} />); });
    await flush();
    await act(async () => { view.root.findByType('img').props.onError(); });
    expect(view.root.findAllByType('img')).toHaveLength(0);
    await act(async () => { view.update(<PluginLogo pluginId="test.remote-refresh" name="Refresh" version="1.0.0" remoteSources={[remote]} retryKey="2:0" fallback={<svg data-fallback="true" />} />); });
    expect(view.root.findByType('img').props.src).toBe(remote);
    await act(async () => { view.unmount(); });
  });
});
