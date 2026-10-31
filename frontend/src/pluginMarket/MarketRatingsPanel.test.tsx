import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MarketRating } from './types';
const runtime = vi.hoisted(() => ({ BrowserOpenURL: vi.fn() }));
vi.mock('../../wailsjs/runtime', () => runtime);
vi.mock('../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@ant-design/icons', () => ({ ExportOutlined: () => null }));
vi.mock('antd', () => {
  const element = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('div', { ...props, 'data-component': name }, children);
  return { Button: element('button'), Pagination: element('pagination'), Rate: element('rate'), Typography: { Title: element('title'), Text: element('text') } };
});
import { MarketRatingsPanel } from './MarketRatingsPanel';
let renderer: ReturnType<typeof create> | undefined;
const elements = (name: string) => renderer!.root.findAllByProps({ 'data-component': name });
async function mount(ratings: MarketRating[] = []) { await act(async () => { renderer = create(<MarketRatingsPanel ratings={ratings} websiteURL="https://market.test/plugins/test.nginx" />); }); }
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; vi.clearAllMocks(); });
describe('desktop ratings are read-only', () => {
  it('offers website navigation instead of login, rating or publishing controls', async () => {
    await mount(); expect(renderer!.root.findAllByType('textarea')).toHaveLength(0);
    expect(elements('button')).toHaveLength(1); const link = elements('button')[0];
    expect(link.props.children).toBe('plugin.market.open_website'); expect(link.props.href).toBe('https://market.test/plugins/test.nginx');
    expect(link.props.rel).toContain('noopener');
  });
  it('opens only the source-bound website when clicked', async () => {
    await mount(); const preventDefault = vi.fn(); await act(async () => { elements('button')[0].props.onClick({ preventDefault }); });
    expect(preventDefault).toHaveBeenCalledOnce(); expect(runtime.BrowserOpenURL).toHaveBeenCalledWith('https://market.test/plugins/test.nginx');
  });
  it('retains disabled public stars and ten-review pagination', async () => {
    const ratings = Array.from({ length: 11 }, (_, i) => ({ userId: 'user-' + i, pluginId: 'test.nginx', stars: 4, body: 'Review', version: '1.0.0', updatedAt: 'now' }));
    await mount(ratings); expect(renderer!.root.findAllByProps({ className: 'market-detail-rating' })).toHaveLength(10);
    expect(elements('rate').every((node) => node.props.disabled && !node.props.onChange)).toBe(true);
    await act(async () => { elements('pagination')[0].props.onChange(2); }); expect(renderer!.root.findAllByProps({ className: 'market-detail-rating' })).toHaveLength(1);
  });
});
