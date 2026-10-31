import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { PluginInspection } from '../../plugins/types';
vi.mock('antd', () => {
  const element = (name: string) => (props: React.HTMLAttributes<HTMLElement>) => React.createElement('div', { ...props, 'data-component': name });
  return { Alert: element('alert'), Checkbox: element('checkbox'), Descriptions: element('descriptions'), Modal: element('modal'),
    Tag: element('tag'), Typography: { Text: element('text') } };
});
vi.mock('../../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
import { PluginInstallPreview } from './PluginInstallPreview';
const inspection: PluginInspection = { manifest: { schemaVersion: 1, apiVersion: 1, id: 'test.hello', name: 'Hello', version: '1.0.0', permissions: ['database.read', 'host.log'] },
  digest: 'b'.repeat(64), sourcePath: '/tmp/plugin.zip', sizeBytes: 128 };
describe('digest and permission install consent', () => {
  it('shows exact source/digest/permissions and requires explicit trust before install', async () => {
    const install = vi.fn().mockResolvedValue(undefined);
    const view = create(<PluginInstallPreview inspection={inspection} allowed onCancel={vi.fn()} onInstall={install} />);
    let modal = view.root.findByProps({ 'data-component': 'modal' });
    expect(modal.props.okButtonProps.disabled).toBe(true);
    expect(modal.props.styles.body).toMatchObject({ overflowY: 'auto' });
    expect(modal.props.styles.body.maxHeight).toContain('100vh');
    await act(async () => { await modal.props.onOk(); });
    expect(install).not.toHaveBeenCalled();
    const descriptions = view.root.findByProps({ 'data-component': 'descriptions' });
    const values = descriptions.props.items as { key: string; children: React.ReactElement }[];
    expect(values.find((item) => item.key === 'digest')?.children.props.children).toBe(inspection.digest);
    const tags = view.root.findAllByProps({ 'data-component': 'tag' }).map((tag) => String(tag.children));
    expect(tags).toContain('database.read');
    expect(tags).toContain('plugin.permission.host_log (host.log)');
    act(() => view.root.findByProps({ 'data-component': 'checkbox' }).props.onChange({ target: { checked: true } }));
    modal = view.root.findByProps({ 'data-component': 'modal' });
    expect(modal.props.okButtonProps.disabled).toBe(false);
    await act(async () => { await modal.props.onOk(); });
    expect(install).toHaveBeenCalledOnce();
    view.unmount();
  });
  it('never enables install just because permission preview is trusted in read-only mode', async () => {
    const install = vi.fn();
    const view = create(<PluginInstallPreview inspection={inspection} allowed={false} onCancel={vi.fn()} onInstall={install} />);
    act(() => view.root.findByProps({ 'data-component': 'checkbox' }).props.onChange({ target: { checked: true } }));
    await act(async () => { await view.root.findByProps({ 'data-component': 'modal' }).props.onOk(); });
    expect(install).not.toHaveBeenCalled();
    view.unmount();
  });
  it('shows a read-only data source command and its effect before trust', () => {
    const withSource = { ...inspection, manifest: { ...inspection.manifest, contributes: {
      commands: [{ id: 'database', title: 'Database', effect: 'unknown' as const }],
      dataSources: [{ id: 'fixture', name: 'Fixture', dialect: 'sqlite', command: 'database', readOnly: true as const }],
    } } };
    const view = create(<PluginInstallPreview inspection={withSource} allowed onCancel={vi.fn()} onInstall={vi.fn()} />);
    const codes = view.root.findAllByType('code').map((node) => node.children.join(''));
    expect(codes).toContain('database (unknown)');
    const tags = view.root.findAllByProps({ 'data-component': 'tag' }).map((tag) => String(tag.children));
    expect(tags).toContain('plugin.datasource.read_only');
    expect(codes.join(' ')).not.toContain('write');
    view.unmount();
  });
});
