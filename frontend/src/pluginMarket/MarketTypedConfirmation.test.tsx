import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('antd', () => {
  const element = (name: string) => (props: React.HTMLAttributes<HTMLElement>) => React.createElement('div', { ...props, 'data-component': name });
  return {
    Button: element('button'),
    Checkbox: element('checkbox'),
    Input: element('input'),
    Typography: { Title: element('title'), Text: element('text') },
  };
});
vi.mock('@ant-design/icons', () => ({ CheckCircleFilled: () => null, CopyOutlined: () => null, SafetyCertificateOutlined: () => null }));
import { MarketTypedConfirmation } from './MarketTypedConfirmation';

const repository = 'https://github.com/gonavi/tool';
let renderer: ReturnType<typeof create> | undefined;
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
const ui = (overrides: Partial<React.ComponentProps<typeof MarketTypedConfirmation>> = {}) => (
  <MarketTypedConfirmation expected={{ repository }} repository="" matched={false} trusted={false}
    onRepositoryChange={vi.fn()} onTrustedChange={vi.fn()} {...overrides} />
);
const buttonWith = (label: string) => renderer!.root.findAllByProps({ 'data-component': 'button' })
  .find(button => String(button.children).includes(label));
const showsText = (label: string) => renderer!.root
  .findAll(node => Array.isArray(node.children) && node.children.some(child => typeof child === 'string' && child.includes(label)))
  .length > 0;

describe('market install identity confirmation', () => {
  it('copies the expected repository and reports the copied state', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await act(async () => { renderer = create(ui()); });
    await act(async () => { await buttonWith('plugin.market.install_copy')!.props.onClick(); });
    expect(writeText).toHaveBeenCalledWith(repository);
    expect(buttonWith('plugin.market.install_copied')).toBeTruthy();
  });

  it('pastes a trimmed repository from the clipboard', async () => {
    const readText = vi.fn().mockResolvedValue('  ' + repository + '  ');
    vi.stubGlobal('navigator', { clipboard: { readText } });
    const onRepositoryChange = vi.fn();
    await act(async () => { renderer = create(ui({ onRepositoryChange })); });
    await act(async () => { await buttonWith('plugin.market.install_paste')!.props.onClick(); });
    expect(onRepositoryChange).toHaveBeenCalledWith(repository);
  });

  it('reports a mismatch without blocking a matching address', async () => {
    await act(async () => { renderer = create(ui({ repository: 'https://github.com/other/tool' })); });
    expect(showsText('plugin.market.install_mismatch')).toBe(true);
    act(() => { renderer!.update(ui({ repository, matched: true })); });
    expect(showsText('plugin.market.install_repository_match')).toBe(true);
  });
});
