import React from 'react';
import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import TitleBarSystemActions from './TitleBarSystemActions';

vi.mock('antd', () => ({
  Button: ({ icon, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: React.ReactNode }) => (
    <button {...props}>{icon}</button>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@ant-design/icons', () => ({
  RobotOutlined: () => <span data-icon="robot" />,
  SettingOutlined: () => <span data-icon="settings" />,
}));

describe('TitleBarSystemActions', () => {
  it('keeps AI and settings usable in their original order', () => {
    const onToggleAI = vi.fn();
    const onOpenSettings = vi.fn();
    const renderer = create(
      <TitleBarSystemActions
        aiAssistantLabel="AI assistant"
        settingsLabel="Settings"
        aiActive
        onToggleAI={onToggleAI}
        onOpenSettings={onOpenSettings}
      />,
    );

    const toolbar = renderer.root.findByProps({ 'data-titlebar-system-actions': 'true' });
    const buttons = toolbar.findAllByType('button');

    expect(toolbar.props['data-no-titlebar-toggle']).toBe('true');
    expect(buttons.map((button) => button.props['aria-label'])).toEqual(['AI assistant', 'Settings']);
    expect(buttons[0].props['aria-pressed']).toBe(true);
    expect(buttons[0].props.className.split(' ')).toContain('is-active');
    expect(buttons[0].props['data-gonavi-ai-entry-action']).toBe('true');
    expect(buttons[1].props['data-sidebar-settings-action']).toBe('true');
    expect(buttons[1].props['data-titlebar-settings-action']).toBe('true');

    buttons[0].props.onClick();
    buttons[1].props.onClick();
    expect(onToggleAI).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
