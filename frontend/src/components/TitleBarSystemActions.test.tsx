import React from 'react';
import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import TitleBarSystemActions from './TitleBarSystemActions';
import { TitlebarMoonIcon, TitlebarSunIcon } from './titlebar/gonaviTitlebarIcons';

vi.mock('antd', () => ({
  Button: ({ icon, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: React.ReactNode }) => (
    <button {...props}>{icon}{children}</button>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@ant-design/icons', () => ({
  SettingOutlined: () => <span data-icon="settings" />,
}));

const trailingSlot = <div id="gonavi-titlebar-about-action" data-testid="trailing-slot" />;

describe('TitleBarSystemActions', () => {
  it('keeps settings usable without an AI entry in the fallback layout', () => {
    const onOpenSettings = vi.fn();
    const renderer = create(
      <TitleBarSystemActions settingsLabel="Settings" onOpenSettings={onOpenSettings} trailingSlot={trailingSlot} />,
    );

    const toolbar = renderer.root.findByProps({ 'data-titlebar-system-actions': 'true' });
    const buttons = toolbar.findAllByType('button');

    expect(toolbar.props['data-no-titlebar-toggle']).toBe('true');
    expect(toolbar.findAll((node) => node.props['data-gonavi-ai-entry-action'] === 'true')).toHaveLength(0);
    expect(buttons.map((button) => button.props['aria-label'])).toEqual(['Settings']);
    expect(buttons[0].props['data-sidebar-settings-action']).toBe('true');
    expect(buttons[0].props['data-titlebar-settings-action']).toBe('true');
    expect(toolbar.findByProps({ 'data-testid': 'trailing-slot' })).toBeTruthy();

    buttons[0].props.onClick();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('places the trailing slot between settings and theme inside the preferences pill', () => {
    const renderer = create(
      <TitleBarSystemActions
        settingsLabel="Settings"
        onOpenSettings={vi.fn()}
        themeLabel="Theme"
        onToggleTheme={vi.fn()}
        trailingSlot={trailingSlot}
      />,
    );

    const pill = renderer.root.findByProps({ 'data-gonavi-preferences-pill': 'true' });
    const order = pill.children
      .filter((child): child is Exclude<typeof child, string> => typeof child !== 'string')
      .map((child) => child.props['data-testid'] ?? child.props['aria-label'] ?? child.props.className);

    expect(order).toEqual([
      'gonavi-titlebar-preferences-action',
      'trailing-slot',
      'gonavi-titlebar-theme-action',
    ]);
  });

  it('shows a sun in light mode and a moon in dark mode on the theme segment', () => {
    const render = (isDarkTheme: boolean) => create(
      <TitleBarSystemActions
        settingsLabel="Settings"
        onOpenSettings={vi.fn()}
        themeLabel="Theme"
        isDarkTheme={isDarkTheme}
        onToggleTheme={vi.fn()}
      />,
    ).root.findByProps({ 'data-testid': 'gonavi-titlebar-theme-action' });

    expect(render(false).findAllByType(TitlebarSunIcon)).toHaveLength(1);
    expect(render(false).findAllByType(TitlebarMoonIcon)).toHaveLength(0);
    expect(render(true).findAllByType(TitlebarMoonIcon)).toHaveLength(1);
    expect(render(true).findAllByType(TitlebarSunIcon)).toHaveLength(0);
  });
});
