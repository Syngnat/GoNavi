import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@ant-design/icons', () => ({ PlusOutlined: () => null, DeleteOutlined: () => null }));
vi.mock('antd', () => {
  const element = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('div', { ...props, 'data-component': name }, children);
  const Modal = ({ children, footer, ...props }: React.PropsWithChildren<{ footer?: React.ReactNode }>) => React.createElement('div', { ...props, 'data-component': 'modal' }, children, footer);
  return { Input: element('input'), Button: element('button'), Checkbox: element('checkbox'), Alert: element('alert'), Tag: element('tag'), Modal,
    Typography: { Paragraph: element('paragraph') } };
});
import { MarketSourceSettings } from './MarketSourceSettings';
const official = { baseUrl: 'https://plugin.gonavi.org', sourceId: 'a'.repeat(64), enabled: true, trustedOfficial: true };
const makeManager = () => ({ sources: [official], loading: false, busy: false, error: '', revision: 0, refresh: vi.fn(async () => {}), save: vi.fn(async () => true) });
let renderer: ReturnType<typeof create> | undefined;
const elements = (name: string) => renderer!.root.findAllByProps({ 'data-component': name });
const button = (key: string) => elements('button').find((node) => node.props.children === key)!;
async function mount(manager = makeManager(), allowed = true, onClose = vi.fn()) {
  await act(async () => { renderer = create(<MarketSourceSettings manager={manager} allowed={allowed} onClose={onClose} />); }); return { manager, onClose };
}
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; });
describe('multiple persistent source editor', () => {
  it('keeps the official address as a visible real read-only value without a remove action', async () => {
    await mount(); const input = elements('input')[0];
    expect(input.props.value).toBe('https://plugin.gonavi.org'); expect(input.props.readOnly).toBe(true);
    await act(async () => { input.props.onChange({ target: { value: 'https://forged.test' } }); });
    expect(elements('input')[0].props.value).toBe('https://plugin.gonavi.org');
    expect(elements('button').filter((node) => node.props.danger)).toHaveLength(0);
  });
  it('adds an enabled custom source and saves both rows', async () => {
    const { manager, onClose } = await mount();
    await act(async () => { button('plugin.market.sources_add').props.onClick(); });
    expect(elements('input')).toHaveLength(2); expect(elements('checkbox')[1].props.checked).toBe(true);
    await act(async () => { elements('input')[1].props.onChange({ target: { value: ' https://private.example ' } }); });
    await act(async () => { await button('plugin.market.sources_save').props.onClick(); });
    expect(manager.save).toHaveBeenCalledWith([{ baseUrl: official.baseUrl, enabled: true }, { baseUrl: 'https://private.example', enabled: true }]);
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('allows official opt-out without removing its address', async () => {
    const { manager } = await mount();
    await act(async () => { elements('checkbox')[0].props.onChange({ target: { checked: false } }); });
    await act(async () => { await button('plugin.market.sources_save').props.onClick(); });
    expect(manager.save).toHaveBeenCalledWith([{ baseUrl: official.baseUrl, enabled: false }]);
  });
  it('rejects duplicate endpoints and preserves unsaved rows', async () => {
    const { manager } = await mount();
    await act(async () => { button('plugin.market.sources_add').props.onClick(); });
    await act(async () => { elements('input')[1].props.onChange({ target: { value: official.baseUrl + '/api/v1/' } }); });
    expect(button('plugin.market.sources_save').props.disabled).toBe(true);
    await act(async () => { await button('plugin.market.sources_save').props.onClick(); }); expect(manager.save).not.toHaveBeenCalled();
    expect(elements('input')).toHaveLength(2);
  });
  it('keeps read-only settings non-mutating', async () => {
    const manager = makeManager(); await mount(manager, false);
    expect(button('plugin.market.sources_add').props.disabled).toBe(true); expect(elements('checkbox')[0].props.disabled).toBe(true);
    await act(async () => { button('plugin.market.sources_add').props.onClick(); await button('plugin.market.sources_save').props.onClick(); });
    expect(elements('input')).toHaveLength(1); expect(manager.save).not.toHaveBeenCalled();
  });
  it('removes a custom source without touching the official entry', async () => {
    const manager = makeManager(); manager.sources.push({ ...official, sourceId: 'b'.repeat(64), baseUrl: 'https://private.example', trustedOfficial: false });
    await mount(manager); await act(async () => { elements('button').find((node) => node.props.danger)!.props.onClick(); });
    expect(elements('input')).toHaveLength(1); await act(async () => { await button('plugin.market.sources_save').props.onClick(); });
    expect(manager.save).toHaveBeenCalledWith([{ baseUrl: official.baseUrl, enabled: true }]);
  });

});
