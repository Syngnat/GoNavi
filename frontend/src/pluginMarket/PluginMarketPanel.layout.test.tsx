import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketSources } from './useMarketSources';
import type { MarketSource } from './types';
const state = vi.hoisted(() => ({ manager: {} as MarketSources }));
vi.mock('../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./useMarketSources', () => ({ useMarketSources: () => state.manager }));
vi.mock('./useInstalledPluginVersions', () => ({ useInstalledPluginVersions: () => ({ installed: new Map(), refresh: vi.fn() }) }));
vi.mock('./MarketSearchFilters', () => ({ MarketSearchFilters: (props: Record<string, unknown>) => <div data-panel="filters" {...props} /> }));
vi.mock('./MarketSourceSettings', () => ({ MarketSourceSettings: (props: Record<string, unknown>) => <div data-panel="settings" {...props} /> }));
vi.mock('./MarketDetailDrawer', () => ({ MarketDetailDrawer: (props: Record<string, unknown>) => <div data-panel="detail" {...props} /> }));
vi.mock('./MarketSourceGroup', () => ({ MarketSourceGroup: ({ onSelect, ...props }: { source: MarketSource; onSelect: (plugin: { id: string }, source: MarketSource) => void }) =>
  <button data-panel="group" {...props} onClick={() => onSelect({ id: 'test.same' }, props.source)} /> }));
vi.mock('antd', () => {
  const element = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('div', { ...props, 'data-component': name }, children);
  return { Alert: element('alert'), Button: element('button'), Input: { Search: element('search') }, Select: element('select'), Space: element('space'), Spin: element('spin'),
    Typography: { Text: element('text') } };
});
vi.mock('@ant-design/icons', () => ({ ReloadOutlined: () => null, SettingOutlined: () => null }));
import { PluginMarketPanel } from './PluginMarketPanel';
const a: MarketSource = { sourceId: 'a'.repeat(64), baseUrl: 'https://plugin.gonavi.org', enabled: true, trustedOfficial: true };
const b: MarketSource = { sourceId: 'b'.repeat(64), baseUrl: 'https://private.example', enabled: true, trustedOfficial: false };
let renderer: ReturnType<typeof create> | undefined;
const elements = (name: string) => renderer!.root.findAllByProps({ 'data-component': name });
const groups = () => renderer!.root.findAllByProps({ 'data-panel': 'group' });
async function mount(allowed = true) { await act(async () => { renderer = create(<PluginMarketPanel allowed={allowed} onInstalled={vi.fn()} />); }); }
beforeEach(() => { state.manager = { sources: [a, b, { ...b, sourceId: 'c'.repeat(64), enabled: false }], loading: false, busy: false, error: '', revision: 0, refresh: vi.fn(), save: vi.fn() }; });
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; });
describe('aggregated market workspace', () => {
  it('renders only enabled sources as independent groups', async () => {
    await mount(); expect(groups().map((node) => node.props.source.sourceId)).toEqual([a.sourceId, b.sourceId]);
  });
  it('applies search and sort to every group', async () => {
    await mount(); await act(async () => { elements('search')[0].props.onChange({ target: { value: 'nginx' } }); elements('select')[0].props.onChange('rating'); });
    for (const group of groups()) { expect(group.props.query).toBe('nginx'); expect(group.props.sort).toBe('rating'); }
  });
  it('does not merge identical plugin IDs from different sources', async () => {
    await mount(); await act(async () => { groups()[0].props.onClick(); });
    expect(renderer!.root.findByProps({ 'data-panel': 'detail' }).props.sourceId).toBe(a.sourceId);
    await act(async () => { renderer!.root.findByProps({ 'data-panel': 'detail' }).props.onClose(); groups()[1].props.onClick(); });
    expect(renderer!.root.findByProps({ 'data-panel': 'detail' }).props.sourceId).toBe(b.sourceId);
    expect(renderer!.root.findByProps({ 'data-panel': 'detail' }).props.scoped).toBe(true);
  });
  it('refreshes saved metadata and independently reloads all groups', async () => {
    await mount(); const revision = groups()[0].props.revision;
    const refresh = elements('button').find((node) => node.props.children === 'plugin.action.refresh')!;
    await act(async () => { refresh.props.onClick(); });
    expect(state.manager.refresh).toHaveBeenCalledOnce(); for (const group of groups()) expect(group.props.revision).toBe(revision + 1);
  });
  it('keeps source settings visible in read-only mode but disallows editing', async () => {
    await mount(false); const settings = elements('button').find((node) => node.props.children === 'plugin.market.source')!;
    await act(async () => { settings.props.onClick(); }); expect(renderer!.root.findByProps({ 'data-panel': 'settings' }).props.allowed).toBe(false);
  });
  it('shows an explicit disabled-all state without requesting source groups', async () => {
    state.manager.sources = [{ ...a, enabled: false }]; await mount(); expect(groups()).toHaveLength(0);
    expect(elements('alert')[0].props.message).toBe('plugin.market.sources_none_enabled');
  });
  it('changes browsing source scope without changing saved opt-in and resets every condition', async () => {
    await mount(); const panel = renderer!.root.findByProps({ 'data-panel': 'filters' });
    await act(async () => { panel.props.onChange({ ...panel.props.value, sourceIds: [b.sourceId], categories: ['ops'], platforms: ['all'], official: 'community', author: 'Team' }); });
    expect(groups()).toHaveLength(1); expect(groups()[0].props.source.sourceId).toBe(b.sourceId);
    expect(groups()[0].props.filters.categories).toEqual(['ops']); expect(state.manager.sources[0].enabled).toBe(true);
    await act(async () => { renderer!.root.findByProps({ 'data-panel': 'filters' }).props.onReset(); });
    expect(groups()).toHaveLength(2); expect(groups()[0].props.filters.author).toBe(''); expect(groups()[0].props.filters.platforms).toEqual([]);
  });

});
