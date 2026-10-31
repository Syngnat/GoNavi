import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyMarketFilters } from './catalogFilters';
vi.mock('../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@ant-design/icons', () => ({ ClearOutlined: () => null }));
vi.mock('antd', () => {
  const element = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('div', { ...props, 'data-component': name }, children);
  return { Button: element('button'), Input: element('input'), Select: element('select') };
});
import { MarketSearchFilters } from './MarketSearchFilters';
let renderer: ReturnType<typeof create> | undefined;
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; });
describe('multi-condition controls', () => {
  it('exposes labeled source/category/identity/platform/author fields and current-platform default', async () => {
    const changed = vi.fn(); const reset = vi.fn();
    await act(async () => { renderer = create(<MarketSearchFilters sources={[]} value={emptyMarketFilters()} onChange={changed} onReset={reset} />); });
    const selects = renderer!.root.findAllByProps({ 'data-component': 'select' }); expect(selects).toHaveLength(4);
    expect(selects.find((node) => node.props['aria-label'] === 'plugin.market.filter_platforms')!.props.value).toEqual(['current']);
    await act(async () => { selects.find((node) => node.props['aria-label'] === 'plugin.market.filter_categories')!.props.onChange(['ops', 'skill']); });
    expect(changed).toHaveBeenCalledWith({ ...emptyMarketFilters(), categories: ['ops', 'skill'] });
    await act(async () => { renderer!.root.findByProps({ 'data-component': 'input' }).props.onChange({ target: { value: 'Publisher' } }); });
    expect(changed).toHaveBeenLastCalledWith({ ...emptyMarketFilters(), author: 'Publisher' });
    await act(async () => { renderer!.root.findByProps({ 'data-component': 'button' }).props.onClick(); }); expect(reset).toHaveBeenCalledOnce();
  });
});
