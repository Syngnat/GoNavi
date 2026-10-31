/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n/provider';
import type { PluginStatus } from '../../plugins/types';
import { invalidatePluginContributions } from '../../plugins/invalidation';
import { usePluginWindowTools } from './usePluginWindowTools';
import TitleBarQuickActions from '../TitleBarQuickActions';

const api = vi.hoisted(() => ({ list: vi.fn(), runtimeInfo: vi.fn(), openWindow: vi.fn(), updateWindowPreferences: vi.fn() }));
const iconHost = vi.hoisted(() => ({ PluginIcon: vi.fn() }));
vi.mock('../../../wailsjs/go/app/App', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), PluginIcon: iconHost.PluginIcon,
}));
const pageAPI = vi.hoisted(() => ({ pageCall: vi.fn(async () => null) }));
vi.mock('../../pluginPages/api', () => pageAPI);
vi.mock('../../plugins/api', () => ({ pluginAPI: api }));
vi.mock('../../i18n/runtime', () => ({ syncLanguageRuntime: vi.fn(async () => undefined) }));

// 顶栏只接受显式声明：pages + navigation(location=tools)。window 不再自动生成入口，
// 窗口插件继续从插件管理里打开。
const page = (id = 'workbench', title = 'Log2SQL') => ({ id, title, html: { source: '<textarea></textarea>' } });
const plugin = (id = 'example.tool', extra: Partial<PluginStatus> = {}): PluginStatus => ({
  manifest: {
    schemaVersion: 1, apiVersion: 1, id, name: id === 'example.tool' ? 'Log2SQL' : id, version: '1.0.0', permissions: [],
    contributes: { pages: [page()], navigation: [{ id: 'tools', title: 'Log2SQL', page: 'workbench', location: 'tools' }] },
  },
  digest: 'digest', generation: 1, state: 'running', desiredEnabled: true, installedAt: '', ...extra,
});

let root: Root;
let container: HTMLDivElement;
let actions: ReturnType<typeof usePluginWindowTools>;
function Probe() {
  actions = usePluginWindowTools();
  return <TitleBarQuickActions label="Tools" actions={actions} />;
}
async function mount() {
  await act(async () => {
    root.render(<I18nProvider preference="zh-CN" onPreferenceChange={() => undefined}><Probe /></I18nProvider>);
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  iconHost.PluginIcon.mockReset(); iconHost.PluginIcon.mockResolvedValue('');
  api.list.mockResolvedValue([plugin()]);
  api.runtimeInfo.mockResolvedValue({ safeMode: false, managementAllowed: true, webRuntime: false });
  api.openWindow.mockResolvedValue(undefined);
  api.updateWindowPreferences.mockResolvedValue(undefined);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); Reflect.deleteProperty(window, '__GONAVI_WEB_RUNTIME__'); vi.resetAllMocks(); });

describe('title bar plugin entries', () => {
  it('renders a separate installed plugin logo for each explicitly declared toolbar entry', async () => {
    const first = plugin('icons.page'); first.manifest.name = 'Page Icon'; first.manifest.icon = 'icons/page.png';
    const second = plugin('icons.window'); second.manifest.name = 'Window Icon'; second.manifest.icon = 'icons/window.png';
    second.manifest.window = { entry: 'index.html' };
    api.list.mockResolvedValue([first, second]);
    const sources: Record<string, string> = { 'icons.page': 'data:image/png;base64,AAAA', 'icons.window': 'data:image/png;base64,BBBB' };
    iconHost.PluginIcon.mockImplementation(async (id: string) => sources[id] ?? '');
    await mount();
    for (const item of [first, second]) {
      const image = container.querySelector<HTMLImageElement>(`button[aria-label="${item.manifest.name}"] img`);
      expect(image?.getAttribute('src')).toBe(sources[item.manifest.id]);
      expect(iconHost.PluginIcon).toHaveBeenCalledWith(item.manifest.id);
    }
    expect(actions).toHaveLength(2);
    expect(api.openWindow).not.toHaveBeenCalled();
  });
  it.each(['missing', 'unreadable'])('keeps the default icon when an explicitly declared entry logo is %s', async (mode) => {
    const item = plugin(`icons.${mode}`); item.manifest.name = 'Icon Fallback';
    api.list.mockResolvedValue([item]);
    if (mode === 'unreadable') iconHost.PluginIcon.mockRejectedValue(new Error('icon unavailable'));
    await mount();
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Icon Fallback"]');
    expect(button).not.toBeNull();
    expect(button?.querySelector('img')).toBeNull();
    expect(button?.querySelector('svg')).not.toBeNull();
    expect(iconHost.PluginIcon).toHaveBeenCalledWith(item.manifest.id);
  });
  it('lists a page the plugin explicitly attaches to the tools location', async () => {
    await mount();
    expect(actions).toHaveLength(1);
    expect(actions[0].label).toBe('Log2SQL');
    expect(api.openWindow).not.toHaveBeenCalled();
  });

  it('does not infer an entry from a declared page alone', async () => {
    const tool = plugin();
    tool.manifest.contributes = { pages: [page()] };
    api.list.mockResolvedValue([tool]);
    await mount();
    expect(actions).toHaveLength(0);
  });

  it('opens the declared window from a window-target navigation entry', async () => {
    const tool = plugin('example.ssh');
    tool.manifest.name = 'SSH';
    tool.manifest.permissions = [];
    tool.manifest.contributes = { navigation: [{ id: 'ssh', title: 'SSH', target: 'window', location: 'tools' }] };
    tool.manifest.window = { entry: 'index.html' };
    api.list.mockResolvedValue([tool]);
    await mount();
    expect(actions).toHaveLength(1);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="SSH"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(api.openWindow).toHaveBeenCalledWith('example.ssh', 'zh-CN', expect.anything());
  });

  it('hides a window-target entry in the web runtime', async () => {
    Reflect.set(window, '__GONAVI_WEB_RUNTIME__', { buildType: 'web' });
    const tool = plugin('example.ssh');
    tool.manifest.permissions = [];
    tool.manifest.contributes = { navigation: [{ id: 'ssh', title: 'SSH', target: 'window', location: 'tools' }] };
    tool.manifest.window = { entry: 'index.html' };
    api.list.mockResolvedValue([tool]);
    await mount();
    expect(actions).toHaveLength(0);
    expect(api.openWindow).not.toHaveBeenCalled();
  });

  it('does not infer an entry from a declared window', async () => {
    const windowTool = plugin('example.window');
    windowTool.manifest.contributes = undefined;
    windowTool.manifest.window = { entry: 'index.html' };
    api.list.mockResolvedValue([windowTool]);
    await mount();
    expect(actions).toHaveLength(0);
  });

  it('ignores a navigation entry that points at a page without content', async () => {
    const tool = plugin();
    tool.manifest.contributes = {
      pages: [{ id: 'empty', title: 'Empty' }],
      navigation: [{ id: 'tools', title: 'Empty', page: 'empty', location: 'tools' }],
    };
    api.list.mockResolvedValue([tool]);
    await mount();
    expect(actions).toHaveLength(0);
  });

  it('keeps one entry per plugin even when several are declared', async () => {
    const tool = plugin();
    tool.manifest.contributes = {
      pages: [page('b', 'Second'), page('a', 'First')],
      navigation: [
        { id: 'n2', title: 'Second', page: 'b', location: 'tools', order: 20 },
        { id: 'n1', title: 'First', page: 'a', location: 'tools', order: 10 },
      ],
    };
    api.list.mockResolvedValue([tool]);
    await mount();
    // 顶栏是「一插件一按钮」：同一插件声明多条时仍只出现一次。
    expect(actions).toHaveLength(1);
  });

  it.each(['safe', 'management'])('hides declared entries in %s mode', async (mode) => {
    api.runtimeInfo.mockResolvedValue({ safeMode: mode === 'safe', managementAllowed: mode !== 'management', webRuntime: false });
    await mount();
    expect(actions).toHaveLength(0);
  });

  it('drops an entry once the plugin stops running', async () => {
    await mount();
    expect(actions).toHaveLength(1);
    api.list.mockResolvedValue([plugin('example.tool', { state: 'disabled', desiredEnabled: false })]);
    await act(async () => { invalidatePluginContributions({ reason: 'root' }); });
    expect(actions).toHaveLength(0);
  });

  it('lists nothing when discovery fails', async () => {
    api.list.mockRejectedValue(new Error('boom'));
    await mount();
    expect(actions).toHaveLength(0);
  });
});
