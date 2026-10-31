import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginStatus } from '../../plugins/types';
import type { MarketSource, MarketPlugin } from '../../pluginMarket/types';
import type { MarketVersionPage } from '../../pluginMarket/versionsApi';

const mocks = vi.hoisted(() => ({
  sources: vi.fn(), versions: vi.fn(), refresh: vi.fn(), install: vi.fn(),
  plugins: [] as PluginStatus[], allowed: true,
}));
vi.mock('../../i18n/provider', () => ({ useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) => key + (values ? ':' + JSON.stringify(values) : '') }) }));
vi.mock('../../plugins/usePluginManager', () => ({ usePluginManager: () => ({
  plugins: mocks.plugins, runtime: { managementAllowed: mocks.allowed, safeMode: false, webRuntime: false },
  loading: false, error: '', revoked: new Set(), busy: {}, refresh: mocks.refresh,
  setEnabled: vi.fn(), remove: vi.fn(),
}) }));
vi.mock('../../pluginMarket/sourceApi', () => ({ marketSourcesAPI: { list: mocks.sources } }));
vi.mock('../../pluginMarket/versionsApi', () => ({ loadMarketVersions: mocks.versions }));
vi.mock('../../pluginMarket/api', () => ({ marketAPI: { install: mocks.install } }));
vi.mock('../../pluginMarket/PluginMarketPanel', () => ({ PluginMarketPanel: () => null }));
vi.mock('./LocalInstallPanel', () => ({ LocalInstallPanel: () => null }));
vi.mock('./PluginLifecycleControls', () => ({ PluginLifecycleControls: () => null }));
vi.mock('./PluginCommandsPanel', () => ({ PluginCommandsPanel: () => null }));
vi.mock('./PluginPageList', () => ({ PluginPageList: () => null }));
vi.mock('../../pluginMarket/MarketDetailDrawer', () => ({ MarketDetailDrawer: (props: Record<string, unknown>) => <div data-market-details {...props} /> }));
vi.mock('@ant-design/icons', () => ({ ReloadOutlined: () => null }));
vi.mock('antd', () => {
  const element = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <div data-component={name} {...props}>{children}</div>;
  const Tabs = ({ items, activeKey }: { items: { key: string; children: React.ReactNode }[]; activeKey: string }) => <div>{items.find((x) => x.key === activeKey)?.children}</div>;
  return { Alert: element('alert'), Button: element('button'), Drawer: element('drawer'), Empty: Object.assign(element('empty'), { PRESENTED_IMAGE_SIMPLE: '' }), Pagination: element('pagination'), Spin: element('spin'), Tag: element('tag'), Tabs, Typography: { Title: element('title'), Text: element('text'), Paragraph: element('paragraph') } };
});
import { PluginManagerPanel } from './PluginManagerPanel';

const source: MarketSource = { sourceId: 'a'.repeat(64), baseUrl: 'https://market.test', trustedOfficial: true, enabled: true };
const installed: PluginStatus = { manifest: { schemaVersion: 1, apiVersion: 1, id: 'com.gonavi.mongo-shell', name: 'MongoShell', version: '1.0.1', permissions: [] }, state: 'running', desiredEnabled: true, generation: 1, installedAt: '', digest: 'b'.repeat(64) };
const remote: MarketPlugin = { id: installed.manifest.id, name: 'MongoShell', version: '1.0.2', description: '', author: 'GoNavi', publisherId: 'com.gonavi', official: true, platforms: ['darwin/arm64'], sourceId: source.sourceId, updatedAt: '', ratingAverage: 0, ratingCount: 0, downloadCount: 0, artifact: { version: '1.0.2', sha256: 'c'.repeat(64), sizeBytes: 100, platform: 'all', url: 'https://market.test/artifact' } };
let view: ReactTestRenderer | undefined;
const buttons = () => view!.root.findAllByProps({ 'data-component': 'button' });
const updateButton = () => buttons().find((b) => String(b.props.children).startsWith('plugin.update.action'));
async function mount() { await act(async () => { view = create(<PluginManagerPanel />); }); }
beforeEach(() => { vi.clearAllMocks(); mocks.allowed = true; mocks.plugins = [installed]; mocks.sources.mockResolvedValue([source]); mocks.versions.mockResolvedValue({ versions: [{ plugin: remote, compatible: true, reason: '' }] } satisfies MarketVersionPage); });
afterEach(() => { if (view) act(() => view!.unmount()); view = undefined; });

describe('installed plugin update discovery', () => {
  it('shows a newer marketplace version and opens only its source-bound review', async () => {
    await mount();
    expect(mocks.versions).toHaveBeenCalledWith(installed.manifest.id, source.sourceId, true);
    const button = updateButton();
    expect(button).toBeDefined();
    expect(button!.props.children).toContain('1.0.2');
    expect(button!.props.disabled).toBe(false);
    await act(async () => { button!.props.onClick(); });
    const detail = view!.root.findByProps({ 'data-market-details': true });
    expect(detail.props).toMatchObject({ id: installed.manifest.id, source: source.baseUrl, sourceId: source.sourceId, installedVersion: '1.0.1', initialVersion: '1.0.2', allowed: true, scoped: true, trustedOfficial: true });
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('shows no update for the installed version, older versions or incompatible releases', async () => {
    mocks.versions.mockResolvedValue({ versions: [
      { plugin: { ...remote, version: '1.0.1', artifact: { ...remote.artifact!, version: '1.0.1' } }, compatible: true, reason: '' },
      { plugin: remote, compatible: false, reason: 'host_version' },
    ] } satisfies MarketVersionPage);
    await mount();
    expect(updateButton()).toBeUndefined();
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('keeps update information visible but blocks installation in read-only management', async () => {
    mocks.allowed = false;
    await mount();
    expect(updateButton()!.props.disabled).toBe(true);
    await act(async () => { updateButton()!.props.onClick(); });
    expect(view!.root.findAllByProps({ 'data-market-details': true })).toHaveLength(0);
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('refresh checks market versions as well as the local list', async () => {
    await mount();
    await act(async () => { buttons().find((b) => b.props.children === 'plugin.action.refresh')!.props.onClick(); });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.versions).toHaveBeenCalledTimes(2);
  });
  it('keeps update review open when a failed install only requests a local refresh', async () => {
    await mount();
    await act(async () => { updateButton()!.props.onClick(); });
    await act(async () => { view!.root.findByProps({ 'data-market-details': true }).props.onInstalled(); });
    expect(view!.root.findAllByProps({ 'data-market-details': true })).toHaveLength(1);
    expect(updateButton()).toBeDefined();
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
  it('keeps failed-install review visible when the subsequent source refresh is offline', async () => {
    await mount();
    await act(async () => { updateButton()!.props.onClick(); });
    mocks.sources.mockRejectedValue(new Error('offline'));
    await act(async () => { view!.root.findByProps({ 'data-market-details': true }).props.onInstalled(); });
    expect(view!.root.findAllByProps({ 'data-market-details': true })).toHaveLength(1);
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('closes a source-bound review when its registered source is removed', async () => {
    await mount();
    await act(async () => { updateButton()!.props.onClick(); });
    mocks.sources.mockResolvedValue([]);
    await act(async () => { buttons().find((b) => b.props.children === 'plugin.update.check')!.props.onClick(); });
    expect(view!.root.findAllByProps({ 'data-market-details': true })).toHaveLength(0);
    expect(updateButton()).toBeUndefined();
  });
  it('closes a removed source review even if checking another source fails', async () => {
    await mount();
    await act(async () => { updateButton()!.props.onClick(); });
    mocks.sources.mockResolvedValue([{ ...source, sourceId: 'd'.repeat(64), baseUrl: 'https://another.test' }]);
    mocks.versions.mockRejectedValue(new Error('offline'));
    await act(async () => { buttons().find((b) => b.props.children === 'plugin.update.check')!.props.onClick(); });
    expect(view!.root.findAllByProps({ 'data-market-details': true })).toHaveLength(0);
  });
  it('closes update review and removes the badge after installation changes the local version', async () => {
    await mount();
    await act(async () => { updateButton()!.props.onClick(); });
    const detail = view!.root.findByProps({ 'data-market-details': true });
    mocks.plugins = [{ ...installed, manifest: { ...installed.manifest, version: '1.0.2' } }];
    await act(async () => { detail.props.onInstalled(); view!.update(<PluginManagerPanel />); });
    expect(updateButton()).toBeUndefined();
    expect(view!.root.findAllByProps({ 'data-market-details': true })).toHaveLength(0);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.install).not.toHaveBeenCalled();
  });
});
