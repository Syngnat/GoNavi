import React from 'react';
import { readFileSync } from 'node:fs';
import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import TitleBarPrimaryActions from './TitleBarPrimaryActions';

const appCss = readFileSync(new URL('../App.css', import.meta.url), 'utf8');

vi.mock('@ant-design/icons', () => {
  const Icon = () => <span data-icon="true" />;
  return {
    ConsoleSqlOutlined: Icon,
    PlusOutlined: Icon,
  };
});

describe('TitleBarPrimaryActions', () => {
  it('matches the elevated primary titlebar action treatment', () => {
    const match = appCss.match(/\.gonavi-titlebar-primary-action\s*\{(?<body>[^}]*)\}/s);
    expect(match?.groups?.body).toContain('border-radius: 7px;');
    expect(match?.groups?.body).toContain('font-weight: 600;');
    expect(match?.groups?.body).toContain('-webkit-app-region: no-drag;');
    expect(match?.groups?.body).toMatch(/background:\s*color-mix/);
  });

  it('keeps the custom window controls borderless under the v2 button theme', () => {
    const match = appCss.match(
      /\.titlebar-window-controls > \.ant-btn\.ant-btn-text\s*\{(?<body>[^}]*)\}/s,
    );
    expect(match, 'Missing titlebar window-control override').not.toBeNull();
    const body = match?.groups?.body ?? '';
    expect(body).toContain('border: 0 !important;');
    expect(body).toContain('border-radius: 0 !important;');
    expect(body).toContain('box-shadow: none !important;');

    const closeHoverMatch = appCss.match(
      /\.titlebar-window-controls > \.titlebar-close-btn\.ant-btn-text:hover\s*\{(?<body>[^}]*)\}/s,
    );
    expect(closeHoverMatch, 'Missing close-button hover override').not.toBeNull();
    expect(closeHoverMatch?.groups?.body).toContain('background-color: #ff4d4f !important;');
    expect(closeHoverMatch?.groups?.body).toContain('color: #fff !important;');
  });

  it('shows both labels in query-first order and invokes their actions', () => {
    const onNewQuery = vi.fn();
    const onNewConnection = vi.fn();
    const renderer = create(
      <TitleBarPrimaryActions
        newQueryLabel="新建查询"
        newConnectionLabel="新建连接"
        onNewQuery={onNewQuery}
        onNewConnection={onNewConnection}
      />,
    );

    const actions = renderer.root.findByProps({ 'data-titlebar-primary-actions': 'true' });
    const buttons = actions.findAllByType('button');
    expect(actions.props['data-no-titlebar-toggle']).toBe('true');
    expect(buttons.map((button) => button.props['aria-label'])).toEqual(['新建查询', '新建连接']);
    expect(buttons.map((button) => button.children[button.children.length - 1])).toEqual(['新建查询', '新建连接']);

    buttons[0].props.onClick();
    buttons[1].props.onClick();
    expect(onNewQuery).toHaveBeenCalledTimes(1);
    expect(onNewConnection).toHaveBeenCalledTimes(1);
  });
});
