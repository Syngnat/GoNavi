import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { PluginStatus } from '../../plugins/types';
vi.mock('antd', () => ({ Button: (p: React.HTMLAttributes<HTMLElement>) => React.createElement('button', p),
  Tag: (p: React.HTMLAttributes<HTMLElement>) => React.createElement('span', p),
  Space: (p: React.HTMLAttributes<HTMLElement>) => React.createElement('div', p),
  Popconfirm: (p: React.HTMLAttributes<HTMLElement>) => React.createElement('div', p) }));
vi.mock('../../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
import { PluginLifecycleControls } from './PluginLifecycleControls';
const plugin: PluginStatus = { manifest: { schemaVersion: 1, apiVersion: 1, id: 'test.hello', name: 'Hello', version: '1.0.0', permissions: [] },
  digest: 'a'.repeat(64), state: 'starting', desiredEnabled: true, generation: 1, installedAt: 'now' };
describe('single enable-state field', () => {
  it('shows one state field instead of a requested/actual pair', () => {
    const view = create(<PluginLifecycleControls plugin={{ ...plugin, state: 'running', desiredEnabled: true }} allowed safeMode={false} busy={false} onEnabled={vi.fn()} onRemove={vi.fn()} />);
    const tags = view.root.findAllByType('span').filter((node) => node.props.color !== undefined);
    expect(tags).toHaveLength(1);
    expect(tags[0].props.children).toBe('plugin.state.enabled');
    expect(tags[0].props.color).toBe('success');
    const text = JSON.stringify(view.toJSON());
    expect(text).not.toContain('plugin.state.desired');
    expect(text).not.toContain('plugin.state.actual');
    view.unmount();
  });
  it('keeps a fault visible in that same field', () => {
    const view = create(<PluginLifecycleControls plugin={{ ...plugin, state: 'faulted', desiredEnabled: true }} allowed safeMode={false} busy={false} onEnabled={vi.fn()} onRemove={vi.fn()} />);
    const tags = view.root.findAllByType('span').filter((node) => node.props.color !== undefined);
    expect(tags).toHaveLength(1);
    expect(tags[0].props.children).toBe('plugin.state.faulted');
    expect(tags[0].props.color).toBe('error');
    view.unmount();
  });
});
describe('disable control availability', () => {
  it.each(['starting', 'stopping', 'faulted'] as const)('keeps Disable available while %s and busy', (state) => {
    const change = vi.fn();
    const view = create(<PluginLifecycleControls plugin={{ ...plugin, state }} allowed safeMode busy onEnabled={change} onRemove={vi.fn()} />);
    const disable = view.root.findAllByType('button').find((button) => button.children.includes('plugin.action.disable'))!;
    expect(disable.props.disabled).toBe(false);
    act(() => disable.props.onClick());
    expect(change).toHaveBeenCalledWith(false);
    expect(JSON.stringify(view.toJSON())).toContain('plugin.state.switch');
    view.unmount();
  });
  it('lets Enable be used again after a fault when management is idle', () => {
    const change = vi.fn();
    const view = create(<PluginLifecycleControls plugin={{ ...plugin, state: 'faulted', desiredEnabled: false }} allowed safeMode={false} busy={false} onEnabled={change} onRemove={vi.fn()} />);
    const enable = view.root.findAllByType('button').find((button) => button.children.includes('plugin.action.enable'))!;
    expect(enable.props.disabled).toBe(false);
    act(() => enable.props.onClick());
    expect(change).toHaveBeenCalledWith(true);
    view.unmount();
  });
  it('blocks Enable in safe mode but keeps Disable available', () => {
    const change = vi.fn();
    const view = create(<PluginLifecycleControls plugin={{ ...plugin, state: 'faulted', desiredEnabled: true }} allowed safeMode busy={false} onEnabled={change} onRemove={vi.fn()} />);
    const enable = view.root.findAllByType('button').find((button) => button.children.includes('plugin.action.enable'))!;
    const disable = view.root.findAllByType('button').find((button) => button.children.includes('plugin.action.disable'))!;
    expect(enable.props.disabled).toBe(true);
    expect(disable.props.disabled).toBe(false);
    act(() => disable.props.onClick());
    expect(change).toHaveBeenCalledWith(false);
    view.unmount();
  });
  it('obeys backend management permission even for disable', () => {
    const view = create(<PluginLifecycleControls plugin={plugin} allowed={false} safeMode={false} busy={false} onEnabled={vi.fn()} onRemove={vi.fn()} />);
    expect(view.root.findAllByType('button').every((button) => button.props.disabled)).toBe(true);
    view.unmount();
  });
});
