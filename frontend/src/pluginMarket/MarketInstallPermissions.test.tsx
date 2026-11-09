import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginManifest } from '../plugins/types';

vi.mock('../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('antd', () => {
  const element = (name: string) => (props: React.HTMLAttributes<HTMLElement>) => React.createElement('div', { ...props, 'data-component': name });
  return { Typography: { Text: element('text') } };
});
vi.mock('@ant-design/icons', () => ({ AppstoreOutlined: () => null, DatabaseOutlined: () => null, ExportOutlined: () => null, RobotOutlined: () => null }));
import { MarketInstallPermissions } from './MarketInstallPermissions';

const manifest: PluginManifest = {
  schemaVersion: 1,
  apiVersion: 1,
  id: 'com.gonavi.test',
  name: 'Test',
  version: '1.0.0',
  permissions: ['data.sources', 'ai.tools', 'ui.pages', 'data.export', 'host.log'],
};
let renderer: ReturnType<typeof create> | undefined;
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; });

describe('market install permission groups', () => {
  it('groups permissions into data, AI, UI and export cards', async () => {
    await act(async () => { renderer = create(<MarketInstallPermissions manifest={manifest} />); });
    expect(renderer!.root.findAllByProps({ 'data-category': 'data' })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ 'data-category': 'ai' })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ 'data-category': 'ui' })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ 'data-category': 'export' })).toHaveLength(1);
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain('data.sources');
    expect(text).toContain('ai.tools');
    expect(text).toContain('host.log');
    expect(text).toContain('data.export');
  });

  it('shows the empty state when the package declares no permissions', async () => {
    await act(async () => { renderer = create(<MarketInstallPermissions manifest={{ ...manifest, permissions: [] }} />); });
    expect(JSON.stringify(renderer!.toJSON())).toContain('plugin.install.no_permissions');
    expect(renderer!.root.findAllByProps({ 'data-category': 'data' })).toHaveLength(0);
  });
});
