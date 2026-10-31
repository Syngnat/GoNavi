import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginInspection } from '../plugins/types';
const host = vi.hoisted(() => ({ PluginMarketSettings: vi.fn(), PluginMarketConfigure: vi.fn(), PluginMarketCatalog: vi.fn(),
  PluginMarketDetail: vi.fn(), PluginMarketRatings: vi.fn(),
  PluginMarketInstall: vi.fn(),
  PluginMarketInspect: vi.fn(), PluginMarketCancelInspection: vi.fn(), PluginMarketVersions: vi.fn(), PluginMarketSourceVersions: vi.fn() }));
vi.mock('../../wailsjs/go/app/App', () => host);
vi.mock('../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('antd', () => {
  const element = (name: string) => (props: React.HTMLAttributes<HTMLElement>) => React.createElement('div', { ...props, 'data-component': name });
  const Drawer = ({ children, footer, ...props }: React.PropsWithChildren<{ footer?: React.ReactNode }>) => React.createElement('div', { ...props, 'data-component': 'drawer' }, children, footer);
  return { Alert: element('alert'), Button: element('button'), Select: element('select'), Drawer, Modal: element('modal'), Spin: element('spin'), Tag: element('tag'),
    Typography: { Text: element('text'), Paragraph: element('paragraph') } };
});
vi.mock('@ant-design/icons', () => ({ SafetyCertificateOutlined: () => null }));
vi.mock('./MarketDetailOverview', () => ({ MarketDetailOverview: () => null }));
vi.mock('./MarketRatingsPanel', () => ({ MarketRatingsPanel: () => null }));
vi.mock('../components/pluginManager/PluginInstallPreview', () => ({ PluginInstallPreview: ({ inspection, allowed }: { inspection: PluginInspection; allowed: boolean }) =>
  <div data-testid="package-preview" data-permissions={inspection.manifest.permissions.join(',')} data-name={inspection.manifest.name} data-allowed={allowed} /> }));
import { MarketDetailDrawer } from './MarketDetailDrawer';
const sourceId = 'a'.repeat(64);
const artifactDigest = 'b'.repeat(64);
let renderer: ReturnType<typeof create> | undefined;
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; vi.resetAllMocks(); });
describe('market inspected-package consent', () => {
  it('previews permissions from downloaded package bytes, never advertised metadata', async () => {
    const advertised = { schemaVersion: 1, apiVersion: 1, id: 'test.hello', name: 'Advertised read-only', version: '1.0.0', permissions: ['database.read'] };
    const listing = { id: 'test.hello', name: 'Advertised read-only', description: '', author: '', publisherId: '', official: false,
      version: '1.0.0', platforms: [], ratingAverage: 0, ratingCount: 0, downloadCount: 0, updatedAt: 'now', sourceId,
      manifest: advertised, artifact: { sha256: artifactDigest, version: '1.0.0', url: '/artifact', sizeBytes: 32, platform: 'windows/amd64' } };
    host.PluginMarketDetail.mockResolvedValue({ success: true, data: listing });
    host.PluginMarketVersions.mockResolvedValue({ success: true, data: { versions: [{ plugin: listing, compatible: true }] } });
    host.PluginMarketRatings.mockResolvedValue({ success: true, data: [] });
    host.PluginMarketInspect.mockResolvedValue({ success: true, data: { sourceId, artifactDigest, approvalToken: 'opaque-one-use-token', expiresAt: new Date(Date.now() + 60000).toISOString(),
      inspection: { manifest: { ...advertised, name: 'Actual package', permissions: ['database.write', 'network'] }, digest: 'c'.repeat(64), sourcePath: '/staged/package.zip', sizeBytes: 32 } } });
    host.PluginMarketCancelInspection.mockResolvedValue({ success: true });
    await act(async () => { renderer = create(<MarketDetailDrawer id="test.hello" source="https://market.test" sourceId={sourceId} allowed trustedOfficial={false} onClose={vi.fn()} onInstalled={vi.fn()} />); });
    const review = renderer!.root.findAllByProps({ 'data-component': 'button' }).find((button) => button.children.includes('plugin.market.preview_install'))!;
    await act(async () => { review.props.onClick(); });
    const preview = renderer!.root.findByProps({ 'data-testid': 'package-preview' });
    expect(preview.props['data-permissions']).toBe('database.write,network');
    expect(preview.props['data-name']).toBe('Actual package');
    expect(host.PluginMarketInspect).toHaveBeenCalledWith('test.hello', '1.0.0', artifactDigest, sourceId);
    expect(host.PluginMarketInstall).not.toHaveBeenCalled();
  });
});
