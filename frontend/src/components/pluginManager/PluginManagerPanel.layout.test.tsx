import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginManagerState } from '../../plugins/usePluginManager';
const state = vi.hoisted(() => ({ manager: {} as PluginManagerState }));
vi.mock('../../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../../plugins/usePluginManager', () => ({ usePluginManager: () => state.manager }));
vi.mock('../../pluginMarket/useInstalledPluginUpdates', () => ({ useInstalledPluginUpdates: () => ({ updates: new Map(), sources: [], loading: false, checked: false, failed: false, reload: vi.fn() }) }));
vi.mock('../../pluginMarket/PluginMarketPanel', () => ({ PluginMarketPanel: () => <div data-panel="market" /> }));
vi.mock('./LocalInstallPanel', () => ({ LocalInstallPanel: ({ allowed }: { allowed: boolean }) => <div data-panel="local" data-allowed={allowed} /> }));
vi.mock('./PluginCard', () => ({ PluginCard: ({ plugin }: { plugin: { manifest: { id: string } } }) => <article data-plugin-id={plugin.manifest.id} /> }));
vi.mock('@ant-design/icons', () => ({ ReloadOutlined: () => null }));
vi.mock('antd', () => {
  const element = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('div', { ...props, 'data-component': name }, children);
  const Tabs = ({ items, activeKey, ...props }: { items: { key: string; children: React.ReactNode }[]; activeKey?: string; [key: string]: unknown }) =>
    React.createElement('div', { ...props, activeKey, 'data-component': 'tabs' }, items.find((item) => item.key === (activeKey ?? items[0].key))?.children);
  return { Alert: element('alert'), Button: element('button'), Empty: Object.assign(element('empty'), { PRESENTED_IMAGE_SIMPLE: 'simple' }),
    Pagination: element('pagination'), Spin: element('spin'), Tag: element('tag'), Tabs,
    Typography: { Title: element('title'), Paragraph: element('paragraph'), Text: element('text') } };
});
import { PluginManagerPanel } from './PluginManagerPanel';
let renderer: ReturnType<typeof create> | undefined;
const elements = (name: string) => renderer!.root.findAllByProps({ 'data-component': name });
async function mount() { await act(async () => { renderer = create(<PluginManagerPanel />); }); }
beforeEach(() => { state.manager = { plugins: [], runtime: { safeMode: false, managementAllowed: true, webRuntime: false }, loading: false,
  error: '', busy: {}, revoked: new Set(), refresh: vi.fn(), setEnabled: vi.fn(), remove: vi.fn() }; });
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; });
describe('plugin library layout', () => {
  it('uses explicitly compact, scoped tabs and a two-section installed layout', async () => {
    await mount();
    expect(elements('tabs')[0].props.tabBarGutter).toBe(0);
    expect(elements('tabs')[0].props.className).toBe('plugin-manager-tabs');
    expect(renderer!.root.findByProps({ className: 'plugin-installed-layout' })).toBeTruthy();
    expect(elements('empty')[0].props.image).toBe('simple');
  });
  it('places installed plugins in a dedicated card grid, not the library stack', async () => {
    state.manager.plugins = [{ manifest: { id: 'test.card' } }] as PluginManagerState['plugins'];
    await mount();
    const grid = renderer!.root.findByProps({ className: 'plugin-installed-grid' });
    expect(grid.findAllByType('article')).toHaveLength(1);
    expect(grid.parent?.props.className).toBe('plugin-library plugin-stack');
  });
  it('opens the market directly from the empty library', async () => {
    await mount();
    const browse = elements('button').find((button) => button.props.children === 'plugin.market.title')!;
    await act(async () => { browse.props.onClick(); });
    expect(elements('tabs')[0].props.activeKey).toBe('market');
    expect(renderer!.root.findByProps({ 'data-panel': 'market' })).toBeTruthy();
  });
  it('preserves local-install read-only restrictions and the refresh action', async () => {
    state.manager.runtime.managementAllowed = false; await mount();
    expect(renderer!.root.findByProps({ 'data-panel': 'local' }).props['data-allowed']).toBe(false);
    const refresh = elements('button').find((button) => button.props.children === 'plugin.action.refresh')!;
    await act(async () => { refresh.props.onClick(); });
    expect(state.manager.refresh).toHaveBeenCalledOnce();
  });
  it.each(['loading', 'error'] as const)('does not show the empty library while %s', async (mode) => {
    if (mode === 'loading') state.manager.loading = true; else state.manager.error = 'offline';
    await mount(); expect(elements('empty')).toHaveLength(0);
  });
});
