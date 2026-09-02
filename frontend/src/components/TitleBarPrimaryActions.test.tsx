import React from 'react';
import { readFileSync } from 'node:fs';
import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import TitleBarPrimaryActions, {
  resolveTitleBarPrimaryActionShortcut,
} from './TitleBarPrimaryActions';
import {
  cloneShortcutOptions,
  DEFAULT_SHORTCUT_OPTIONS,
} from '../utils/shortcuts';

const appCss = readFileSync(new URL('../App.css', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const v2ThemeCss = readFileSync(new URL('../v2-theme.css', import.meta.url), 'utf8');

vi.mock('@ant-design/icons', () => {
  const Icon = () => <span data-icon="true" />;
  return {
    ConsoleSqlOutlined: Icon,
    PlusOutlined: Icon,
    SettingOutlined: Icon,
  };
});

describe('TitleBarPrimaryActions', () => {
  it('keeps the original shared capsule treatment for every primary action', () => {
    const match = appCss.match(/\.gonavi-titlebar-primary-action\s*\{(?<body>[^}]*)\}/s);
    expect(match?.groups?.body).toContain('height: 26px;');
    expect(match?.groups?.body).toContain('border: 0.5px solid color-mix');
    expect(match?.groups?.body).toContain('border-radius: 7px;');
    expect(match?.groups?.body).toContain('font-weight: 600;');
    expect(match?.groups?.body).toContain('background: color-mix');
    expect(match?.groups?.body).toContain('font-size: 11px;');
    expect(match?.groups?.body).toContain('-webkit-app-region: no-drag;');
    expect(appCss).not.toContain('.gonavi-titlebar-primary-action[data-titlebar-action-kind=');
    expect(appCss).not.toMatch(
      /\[(?:data-gonavi-new-query-action|data-gonavi-create-connection-action|data-gonavi-connection-group-management-action)[^\]]*\]/,
    );
    const v2Overrides = Array.from(appCss.matchAll(
      /(?<selector>[^{}]*body\[data-ui-version="v2"\][^{}]*)\{(?<body>[^{}]*)\}/g,
    )).filter((rule) => /\.gonavi-titlebar-primary-action(?=[\s,:.#>\[+~]|$)/.test(rule.groups?.selector ?? ''));
    expect(v2Overrides.map((rule) => rule.groups?.body ?? '').join('\n')).not.toMatch(
      /(?:border:\s*0(?:[;\s]|$)|background:\s*transparent)/,
    );
    expect(appCss).not.toMatch(/body\[data-ui-version="v2"\] \.gonavi-titlebar-primary-actions::after\s*\{[^}]*display:\s*none;/s);
    expect(appSource).toContain('<span>GoNavi</span>');
    expect(appSource).not.toContain('<span className="gn-v2-titlebar-brand"');
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
    expect(appCss).toContain('body[data-ui-version="v2"] .gn-v2-titlebar .titlebar-window-controls > .ant-btn.ant-btn-text');
    expect(appCss).toContain('height: 100% !important;');
    const narrowStart = appCss.indexOf('@media (max-width: 420px)');
    const narrowEnd = appCss.indexOf("body[data-platform='windows']", narrowStart);
    const narrowCss = appCss.slice(narrowStart, narrowEnd);
    const narrowPrimaryRule = narrowCss.match(
      /body\[data-ui-version="v2"\] \.gonavi-titlebar-primary-action,\s*body\[data-ui-version="v2"\] \.gn-v2-titlebar-quick-more\s*\{(?<body>[^}]*)\}/s,
    );
    expect(narrowStart).toBeGreaterThanOrEqual(0);
    expect(narrowEnd).toBeGreaterThan(narrowStart);
    expect(narrowCss).toContain('Leave room for native window controls while keeping every command reachable.');
    expect(narrowPrimaryRule?.groups?.body).toContain('width: 38px !important;');
    expect(narrowPrimaryRule?.groups?.body).toContain('min-width: 38px !important;');
    expect(narrowPrimaryRule?.groups?.body).toContain('padding-inline: 0 !important;');
    expect(narrowPrimaryRule?.groups?.body).toContain('gap: 0 !important;');
    expect(narrowPrimaryRule?.groups?.body).toContain('font-size: 0 !important;');

    const titlebarMatch = v2ThemeCss.match(
      /body\[data-ui-version="v2"\] \.gn-v2-titlebar\s*\{(?<body>[^}]*)\}/s,
    );
    expect(titlebarMatch?.groups?.body).toContain('background: var(--gn-bg-panel-2) !important;');
    expect(titlebarMatch?.groups?.body).not.toContain('--gn-bg-chrome');
    expect(titlebarMatch?.groups?.body).toContain('border: 0 !important;');
    expect(titlebarMatch?.groups?.body).toContain('box-shadow: none !important;');
  });

  it('keeps v2 actions compact and aligns native mac content to the traffic-light center', () => {
    const titlebarLayoutMatch = appCss.match(
      /body\[data-ui-version="v2"\] \.gn-v2-titlebar\s*\{(?<body>[^}]*)\}/s,
    );
    const titlebarLayout = titlebarLayoutMatch?.groups?.body ?? '';
    expect(titlebarLayout).toContain('display: flex !important;');
    expect(titlebarLayout).toContain('justify-content: flex-start;');
    expect(titlebarLayout).not.toContain('grid-template-columns:');
    const nativeMacRowRule = appCss.match(
      /\.gn-v2-titlebar-native-mac\s*>\s*\.gonavi-titlebar-leading,\s*body\[data-ui-version="v2"\] \.gn-v2-titlebar-native-mac\s*>\s*\.gn-v2-titlebar-right\s*\{(?<body>[^}]*)\}/s,
    );
    expect(nativeMacRowRule).not.toBeNull();
    expect(nativeMacRowRule?.groups?.body).toContain('top: var(--gn-titlebar-native-content-offset, 0px);');
    expect(appCss).not.toMatch(/\.gn-v2-titlebar-collapsed-docked[^{}]*\{[^}]*top:\s*-10px;/s);
    expect(appSource).toMatch(
      /--gn-titlebar-native-content-offset[^\n]*getMacNativeTitlebarContentOffset\(titleBarHeight, isV2Ui && useNativeMacWindowControls\)/,
    );
    expect(appSource).toContain("isCollapsedSidebarActionsDocked ? 'gn-v2-titlebar-collapsed-docked' : ''");
    const collapsedActionBandRule = v2ThemeCss.match(
      /\.gn-v2-titlebar-collapsed-docked \.gn-v2-collapsed-sidebar-actions\s*\{(?<body>[^}]*)\}/s,
    );
    expect(collapsedActionBandRule).not.toBeNull();
    expect(collapsedActionBandRule?.groups?.body).toContain('bottom: 1px;');
    expect(collapsedActionBandRule?.groups?.body).not.toContain('--gn-titlebar-native-content-offset');
  });

  it('keeps the V2 explorer context text-only with three-line copy styles', () => {
    expect(v2ThemeCss).toContain('.gn-v2-explorer-context-line.is-connection');
    expect(v2ThemeCss).toContain('.gn-v2-explorer-context-line.is-database');
    expect(v2ThemeCss).toContain('.gn-v2-explorer-context-line.is-object');
    expect(v2ThemeCss).toContain('@container gn-v2-object-explorer (max-width: 300px)');
    expect(v2ThemeCss).not.toContain('.gn-v2-explorer-context-status');
    expect(v2ThemeCss).not.toContain('.gn-v2-explorer-context-status-dot');
    expect(v2ThemeCss).not.toContain('.gn-v2-titlebar-center');
  });

  it('keeps the V2 explorer context unclipped while the copy ellipsizes', () => {
    const centerRule = v2ThemeCss.match(
      /body\[data-ui-version="v2"\] \.gn-v2-explorer-context\s*\{(?<body>[^}]*)\}/s,
    );
    expect(centerRule?.groups?.body).toContain('overflow: visible;');
    const copyRule = v2ThemeCss.match(
      /body\[data-ui-version="v2"\] \.gn-v2-explorer-context-copy\s*\{(?<body>[^}]*)\}/s,
    );
    expect(copyRule?.groups?.body).toContain('overflow: hidden;');
    expect(copyRule?.groups?.body).toContain('flex-direction: column;');
    const lineRule = v2ThemeCss.match(
      /body\[data-ui-version="v2"\] \.gn-v2-explorer-context-line\s*\{(?<body>[^}]*)\}/s,
    );
    expect(lineRule?.groups?.body).toContain('min-height: 1em;');
    expect(lineRule?.groups?.body).toContain('text-overflow: ellipsis;');
    expect(v2ThemeCss).toContain('.gn-v2-tree-status.is-loading::before');
    expect(v2ThemeCss).toContain('.gn-v2-tree-status.is-success::before');
    expect(v2ThemeCss).toContain('.gn-v2-tree-status.is-error::before');
    expect(v2ThemeCss).not.toContain('.gn-v2-titlebar-live');
  });

  it('shows both labels in query-first order and invokes their actions', () => {
    const onNewQuery = vi.fn();
    const onNewConnection = vi.fn();
    const onConnectionGroupManagement = vi.fn();
    const shortcutOptions = cloneShortcutOptions(DEFAULT_SHORTCUT_OPTIONS);
    const renderer = create(
      <TitleBarPrimaryActions
        newQueryLabel="新建查询"
        newConnectionLabel="新建连接"
        newQueryShortcut={resolveTitleBarPrimaryActionShortcut(shortcutOptions, 'newQueryTab', 'mac')}
        newConnectionShortcut={resolveTitleBarPrimaryActionShortcut(shortcutOptions, 'newConnection', 'mac')}
        onNewQuery={onNewQuery}
        onNewConnection={onNewConnection}
        connectionGroupLabel="管理连接分组"
        onConnectionGroupManagement={onConnectionGroupManagement}
      />,
    );

    const actions = renderer.root.findByProps({ 'data-titlebar-primary-actions': 'true' });
    const buttons = actions.findAllByType('button');
    expect(actions.props['data-no-titlebar-toggle']).toBe('true');
    expect(buttons.map((button) => button.props['aria-label'])).toEqual(['新建查询', '新建连接', '管理连接分组']);
    expect(buttons.map((button) => button.props.className)).toEqual([
      'gonavi-titlebar-primary-action',
      'gonavi-titlebar-primary-action',
      'gonavi-titlebar-primary-action',
    ]);
    expect(buttons.map((button) => button.props['data-titlebar-action-kind'])).toEqual([undefined, undefined, undefined]);
    expect(buttons.map((button) => button.props.title)).toEqual([
      '新建查询 · ⌘N',
      '新建连接 · ⌘⇧N',
      undefined,
    ]);
    expect(buttons.map((button) => button.children[button.children.length - 1])).toEqual(['新建查询', '新建连接', '管理连接分组']);

    buttons[0].props.onClick();
    buttons[1].props.onClick();
    buttons[2].props.onClick();
    expect(onNewQuery).toHaveBeenCalledTimes(1);
    expect(onNewConnection).toHaveBeenCalledTimes(1);
    expect(onConnectionGroupManagement).toHaveBeenCalledTimes(1);
  });

  it('shows both Windows shortcut labels', () => {
    const shortcutOptions = cloneShortcutOptions(DEFAULT_SHORTCUT_OPTIONS);
    const renderer = create(
      <TitleBarPrimaryActions
        newQueryLabel="New Query"
        newConnectionLabel="New Connection"
        newQueryShortcut={resolveTitleBarPrimaryActionShortcut(shortcutOptions, 'newQueryTab', 'windows')}
        newConnectionShortcut={resolveTitleBarPrimaryActionShortcut(shortcutOptions, 'newConnection', 'windows')}
        onNewQuery={vi.fn()}
        onNewConnection={vi.fn()}
      />,
    );

    const buttons = renderer.root.findAllByType('button');
    expect(buttons.map((button) => button.props.title)).toEqual([
      'New Query · Ctrl+N',
      'New Connection · Ctrl+Shift+N',
    ]);
  });

  it('accepts a message-oriented icon for the context-aware primary action', () => {
    const renderer = create(
      <TitleBarPrimaryActions
        newQueryLabel="消息工作台"
        newQueryIcon={<span data-icon="message-workbench" />}
        newConnectionLabel="新建连接"
        onNewQuery={vi.fn()}
        onNewConnection={vi.fn()}
      />,
    );

    const primaryButton = renderer.root.findAllByType('button')[0];
    expect(primaryButton.findByProps({ 'data-icon': 'message-workbench' })).toBeTruthy();
    expect(primaryButton.props['aria-label']).toBe('消息工作台');
  });

  it('uses current platform custom bindings and hides disabled shortcuts', () => {
    const shortcutOptions = cloneShortcutOptions(DEFAULT_SHORTCUT_OPTIONS);
    shortcutOptions.newQueryTab.mac = { combo: 'Meta+Alt+Q', enabled: true };
    shortcutOptions.newQueryTab.windows = { combo: 'Ctrl+Alt+W', enabled: true };
    shortcutOptions.newConnection.mac = { combo: 'Meta+Shift+C', enabled: false };
    shortcutOptions.newConnection.windows = { combo: 'Ctrl+Alt+C', enabled: true };

    expect(resolveTitleBarPrimaryActionShortcut(shortcutOptions, 'newQueryTab', 'mac')).toBe('⌘⌥Q');
    expect(resolveTitleBarPrimaryActionShortcut(shortcutOptions, 'newQueryTab', 'windows')).toBe('Ctrl+Alt+W');
    expect(resolveTitleBarPrimaryActionShortcut(shortcutOptions, 'newConnection', 'mac')).toBeUndefined();
    expect(resolveTitleBarPrimaryActionShortcut(shortcutOptions, 'newConnection', 'windows')).toBe('Ctrl+Alt+C');

    const renderer = create(
      <TitleBarPrimaryActions
        newQueryLabel="新建查询"
        newConnectionLabel="新建连接"
        newQueryShortcut={resolveTitleBarPrimaryActionShortcut(shortcutOptions, 'newQueryTab', 'mac')}
        newConnectionShortcut={resolveTitleBarPrimaryActionShortcut(shortcutOptions, 'newConnection', 'mac')}
        onNewQuery={vi.fn()}
        onNewConnection={vi.fn()}
      />,
    );

    const buttons = renderer.root.findAllByType('button');
    expect(buttons.map((button) => button.props.title)).toEqual([
      '新建查询 · ⌘⌥Q',
      '新建连接',
    ]);
    expect(buttons.map((button) => button.props['aria-label'])).toEqual(['新建查询', '新建连接']);
    expect(buttons.every((button) => button.props.disabled !== true)).toBe(true);
  });
});
