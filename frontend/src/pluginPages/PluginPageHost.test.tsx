/** @vitest-environment jsdom */
import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const targetState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('./usePluginPageTarget', () => ({ usePluginPageTarget: () => targetState.value }));
vi.mock('./api', () => ({ pageCall: vi.fn() }));
vi.mock('./DeclarativePluginPage', () => ({
  DeclarativePluginPage: (props: { pluginID: string; generation: number }) => React.createElement('div', {
    'data-declarative': props.pluginID,
    'data-generation': props.generation,
  }),
}));
vi.mock('../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('antd', () => ({
  Alert: (props: { type: string; message: string; description?: string }) => React.createElement('div', {
    'data-alert': props.type,
    'data-message': props.message,
    'data-description': props.description,
  }),
  Spin: () => React.createElement('span', { 'data-spin': 'true' }),
  message: { open: vi.fn() },
}));

import { PluginPageHost } from './PluginPageHost';

const status = { manifest: { id: 'test.pages', commands: [] }, generation: 4 };
let renderer: ReturnType<typeof create> | undefined;

beforeEach(() => {
  targetState.value = {};
});
afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

describe('PluginPageHost', () => {
  it('shows a spinner while the plugin status is loading', () => {
    targetState.value = { loading: true, error: '', available: false };
    renderer = create(<PluginPageHost pluginID="test.pages" pageID="overview" />);
    expect(renderer.root.findAllByProps({ 'data-spin': 'true' })).toHaveLength(1);
  });

  it('shows the unavailable state instead of a blank tab for a stopped plugin', () => {
    targetState.value = { loading: false, error: '', available: false };
    renderer = create(<PluginPageHost pluginID="test.pages" pageID="overview" />);
    const alert = renderer.root.findByProps({ 'data-alert': 'warning' });
    expect(alert.props['data-message']).toBe('plugin.pages.unavailable');
  });

  it('keeps the host failure visible with its own detail', () => {
    targetState.value = { loading: false, error: 'host down', available: false };
    renderer = create(<PluginPageHost pluginID="test.pages" pageID="overview" />);
    const alert = renderer.root.findByProps({ 'data-alert': 'error' });
    expect(alert.props['data-message']).toBe('plugin.pages.unavailable');
    expect(alert.props['data-description']).toBe('host down');
  });

  it('renders a declared html page in the sandbox with the bridge runtime', async () => {
    targetState.value = {
      loading: false,
      error: '',
      available: true,
      status,
      page: { id: 'dashboard', title: 'Dashboard', html: { source: '<h1>Hi</h1>' } },
    };
    await act(async () => { renderer = create(<PluginPageHost pluginID="test.pages" pageID="dashboard" />); });
    const frame = renderer!.root.findByType('iframe');
    expect(frame.props.sandbox).toBe('allow-scripts');
    expect(frame.props.title).toBe('Dashboard');
    expect(frame.props.srcDoc).toContain('<h1>Hi</h1>');
    expect(frame.props.srcDoc).toContain('window.gonavi');
  });

  it('renders a declared declarative page through the shared panel', () => {
    targetState.value = {
      loading: false,
      error: '',
      available: true,
      status,
      page: { id: 'overview', title: 'Overview', body: { type: 'text', text: 'hi' } },
    };
    renderer = create(<PluginPageHost pluginID="test.pages" pageID="overview" />);
    const panel = renderer.root.findByProps({ 'data-declarative': 'test.pages' });
    expect(panel.props['data-generation']).toBe(4);
  });
});
