import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MarketInspectionQuote, MarketInspectionRequest, MarketPlugin } from './types';
const host = vi.hoisted(() => ({ PluginMarketSettings: vi.fn(), PluginMarketConfigure: vi.fn(), PluginMarketCatalog: vi.fn(),
  PluginMarketDetail: vi.fn(), PluginMarketRatings: vi.fn(),
  PluginMarketInstall: vi.fn(),
  PluginMarketInspect: vi.fn(), PluginMarketCancelInspection: vi.fn() }));
vi.mock('../../wailsjs/go/app/App', () => host);
vi.mock('../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key, language: 'en-US' }) }));
vi.mock('@ant-design/icons', () => {
  const Icon = () => React.createElement('span');
  return { SafetyCertificateOutlined: Icon, CheckCircleFilled: Icon, CopyOutlined: Icon,
    AppstoreOutlined: Icon, DatabaseOutlined: Icon, RobotOutlined: Icon, ExportOutlined: Icon };
});
vi.mock('antd', () => {
  const element = (name: string) => (props: React.HTMLAttributes<HTMLElement>) => React.createElement('div', { ...props, 'data-component': name });
  return { Alert: element('alert'), Button: element('button'), Modal: element('modal'), Spin: element('spin'), Tag: element('tag'),
    Checkbox: element('checkbox'), Descriptions: element('descriptions'), Input: element('input'),
    Typography: { Text: element('text'), Title: element('title'), Paragraph: element('paragraph') } };
});
import { MarketInstallConsent } from './MarketInstallConsent';
const sourceId = 'a'.repeat(64);
const request: MarketInspectionRequest = { id: 'test.hello', version: '1.0.0', artifactDigest: 'b'.repeat(64), sourceId };
const plugin: MarketPlugin = { id: request.id, name: 'Market Hello', description: '', author: 'GoNavi', publisherId: 'com.gonavi',
  official: true, version: request.version, platforms: ['any'], ratingAverage: 0, ratingCount: 0, downloadCount: 0, updatedAt: 'now',
  sourceId, sourceUrl: 'https://github.com/gonavi/tool',
  artifact: { url: 'https://market.test/artifact', sha256: request.artifactDigest, sizeBytes: 12, platform: 'any', version: request.version } };
const quote: MarketInspectionQuote = { sourceId: request.sourceId, artifactDigest: request.artifactDigest, approvalToken: 'internal-token', expiresAt: new Date(Date.now() + 60000).toISOString(),
  inspection: { manifest: { schemaVersion: 1, apiVersion: 1, id: request.id, name: 'Actual package', version: request.version, permissions: ['database.write'] },
    digest: 'c'.repeat(64), sourcePath: '/staged/package', sizeBytes: 12 } };
const repository = 'https://github.com/gonavi/tool';
let renderer: ReturnType<typeof create> | undefined;
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; vi.resetAllMocks(); });
function ui(input = request, onClose = vi.fn()) { return <MarketInstallConsent request={input} plugin={plugin} source="https://market.test" trustedOfficial allowed onClose={onClose} onInstalled={vi.fn()} onInstallError={vi.fn()} />; }
describe('inspection consent presentation', () => {
  it('keeps close available and hides final trust/install while package inspection is pending', async () => {
    let resolve: (value: unknown) => void = () => {};
    host.PluginMarketInspect.mockImplementation(() => new Promise((done) => { resolve = done; }));
    host.PluginMarketCancelInspection.mockResolvedValue({ success: true });
    const close = vi.fn();
    await act(async () => { renderer = create(ui(request, close)); });
    expect(renderer!.root.findAllByProps({ 'data-component': 'checkbox' })).toHaveLength(0);
    const modal = renderer!.root.findByProps({ 'data-component': 'modal' });
    act(() => modal.props.onCancel());
    expect(close).toHaveBeenCalledOnce();
    await act(async () => { resolve({ success: true, data: quote }); });
    expect(host.PluginMarketCancelInspection).toHaveBeenCalledWith('internal-token');
    expect(host.PluginMarketInstall).not.toHaveBeenCalled();
  });
  it('requires a pasted repository address before replacing an installed plugin', async () => {
    host.PluginMarketInspect.mockResolvedValue({ success: true, data: quote });
    host.PluginMarketCancelInspection.mockResolvedValue({ success: true });
    host.PluginMarketInstall.mockResolvedValue({ success: true, data: { manifest: quote.inspection.manifest, digest: quote.inspection.digest, state: 'disabled', desiredEnabled: false, generation: 2, installedAt: '' } });
    const onInstalled = vi.fn();
    await act(async () => { renderer = create(<MarketInstallConsent request={request} plugin={plugin} source="https://market.test" trustedOfficial allowed replace onClose={vi.fn()} onInstalled={onInstalled} onInstallError={vi.fn()} />); });
    expect(host.PluginMarketInspect).toHaveBeenCalledWith(request.id, request.version, request.artifactDigest, request.sourceId);
    let modal = renderer!.root.findByProps({ 'data-component': 'modal' });
    expect(modal.props.okText).toBe('plugin.install.replace_confirm');
    expect(modal.props.okButtonProps.disabled).toBe(true);
    await act(async () => { modal.props.onOk(); });
    expect(host.PluginMarketInstall).not.toHaveBeenCalled();
    act(() => renderer!.root.findByProps({ 'data-component': 'input' }).props.onChange({ target: { value: repository } }));
    act(() => renderer!.root.findByProps({ 'data-component': 'checkbox' }).props.onChange({ target: { checked: true } }));
    modal = renderer!.root.findByProps({ 'data-component': 'modal' });
    expect(modal.props.okButtonProps.disabled).toBe(false);
    await act(async () => { modal.props.onOk(); });
    expect(host.PluginMarketInstall).toHaveBeenCalledWith(request.id, request.version, request.artifactDigest, true, quote.approvalToken);
    expect(onInstalled).toHaveBeenCalledOnce();
  });
  it('resets the typed repository and trust when a replacement quote arrives', async () => {
    const next = { ...request, sourceId: 'd'.repeat(64) };
    host.PluginMarketInspect.mockResolvedValueOnce({ success: true, data: quote })
      .mockResolvedValueOnce({ success: true, data: { ...quote, sourceId: next.sourceId, approvalToken: 'replacement-token' } });
    host.PluginMarketCancelInspection.mockResolvedValue({ success: true });
    await act(async () => { renderer = create(ui()); });
    act(() => renderer!.root.findByProps({ 'data-component': 'input' }).props.onChange({ target: { value: repository } }));
    act(() => renderer!.root.findByProps({ 'data-component': 'checkbox' }).props.onChange({ target: { checked: true } }));
    expect(renderer!.root.findByProps({ 'data-component': 'modal' }).props.okButtonProps.disabled).toBe(false);
    await act(async () => { renderer!.update(ui(next)); });
    expect(renderer!.root.findByProps({ 'data-component': 'checkbox' }).props.checked).toBe(false);
    expect(renderer!.root.findByProps({ 'data-component': 'input' }).props.value).toBe('');
    expect(renderer!.root.findByProps({ 'data-component': 'modal' }).props.okButtonProps.disabled).toBe(true);
    expect(host.PluginMarketCancelInspection).toHaveBeenCalledWith('internal-token');
  });
});
