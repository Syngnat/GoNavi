/** @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { SavedConnection, TabData } from '../../types';
import { TitlebarSessionIcon, TitlebarUserManagementIcon } from '../titlebar/gonaviTitlebarWorkbenchIcons';
import { useSidebarWorkbenchLaunchers, type SidebarWorkbenchLaunchers } from './useSidebarWorkbenchLaunchers';

const mysql = { id: 'm1', name: 'mysql', config: { type: 'mysql', host: 'h', port: 3306, user: 'root' } } as unknown as SavedConnection;
const sqlite = { id: 's1', name: 'sqlite', config: { type: 'sqlite', host: '', port: 0, user: '' } } as unknown as SavedConnection;

const renderLaunchers = (activeConnection: SavedConnection | null, addTab: (tab: TabData) => void) => {
  let captured: SidebarWorkbenchLaunchers | null = null;
  const Probe = () => {
    captured = useSidebarWorkbenchLaunchers({ activeTab: null, activeTabHasConnection: false, activeConnection, addTab });
    return null;
  };
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return captured as unknown as SidebarWorkbenchLaunchers;
};

describe('useSidebarWorkbenchLaunchers user management action', () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

  it('uses the hand-drawn titlebar icon set for workbench entries', () => {
    const launchers = renderLaunchers(mysql, vi.fn());

    // 与工具条其它入口同一套 2px 圆润实心图标，不混用 antd 细线图标。
    expect((launchers.sessionWorkbenchAction.icon as React.ReactElement).type).toBe(TitlebarSessionIcon);
    expect((launchers.userManagementAction.icon as React.ReactElement).type).toBe(TitlebarUserManagementIcon);
  });

  it('opens the session workbench with the active supported connection', () => {
    const addTab = vi.fn();
    const launchers = renderLaunchers(mysql, addTab);

    expect(launchers.sessionWorkbenchAction.key).toBe('session-workbench');
    launchers.sessionWorkbenchAction.onClick?.();

    expect(addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: 'session-workbench-center',
      connectionId: 'm1',
    }));
  });

  it('opens the session workbench without preselecting Redis', () => {
    const redis = {
      id: 'r1',
      name: 'redis',
      config: { type: 'redis', host: 'h', port: 6379, user: '' },
    } as unknown as SavedConnection;
    const addTab = vi.fn();

    renderLaunchers(redis, addTab).sessionWorkbenchAction.onClick?.();

    expect(addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: 'session-workbench-center',
      connectionId: '',
    }));
  });

  it('opens the active connection user management tab when supported', () => {
    const addTab = vi.fn();
    const launchers = renderLaunchers(mysql, addTab);
    expect(launchers.userManagementAction.key).toBe('user-management');
    launchers.userManagementAction.onClick?.();
    expect(addTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-management:m1', connectionId: 'm1' }));
  });

  it('falls back to the connection picker for unsupported or missing connections', () => {
    for (const connection of [sqlite, null]) {
      const addTab = vi.fn();
      renderLaunchers(connection, addTab).userManagementAction.onClick?.();
      expect(addTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-management:picker', connectionId: '' }));
    }
  });
});
