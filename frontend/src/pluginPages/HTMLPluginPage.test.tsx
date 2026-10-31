/** @vitest-environment jsdom */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ pageCall: vi.fn(() => Promise.resolve(null)) }));
vi.mock('../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('antd', () => ({
  Alert: (props: { type: string; message: string; description?: string }) => React.createElement('div', {
    'data-alert': props.type,
    'data-message': props.message,
    'data-description': props.description,
  }),
  message: { open: vi.fn() },
}));

import { HTMLPluginPage } from './HTMLPluginPage';

const tokenOf = (srcDoc: string): string => {
  const match = /var token = "([0-9a-f]+)"/.exec(srcDoc);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
};
let renderer: ReactTestRenderer | undefined;

const renderPage = async () => {
  await act(async () => {
    renderer = create(
      <HTMLPluginPage pluginID="test.pages" pageID="overview" title="Overview" source="<h1>Hi</h1>" />,
    );
  });
  return renderer!;
};

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('HTMLPluginPage', () => {
  it('binds every frame to its own token inside the injected runtime', async () => {
    const source = (await renderPage()).root.findByType('iframe').props.srcDoc as string;
    expect(source).toContain('<h1>Hi</h1>');
    expect(source).toContain('window.gonavi');
    const firstToken = tokenOf(source);
    act(() => renderer?.unmount());
    renderer = undefined;
    const secondSource = (await renderPage()).root.findByType('iframe').props.srcDoc as string;
    expect(tokenOf(secondSource)).not.toBe(firstToken);
  });

  it('keeps the first srcdoc load and closes the frame on any later load', async () => {
    const view = await renderPage();
    act(() => {
      view.root.findByType('iframe').props.onLoad();
    });
    expect(view.root.findAllByType('iframe')).toHaveLength(1);
    act(() => {
      view.root.findByType('iframe').props.onLoad();
    });
    expect(view.root.findAllByType('iframe')).toHaveLength(0);
    const alert = view.root.findByProps({ 'data-alert': 'error' });
    expect(alert.props['data-message']).toBe('plugin.pages.unavailable');
    expect(alert.props['data-description']).toBe('plugin.pages.error.navigation');
  });
});
