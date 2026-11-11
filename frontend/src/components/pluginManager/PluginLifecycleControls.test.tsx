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
const buttons = (view: ReturnType<typeof create>) => view.root.findAllByType('button');
const toggle = (view: ReturnType<typeof create>) => buttons(view)
  .find((button) => button.children.includes('plugin.action.enable') || button.children.includes('plugin.action.disable'))!;
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
describe('single enable/disable toggle', () => {
  it('renders one toggle showing Disable while enabled', () => {
    const view = create(<PluginLifecycleControls plugin={{ ...plugin, state: 'running', desiredEnabled: true }} allowed safeMode={false} busy={false} onEnabled={vi.fn()} onRemove={vi.fn()} />);
    expect(buttons(view).filter((button) => button.children.includes('plugin.action.enable'))).toHaveLength(0);
    expect(toggle(view).children).toContain('plugin.action.disable');
    view.unmount();
  });
  it('renders one toggle showing Enable while disabled', () => {
    const view = create(<PluginLifecycleControls plugin={{ ...plugin, state: 'disabled', desiredEnabled: false }} allowed safeMode={false} busy={false} onEnabled={vi.fn()} onRemove={vi.fn()} />);
    expect(buttons(view).filter((button) => button.children.includes('plugin.action.disable'))).toHaveLength(0);
    expect(toggle(view).children).toContain('plugin.action.enable');
    view.unmount();
  });
  it('toggles to disable when enabled and to enable when disabled', () => {
    const change = vi.fn();
    const on = create(<PluginLifecycleControls plugin={{ ...plugin, state: 'running', desiredEnabled: true }} allowed safeMode={false} busy={false} onEnabled={change} onRemove={vi.fn()} />);
    act(() => toggle(on).props.onClick());
    expect(change).toHaveBeenCalledWith(false);
    const off = create(<PluginLifecycleControls plugin={{ ...plugin, state: 'disabled', desiredEnabled: false }} allowed safeMode={false} busy={false} onEnabled={change} onRemove={vi.fn()} />);
    act(() => toggle(off).props.onClick());
    expect(change).toHaveBeenLastCalledWith(true);
    on.unmount(); off.unmount();
  });
  it.each(['starting', 'stopping', 'faulted'] as const)('keeps disable available while %s', (state) => {
    const change = vi.fn();
    const view = create(<PluginLifecycleControls plugin={{ ...plugin, state }} allowed safeMode busy onEnabled={change} onRemove={vi.fn()} />);
    expect(toggle(view).children).toContain('plugin.action.disable');
    expect(toggle(view).props.disabled).toBe(false);
    act(() => toggle(view).props.onClick());
    expect(change).toHaveBeenCalledWith(false);
    expect(JSON.stringify(view.toJSON())).toContain('plugin.state.switch');
    view.unmount();
  });
  it('blocks the toggle from enabling in safe mode', () => {
    const view = create(<PluginLifecycleControls plugin={{ ...plugin, state: 'faulted', desiredEnabled: false }} allowed safeMode busy={false} onEnabled={vi.fn()} onRemove={vi.fn()} />);
    expect(toggle(view).children).toContain('plugin.action.enable');
    expect(toggle(view).props.disabled).toBe(true);
    view.unmount();
  });
  it('obeys backend management permission in both directions', () => {
    const on = create(<PluginLifecycleControls plugin={{ ...plugin, state: 'running', desiredEnabled: true }} allowed={false} safeMode={false} busy={false} onEnabled={vi.fn()} onRemove={vi.fn()} />);
    expect(toggle(on).props.disabled).toBe(true);
    on.unmount();
    const off = create(<PluginLifecycleControls plugin={{ ...plugin, state: 'disabled', desiredEnabled: false }} allowed={false} safeMode={false} busy={false} onEnabled={vi.fn()} onRemove={vi.fn()} />);
    expect(toggle(off).props.disabled).toBe(true);
    off.unmount();
  });
});
describe('update action placement', () => {
  it('renders the update button in the same action row as the toggle', () => {
    const onUpdate = vi.fn();
    const view = create(<PluginLifecycleControls plugin={{ ...plugin, state: 'running', desiredEnabled: true }} allowed safeMode={false} busy={false}
      onEnabled={vi.fn()} onRemove={vi.fn()} update={{ label: 'plugin.update.action_short', disabled: false, onClick: onUpdate }} />);
    const toggleButton = toggle(view);
    const updateButton = buttons(view).find((button) => button.children.includes('plugin.update.action_short'))!;
    expect(updateButton).toBeDefined();
    // 同一排：两者的祖父都是同一个 Space 动作行（父级是各自的 Button 组件）。
    // 先算成布尔值再断言，避免 vitest 在失败时序列化两棵 test-instance 树。
    expect(updateButton.parent?.parent === toggleButton.parent?.parent).toBe(true);
    act(() => updateButton.props.onClick());
    expect(onUpdate).toHaveBeenCalledOnce();
    view.unmount();
  });
  it('hides the update button when no release is available', () => {
    const view = create(<PluginLifecycleControls plugin={{ ...plugin, state: 'running', desiredEnabled: true }} allowed safeMode={false} busy={false} onEnabled={vi.fn()} onRemove={vi.fn()} />);
    expect(buttons(view).some((button) => button.children.includes('plugin.update.action_short'))).toBe(false);
    view.unmount();
  });
});
