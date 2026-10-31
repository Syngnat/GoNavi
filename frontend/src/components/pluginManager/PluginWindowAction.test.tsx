import React from 'react';
import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
vi.mock('antd', () => {
  const element = (name: string) => (props: React.HTMLAttributes<HTMLElement> & { icon?: React.ReactNode }) =>
    React.createElement('button', { ...props, 'data-component': name }, props.icon ?? null, props.children as React.ReactNode);
  return { Button: element('button') };
});
vi.mock('../../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => (key === 'plugin.action.open_window' ? '打开独立窗口' : key) }) }));
vi.mock('../icons/gnIcons', () => ({ GnPopoutIcon: () => React.createElement('span', { 'data-component': 'icon' }) }));
import { PluginWindowAction } from './PluginWindowAction';

describe('plugin window action', () => {
  it('renders a small icon button on its own row instead of a full-width panel button', () => {
    const view = create(<PluginWindowAction disabled={false} onOpen={vi.fn()} />);
    const row = view.root.findByProps({ className: 'plugin-window-action' });
    expect(row).toBeTruthy();
    const button = row.findByProps({ 'data-component': 'button' });
    expect(button.props.size).toBe('small');
    expect(button.props.disabled).toBe(false);
    expect(button.findAllByProps({ 'data-component': 'icon' })).toHaveLength(1);
    expect(button.children).toContain('打开独立窗口');
    view.unmount();
  });

  it('blocks the click while the plugin cannot be managed', () => {
    const onOpen = vi.fn();
    const view = create(<PluginWindowAction disabled onOpen={onOpen} />);
    const button = view.root.findByProps({ 'data-component': 'button' });
    expect(button.props.disabled).toBe(true);
    button.props.onClick();
    expect(onOpen).not.toHaveBeenCalled();
    view.unmount();
  });
});
