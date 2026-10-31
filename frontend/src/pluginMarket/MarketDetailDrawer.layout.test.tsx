import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketPlugin } from './types';
const state = vi.hoisted(() => ({ plugin: null as MarketPlugin | null, loading: false, error: '', compatible: true }));
vi.mock('../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./useMarketDetail', () => ({ useMarketDetail: () => ({ ...state, ratings: [], load: vi.fn() }) }));
vi.mock('./useMarketVersions', () => ({ useMarketVersions: () => { const selected = state.plugin ? { plugin: state.plugin, compatible: state.compatible, reason: state.compatible ? '' : 'host_version' } : undefined; return { versions: selected ? [selected] : [], selected, selectedVersion: state.plugin?.version, recommended: state.plugin?.version, loading: false, error: '', warning: '', choose: vi.fn(), reload: vi.fn() }; } }));
vi.mock('./MarketInstallConsent', () => ({ MarketInstallConsent: (props: Record<string, unknown>) => <div data-panel="consent" {...props} /> }));
vi.mock('./MarketRatingsPanel', () => ({ MarketRatingsPanel: (props: Record<string, unknown>) => <div data-panel="ratings" {...props} /> }));
vi.mock('@ant-design/icons', () => ({ AppstoreOutlined: () => null, StarOutlined: () => null, DownloadOutlined: () => null, SafetyCertificateOutlined: () => null }));
vi.mock('antd', () => {
  const element = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('div', { ...props, 'data-component': name }, children);
  const Drawer = ({ children, footer, ...props }: React.PropsWithChildren<{ footer?: React.ReactNode }>) => React.createElement('div', { ...props, 'data-component': 'drawer' }, children, React.createElement('footer', { 'data-slot': 'footer' }, footer));
  return { Alert: element('alert'), Button: element('button'), Select: element('select'), Checkbox: element('checkbox'), Modal: element('modal'), Drawer, Spin: element('spin'), Tag: element('tag'), Rate: element('rate'),
    Typography: { Text: element('text'), Title: element('title'), Paragraph: element('paragraph') } };
});
import { MarketDetailDrawer } from './MarketDetailDrawer';
const sourceId = 'a'.repeat(64);
const plugin: MarketPlugin = { id: 'test.nginx', name: 'Nginx Inspector', author: 'GoNavi', publisherId: 'publisher', description: 'Read-only diagnostics', official: true,
  version: '1.0.0', minHostVersion: '1.1.5', platforms: ['windows/amd64', 'darwin/arm64'], ratingAverage: 0, ratingCount: 0, downloadCount: 12, updatedAt: 'now', sourceId,
  artifact: { version: '1.0.0', sha256: 'b'.repeat(64), url: 'https://market.test/artifact', sizeBytes: 128, platform: 'windows/amd64' } };
let renderer: ReturnType<typeof create> | undefined;
const elements = (name: string) => renderer!.root.findAllByProps({ 'data-component': name });
async function mount(allowed = true, trustedOfficial = true, installedVersion?: string) { await act(async () => { renderer = create(<MarketDetailDrawer id={plugin.id} source="https://market.test" sourceId={sourceId} scoped
  installedVersion={installedVersion} allowed={allowed} trustedOfficial={trustedOfficial} onClose={vi.fn()} onInstalled={vi.fn()} />); }); }
beforeEach(() => { state.plugin = { ...plugin }; state.loading = false; state.error = ''; state.compatible = true; });
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; });
describe('market detail visual structure', () => {
  it('uses an isolated drawer shell and persistent install footer', async () => {
    await mount(); const drawer = elements('drawer')[0];
    expect(drawer.props.rootClassName).toBe('plugin-market-detail'); expect(renderer!.root.findByProps({ 'data-slot': 'footer' }).findByProps({ className: 'market-detail-actions' })).toBeTruthy();
    const platforms = renderer!.root.findByProps({ className: 'market-detail-platforms' }).findAllByProps({ 'data-component': 'tag' });
    expect(platforms).toHaveLength(2);
    expect(platforms.every((tag) => tag.props.className === 'market-detail-platform-badge')).toBe(true);
    expect(renderer!.root.findByProps({ className: 'market-detail-source' }).props.children).toBe('https://market.test');
  });
  it('disables the install action when the selected version is already installed', async () => {
    await mount(true, true, plugin.version);
    const button = elements('button').find((node) => node.props.children === 'plugin.market.versions.installed')!;
    expect(button.props.disabled).toBe(true);
  });
  it('opens only a source-bound permission inspection, not direct installation', async () => {
    await mount(); await act(async () => { elements('button').find((node) => node.props.children === 'plugin.market.preview_install')!.props.onClick(); });
    expect(renderer!.root.findByProps({ 'data-panel': 'consent' }).props.request).toEqual({ id: plugin.id, version: plugin.version, artifactDigest: plugin.artifact!.sha256, sourceId, sizeBytes: plugin.artifact!.sizeBytes });
  });
  it('labels an upgrade and passes replacement consent without direct installation', async () => {
    await mount(true, true, '0.9.0');
    const update = elements('button').find((node) => node.props.children === 'plugin.update.action')!;
    expect(update.props.disabled).toBe(false);
    await act(async () => { update.props.onClick(); });
    const consent = renderer!.root.findByProps({ 'data-panel': 'consent' });
    expect(consent.props.replace).toBe(true);
    expect(consent.props.request).toEqual({ id: plugin.id, version: plugin.version, artifactDigest: plugin.artifact!.sha256, sourceId, sizeBytes: plugin.artifact!.sizeBytes });
  });
  it.each(['readonly', 'missing artifact', 'foreign source'])('preserves the %s install restriction', async (mode) => {
    if (mode === 'missing artifact') state.plugin!.artifact = undefined;
    if (mode === 'foreign source') state.plugin!.sourceId = 'c'.repeat(64);
    await mount(mode !== 'readonly'); expect(elements('button').find((node) => node.props.children === 'plugin.market.preview_install')!.props.disabled).toBe(true);
    expect(renderer!.root.findByProps({ 'data-panel': 'ratings' }).props.websiteURL).toBe('https://market.test/plugins/test.nginx');
  });
  it('keeps incompatible versions non-installable', async () => { state.compatible = false; await mount(); expect(elements('button').find((node) => node.props.children === 'plugin.market.preview_install')!.props.disabled).toBe(true); });
  it('requires an acknowledged downgrade before opening package inspection', async () => {
    await mount(true, true, '2.0.0');
    await act(async () => { elements('button').find((node) => node.props.children === 'plugin.market.preview_install')!.props.onClick(); });
    expect(elements('modal')[0].props.okButtonProps.disabled).toBe(true);
    act(() => elements('modal')[0].props.onOk());
    expect(renderer!.root.findAllByProps({ 'data-panel': 'consent' })).toHaveLength(0);
    act(() => elements('checkbox')[0].props.onChange({ target: { checked: true } }));
    expect(elements('modal')[0].props.okButtonProps.disabled).toBe(false);
    act(() => elements('modal')[0].props.onOk());
    expect(renderer!.root.findByProps({ 'data-panel': 'consent' }).props.request.version).toBe('1.0.0');
  });
  it('never promotes private-source official claims', async () => {
    await mount(true, false); expect(elements('tag').some((node) => node.props.children === 'plugin.market.official')).toBe(false);
  });
});
