import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { MarketPlugin, MarketSource } from './types';

vi.mock('antd', () => {
  const element = (name: string) => (props: Record<string, unknown>) => React.createElement('div', { ...props, 'data-component': name });
  return {
    Alert: element('alert'), Descriptions: element('descriptions'),
    Button: ({ icon, ...props }: { icon?: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) =>
      React.createElement('button', { ...props, 'data-component': 'button' }),
    Modal: ({ title, children, footer, styles }: { title?: React.ReactNode; children?: React.ReactNode; footer?: React.ReactNode; styles?: unknown }) =>
      React.createElement('div', { 'data-component': 'modal', 'data-styles': styles }, title, children, footer),
  };
});
vi.mock('@ant-design/icons', () => ({ SafetyCertificateOutlined: () => null }));
vi.mock('../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./MarketPluginInstallConsent', () => ({
  MarketPluginInstallConsent: (props: { request: { sourceId: string }; source: { sourceId: string } }) =>
    React.createElement('div', { 'data-component': 'consent', 'data-source-id': props.source.sourceId, 'data-request': JSON.stringify(props.request) }),
}));
vi.mock('./MarketDetailOverview', () => ({ MarketDetailOverview: () => React.createElement('div', { 'data-component': 'overview' }) }));
vi.mock('./MarketDowngradeConfirm', () => ({ MarketDowngradeConfirm: (props: { onConfirm: () => void }) =>
  React.createElement('div', { 'data-component': 'downgrade' }, React.createElement('button', { 'data-component': 'downgrade-confirm', onClick: props.onConfirm })) }));
import { MarketPluginInstallModal } from './MarketPluginInstallModal';
import { installModalContentMaxHeight, installModalStyles } from '../utils/installModalLayout';

const sourceId = 'a'.repeat(64);
const source: MarketSource = { baseUrl: 'https://market.example', enabled: true, sourceId, trustedOfficial: true };
const plugin: MarketPlugin = {
  id: 'com.gonavi.tool', name: 'Tool', description: '', author: 'GoNavi', publisherId: 'com.gonavi', official: true,
  version: '1.2.3', platforms: ['any'], ratingAverage: 0, ratingCount: 0, downloadCount: 0, updatedAt: 'now',
  sourceId, artifact: { url: 'https://market.example/artifact', sha256: 'b'.repeat(64), sizeBytes: 1024, platform: 'any', version: '1.2.3' },
};

function installButton(view: ReturnType<typeof create>) {
  return view.root.findAllByProps({ 'data-component': 'button' })
    .find((button) => String(button.children).includes('plugin.market.install_confirm'));
}

describe('market plugin install modal', () => {
  it('shows plugin information before starting the inspected install', async () => {
    let view: ReturnType<typeof create> | undefined;
    await act(async () => { view = create(<MarketPluginInstallModal plugin={plugin} source={source} allowed onClose={vi.fn()} onInstalled={vi.fn()} />); });
    expect(view!.root.findByProps({ 'data-component': 'overview' })).toBeTruthy();
    expect(view!.root.findAllByProps({ 'data-component': 'consent' })).toHaveLength(0);
    const button = installButton(view!);
    expect(button).toBeTruthy();
    expect(button!.props.disabled).toBe(false);
    act(() => button!.props.onClick());
    const consent = view!.root.findByProps({ 'data-component': 'consent' });
    expect(consent.props['data-source-id']).toBe(sourceId);
    expect(JSON.parse(consent.props['data-request'])).toMatchObject({ id: plugin.id, version: plugin.version,
      artifactDigest: plugin.artifact!.sha256, sourceId, sizeBytes: plugin.artifact!.sizeBytes });
    view!.unmount();
  });

  it('caps the information dialog and scrolls long content inside the body', async () => {
    let view: ReturnType<typeof create> | undefined;
    await act(async () => { view = create(<MarketPluginInstallModal plugin={plugin} source={source} allowed onClose={vi.fn()} onInstalled={vi.fn()} />); });
    const modal = view!.root.findByProps({ 'data-component': 'modal' });
    expect(modal.props['data-styles']).toBe(installModalStyles);
    expect(modal.props['data-styles'].content.maxHeight).toBe(installModalContentMaxHeight);
    expect(modal.props['data-styles'].body).toMatchObject({ minHeight: 0, overflowY: 'auto' });
    expect(modal.props['data-styles'].body.maxHeight).toBeUndefined();
    view!.unmount();
  });

  it('cannot start without an artifact or with a mismatched source', async () => {
    for (const candidate of [{ ...plugin, artifact: undefined }, { ...plugin, sourceId: 'c'.repeat(64) }]) {
      let view: ReturnType<typeof create> | undefined;
      await act(async () => { view = create(<MarketPluginInstallModal plugin={candidate} source={source} allowed onClose={vi.fn()} onInstalled={vi.fn()} />); });
      expect(installButton(view!)!.props.disabled).toBe(true);
      view!.unmount();
    }
  });

  it('keeps the explicit downgrade confirmation before inspection', async () => {
    let view: ReturnType<typeof create> | undefined;
    await act(async () => { view = create(<MarketPluginInstallModal plugin={plugin} source={source} allowed installedVersion="9.0.0" onClose={vi.fn()} onInstalled={vi.fn()} />); });
    act(() => installButton(view!)!.props.onClick());
    expect(view!.root.findByProps({ 'data-component': 'downgrade' })).toBeTruthy();
    expect(view!.root.findAllByProps({ 'data-component': 'consent' })).toHaveLength(0);
    act(() => view!.root.findByProps({ 'data-component': 'downgrade-confirm' }).props.onClick());
    expect(view!.root.findByProps({ 'data-component': 'consent' })).toBeTruthy();
    view!.unmount();
  });

  it('cannot repeat the installed version or bypass read-only mode', async () => {
    let view: ReturnType<typeof create> | undefined;
    await act(async () => { view = create(<MarketPluginInstallModal plugin={plugin} source={source} allowed installedVersion={plugin.version} onClose={vi.fn()} onInstalled={vi.fn()} />); });
    expect(installButton(view!)!.props.disabled).toBe(true);
    view!.unmount();
    await act(async () => { view = create(<MarketPluginInstallModal plugin={plugin} source={source} allowed={false} onClose={vi.fn()} onInstalled={vi.fn()} />); });
    expect(installButton(view!)!.props.disabled).toBe(true);
    view!.unmount();
  });
});
