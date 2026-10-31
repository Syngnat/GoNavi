import React from 'react';
import { create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const opener = vi.hoisted(() => ({ openPluginPageTab: vi.fn() }));
vi.mock('../../pluginPages/openPluginPageTab', () => opener);
vi.mock('../../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('antd', () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => React.createElement('button', { ...props, 'data-open': 'true' }),
  Typography: {
    Text: (props: React.HTMLAttributes<HTMLElement>) => React.createElement('span', props),
  },
}));

import type { PluginStatus } from '../../plugins/types';
import { PluginPageList } from './PluginPageList';

const plugin: PluginStatus = {
  manifest: {
    schemaVersion: 1,
    apiVersion: 1,
    id: 'test.pages',
    name: 'Pages',
    version: '1.0.0',
    permissions: ['ui.pages'],
    contributes: {
      pages: [
        { id: 'overview', title: 'Overview', body: { type: 'text', text: 'hi' } },
        { id: 'dashboard', title: 'Dashboard', body: { type: 'text', text: 'hi' } },
      ],
      navigation: [{ id: 'dashboard-tools', title: 'Dash', page: 'dashboard', location: 'tools' }],
    },
  },
  digest: 'a'.repeat(64),
  state: 'running',
  desiredEnabled: true,
  generation: 1,
  installedAt: '2026-01-01',
};

beforeEach(() => opener.openPluginPageTab.mockReset());

describe('PluginPageList', () => {
  it('lists every declared page and opens the tab with its navigation title', () => {
    const renderer = create(<PluginPageList plugin={plugin} active />);
    const buttons = renderer.root.findAllByProps({ 'data-open': 'true' });
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.props.disabled === false)).toBe(true);
    buttons[1].props.onClick();
    expect(opener.openPluginPageTab).toHaveBeenCalledWith({
      pluginID: 'test.pages',
      pageID: 'dashboard',
      title: 'Dash',
    });
    renderer.unmount();
  });

  it('disables pages in a web session without plugin management and explains why', () => {
    const renderer = create(<PluginPageList plugin={plugin} active managementAllowed={false} webRuntime />);
    const buttons = renderer.root.findAllByProps({ 'data-open': 'true' });
    expect(buttons.every((button) => button.props.disabled === true)).toBe(true);
    const hints = renderer.root.findAll((node) => node.type === 'span' && node.props.className === 'plugin-page-list-hint');
    expect(hints).toHaveLength(1);
    renderer.unmount();
  });

  it('keeps pages clickable when management is allowed in a web session', () => {
    const renderer = create(<PluginPageList plugin={plugin} active managementAllowed webRuntime />);
    const buttons = renderer.root.findAllByProps({ 'data-open': 'true' });
    expect(buttons.every((button) => button.props.disabled === false)).toBe(true);
    const hints = renderer.root.findAll((node) => node.type === 'span' && node.props.className === 'plugin-page-list-hint');
    expect(hints).toHaveLength(0);
    renderer.unmount();
  });

  it('disables opening while the plugin is not running', () => {
    const renderer = create(<PluginPageList plugin={plugin} active={false} />);
    const buttons = renderer.root.findAllByProps({ 'data-open': 'true' });
    expect(buttons.every((button) => button.props.disabled === true)).toBe(true);
    renderer.unmount();
  });

  it('renders nothing for a plugin without pages', () => {
    const renderer = create(<PluginPageList plugin={{ ...plugin, manifest: { ...plugin.manifest, contributes: {} } }} active />);
    expect(renderer.toJSON()).toBeNull();
    renderer.unmount();
  });
});
