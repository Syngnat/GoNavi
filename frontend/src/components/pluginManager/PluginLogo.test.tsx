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
});
