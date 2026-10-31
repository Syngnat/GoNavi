import React from 'react';
import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { PluginStatus } from '../../plugins/types';
vi.mock('antd', () => {
  const element = (name: string) => (props: React.HTMLAttributes<HTMLElement>) => React.createElement('div', { ...props, 'data-component': name });
  return { Alert: element('alert'), Button: element('button'), Drawer: element('drawer'), Tag: element('tag'), Typography: { Title: element('title'), Paragraph: element('paragraph') } };
});
vi.mock('../../i18n/provider', () => ({ useI18n: () => ({ t: (key: string, params?: Record<string, string>) => {
  const updates: Record<string, string> = {
    'plugin.update.available': '有新版本{{version}}',
    'plugin.update.action': '更新到{{version}}',
    'plugin.update.source': '来源{{source}}',
  };
  return (updates[key] ?? key).replace(/\{\{(\w+)\}\}/g, (match, name: string) => params?.[name] ?? match);
} }) }));
vi.mock('./PluginLifecycleControls', () => ({ PluginLifecycleControls: () => React.createElement('div', { 'data-component': 'lifecycle' }) }));
vi.mock('./PluginCommandsPanel', () => ({ PluginCommandsPanel: () => null }));
vi.mock('./PluginDataSourceSummary', () => ({ PluginDataSourceSummary: () => null }));
vi.mock('./PluginAIProviderSummary', () => ({ PluginAIProviderSummary: () => null }));
vi.mock('./PluginExporterSummary', () => ({ PluginExporterSummary: () => null }));
vi.mock('./PluginSkillSummary', () => ({ PluginSkillSummary: () => null }));
import { PluginCard } from './PluginCard';
const manager = { runtime: { safeMode: false, managementAllowed: true }, busy: {}, revoked: new Set<string>() } as never;
const plugin: PluginStatus = { manifest: { schemaVersion: 1, apiVersion: 1, id: 'test.hello', name: 'Hello', version: '1.0.0', permissions: [] },
  digest: 'a'.repeat(64), state: 'faulted', desiredEnabled: true, generation: 2, lastError: 'backend exited with status 3', installedAt: '2026-01-01' };
describe('plugin card updates', () => {
  it('blocks the update callback even when a disabled button onClick is invoked manually', () => {
    const onUpdate = vi.fn();
    const view = create(<PluginCard plugin={plugin} manager={manager} expanded={false} onToggle={vi.fn()}
      update={{ version: '1.2.0', sourceLabel: 'Official catalog' }} onUpdate={onUpdate} updateDisabled />);
    const button = view.root.findByType('footer').findByProps({ 'data-component': 'button' });
    expect(button.props.disabled).toBe(true);
    button.props.onClick();
    expect(onUpdate).not.toHaveBeenCalled();
    view.unmount();
  });
  it('requests an update through its callback without installing directly or opening details', () => {
    const onUpdate = vi.fn();
    const onToggle = vi.fn();
    const installRemote = vi.fn();
    const managed = { runtime: { safeMode: false, managementAllowed: true }, busy: {}, revoked: new Set<string>(), installRemote } as never;
    const view = create(<PluginCard plugin={plugin} manager={managed} expanded={false} onToggle={onToggle}
      update={{ version: '1.2.0', sourceLabel: 'Official catalog' }} onUpdate={onUpdate} />);
    const button = view.root.findByType('footer').findByProps({ 'data-component': 'button' });
    expect(button.props.disabled).toBe(false);
    expect(onUpdate).not.toHaveBeenCalled();
    button.props.onClick();
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onToggle).not.toHaveBeenCalled();
    expect(installRemote).not.toHaveBeenCalled();
    view.unmount();
  });
  it('shows the available version near the installed version and an update footer after lifecycle controls', () => {
    const view = create(<PluginCard plugin={plugin} manager={manager} expanded={false} onToggle={vi.fn()}
      update={{ version: '1.2.0', sourceLabel: 'Official catalog' }} onUpdate={vi.fn()} />);
    const header = view.root.findByType('header');
    const version = header.findByProps({ 'data-component': 'tag', className: 'plugin-installed-version' });
    const available = header.findByProps({ 'data-component': 'tag', className: 'plugin-update-available' });
    expect(version.children).toEqual(['1.0.0']);
    expect(available.children).toEqual(['有新版本1.2.0']);
    expect(available.parent?.parent).toBe(version.parent?.parent);
    const footer = view.root.findByType('footer');
    const button = footer.findByProps({ 'data-component': 'button' });
    expect(button.children).toEqual(['更新到1.2.0']);
    expect(footer.findByProps({ className: 'plugin-update-source' }).children).toEqual(['来源Official catalog']);
    const card = view.root.findByType('article');
    const lifecycleIndex = card.children.findIndex((child) => typeof child !== 'string' && child.findAllByProps({ 'data-component': 'lifecycle' }).length > 0);
    expect(card.children[lifecycleIndex + 1]).toBe(footer);
    view.unmount();
  });
});

describe('plugin card failure detail', () => {
  it('labels a runtime failure instead of showing bare host text', () => {
    const view = create(<PluginCard plugin={plugin} manager={manager} expanded={false} onToggle={vi.fn()} />);
    const alert = view.root.findByProps({ 'data-component': 'alert' });
    expect(alert.props.message).toBe('plugin.card.last_error');
    expect(alert.props.description).toBe('backend exited with status 3');
    view.unmount();
  });
  it('keeps installed details collapsed until requested', () => {
    const described = { ...plugin, manifest: { ...plugin.manifest, description: 'details', permissions: ['host.log'] } };
    const collapsed = create(<PluginCard plugin={described} manager={manager} expanded={false} onToggle={vi.fn()} />);
    expect(collapsed.root.findAllByProps({ className: 'plugin-card-details' })).toHaveLength(0);
    expect(collapsed.root.findAllByProps({ className: 'plugin-permissions' })).toHaveLength(0);
    collapsed.unmount();
    const onToggle = vi.fn();
    const expanded = create(<PluginCard plugin={described} manager={manager} expanded onToggle={onToggle} />);
    const drawer = expanded.root.findByProps({ 'data-component': 'drawer' });
    expect(drawer.props.open).toBe(true);
    expect(drawer.props.title).toBe('Hello');
    drawer.props.onClose();
    expect(onToggle).toHaveBeenCalledOnce();
    expect(expanded.root.findAllByProps({ className: 'plugin-card-details' })).toHaveLength(1);
    expect(expanded.root.findAllByProps({ className: 'plugin-permissions' })).toHaveLength(1);
    expanded.unmount();
  });
  it('renders no error alert when the plugin is healthy', () => {
    const view = create(<PluginCard plugin={{ ...plugin, lastError: '', state: 'running' }} manager={manager} expanded={false} onToggle={vi.fn()} />);
    expect(view.root.findAllByProps({ 'data-component': 'alert' })).toHaveLength(0);
    view.unmount();
  });
});
