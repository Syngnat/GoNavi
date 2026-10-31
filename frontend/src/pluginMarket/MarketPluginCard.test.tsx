import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('antd', () => {
  const element = (name: string) => (props: React.HTMLAttributes<HTMLElement>) => React.createElement('div', { ...props, 'data-component': name });
  return { Button: element('button'), Rate: element('rate'), Tag: element('tag'), Typography: { Title: element('title'), Paragraph: element('paragraph') } };
});
vi.mock('@ant-design/icons', () => ({ ArrowUpOutlined: () => null, SafetyCertificateOutlined: () => null }));
import { MarketPluginCard } from './MarketPluginCard';
import type { MarketPlugin } from './types';

const plugin: MarketPlugin = {
  id: 'gh-author.tool', name: 'Tool', description: '', author: '', publisherId: 'gh-author', official: false,
  version: '1.1.0', platforms: ['any'], ratingAverage: 0, ratingCount: 0, downloadCount: 0, updatedAt: 'now',
};
let renderer: ReturnType<typeof create> | undefined;
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; });
const tags = () => renderer!.root.findAllByProps({ 'data-component': 'tag' });

describe('market plugin card update badges', () => {
  it('shows no badge when the plugin is not installed locally', async () => {
    await act(async () => { renderer = create(<MarketPluginCard plugin={plugin} onSelect={vi.fn()} />); });
    expect(tags()).toHaveLength(0);
  });

  it('shows the installed version when it matches the market version', async () => {
    await act(async () => { renderer = create(<MarketPluginCard plugin={plugin} installedVersion="1.1.0" onSelect={vi.fn()} />); });
    const badge = tags().find((tag) => String(tag.children).includes('plugin.market.installed_version'));
    expect(badge).toBeTruthy();
  });

  it('flags an upgrade when the market version is newer than the installed one', async () => {
    await act(async () => { renderer = create(<MarketPluginCard plugin={plugin} installedVersion="1.0.0" onSelect={vi.fn()} />); });
    const upgrade = tags().find((tag) => tag.props.className === 'plugin-market-upgrade');
    expect(upgrade).toBeTruthy();
    expect(upgrade!.props.color).toBe('processing');
  });
  it('does not claim the installed ID came from the displayed source', async () => {
    await act(async () => { renderer = create(<MarketPluginCard plugin={plugin} installedVersion="1.0.0" sourceScoped onSelect={vi.fn()} />); });
    expect(tags().some((tag) => String(tag.children).includes('plugin.market.installed_identity'))).toBe(true);
    expect(tags().some((tag) => tag.props.className === 'plugin-market-upgrade')).toBe(false);
  });

});
