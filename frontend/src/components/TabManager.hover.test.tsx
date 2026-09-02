import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildTabWorkbenchStyle,
  TAB_WORKBENCH_CLASS_NAME,
  TAB_ENVIRONMENT_ACCENT_CSS_HEIGHT,
  handleTabDragPointerDown,
  resolveTabHoverOpen,
  resolveTabHoverTitle,
  resolveQueryTabRenameMenuState,
  shouldShowV2ConnectionLabel,
  TabHoverInfo,
  isMiddleMouseButton,
  shouldActivateTabDragPointer,
  stopTabHoverDragPropagation,
} from './TabManager';
import { setCurrentLanguage } from '../i18n';
import { catalogs } from '../i18n/catalog';
import type { TabData } from '../types';
import { buildTabDisplayModel } from '../utils/tabDisplay';

const TAB_MANAGER_SQL_FILE_CLOSE_KEYS = [
  'tab_manager.sql_file_close.read_failed_cancel_close',
  'tab_manager.sql_file_close.dirty_single_label',
  'tab_manager.sql_file_close.dirty_multiple_label',
  'tab_manager.sql_file_close.save_confirm_title',
  'tab_manager.sql_file_close.save_confirm_content',
  'tab_manager.sql_file_close.save_and_close',
  'tab_manager.sql_file_close.discard',
  'tab_manager.sql_file_close.save_failed',
  'tab_manager.sql_file_close.unknown_error',
  'tab_manager.sql_file_close.saved',
  'tab_manager.sql_file_close.missing_single_label',
  'tab_manager.sql_file_close.missing_multiple_label',
  'tab_manager.sql_file_close.missing_confirm_title',
  'tab_manager.sql_file_close.missing_confirm_content',
  'tab_manager.sql_file_close.continue_close',
  'tab_manager.sql_file_close.close_tabs',
] as const;

const TAB_MANAGER_MENU_KEYS = [
  'tab_manager.menu.tab_display_settings',
  'tab_manager.menu.close_other',
  'tab_manager.menu.close_left',
  'tab_manager.menu.close_right',
  'tab_manager.menu.close_all',
] as const;

afterEach(() => {
  setCurrentLanguage('zh-CN');
});

describe('TabManager hover info', () => {
  it('starts tab dragging only from a primary pointer on non-interactive tab content', () => {
    const tabContent = {
      closest: vi.fn(() => null),
    } as unknown as EventTarget;
    const closeIcon = {
      closest: vi.fn((selector: string) =>
        selector.includes('.gn-v2-tab-close') ? { className: 'gn-v2-tab-close' } : null),
    } as unknown as EventTarget;
    const legacyCloseIcon = {
      closest: vi.fn((selector: string) =>
        selector.includes('.ant-tabs-tab-remove') ? { className: 'ant-tabs-tab-remove' } : null),
    } as unknown as EventTarget;
    const contextMenuItem = {
      closest: vi.fn((selector: string) =>
        selector.includes('[role="menuitem"]') ? { role: 'menuitem' } : null),
    } as unknown as EventTarget;

    expect(shouldActivateTabDragPointer({ button: 0, target: tabContent })).toBe(true);
    expect(shouldActivateTabDragPointer({ button: 0, target: closeIcon })).toBe(false);
    expect(shouldActivateTabDragPointer({ button: 0, target: legacyCloseIcon })).toBe(false);
    expect(shouldActivateTabDragPointer({ button: 0, target: contextMenuItem })).toBe(false);
    expect(shouldActivateTabDragPointer({ button: 1, target: tabContent })).toBe(false);
    expect(shouldActivateTabDragPointer({ button: 2, target: tabContent })).toBe(false);
    expect(shouldActivateTabDragPointer({ button: 0, ctrlKey: true, target: tabContent })).toBe(false);
    expect(shouldActivateTabDragPointer({ button: 0, isPrimary: false, target: tabContent })).toBe(false);
  });

  it('does not capture or notify dnd-kit for close and context-menu pointers', () => {
    const setPointerCapture = vi.fn();
    const listener = vi.fn();
    const tabContent = { closest: vi.fn(() => null) } as unknown as EventTarget;
    const closeIcon = {
      closest: vi.fn(() => ({ className: 'gn-v2-tab-close' })),
    } as unknown as EventTarget;
    const contextMenuItem = {
      closest: vi.fn((selector: string) =>
        selector.includes('[role="menuitem"]') ? { role: 'menuitem' } : null),
    } as unknown as EventTarget;
    const buildEvent = (overrides: Record<string, unknown> = {}) => ({
      button: 0,
      ctrlKey: false,
      isPrimary: true,
      pointerId: 7,
      target: tabContent,
      currentTarget: { setPointerCapture },
      ...overrides,
    }) as unknown as React.PointerEvent<HTMLElement>;

    handleTabDragPointerDown(buildEvent(), listener);
    expect(setPointerCapture).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();

    setPointerCapture.mockClear();
    listener.mockClear();
    handleTabDragPointerDown(buildEvent({ target: closeIcon }), listener);
    handleTabDragPointerDown(buildEvent({ target: contextMenuItem }), listener);
    handleTabDragPointerDown(buildEvent({ button: 2 }), listener);
    handleTabDragPointerDown(buildEvent({ ctrlKey: true }), listener);
    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('recognizes only the auxiliary middle mouse button for tab closing', () => {
    expect(isMiddleMouseButton(1)).toBe(true);
    expect(isMiddleMouseButton(0)).toBe(false);
    expect(isMiddleMouseButton(2)).toBe(false);
  });

  it('shows query rename only for query tabs and disables SQL file tabs', () => {
    expect(resolveQueryTabRenameMenuState({ type: 'query' })).toEqual({
      visible: true,
      disabled: false,
    });
    expect(resolveQueryTabRenameMenuState({ type: 'query', filePath: 'D:/queries/report.sql' })).toEqual({
      visible: true,
      disabled: true,
    });
    expect(resolveQueryTabRenameMenuState({ type: 'table' })).toEqual({
      visible: false,
      disabled: false,
    });
  });

  it('keeps the tab workbench as a full-height flex child in legacy and v2 UI', () => {

    expect(TAB_WORKBENCH_CLASS_NAME).toBe('tab-workbench');
  });

  it('applies the persisted environment accent thickness in both legacy and v2 tabs', () => {
    expect(buildTabWorkbenchStyle(true, 260, 6)).toEqual({
      '--gn-v2-tab-width': '260px',
      '--gn-tab-environment-accent-thickness': '6px',
    });
    expect(buildTabWorkbenchStyle(false, 260, 1)).toEqual({
      '--gn-tab-environment-accent-thickness': '1px',
    });
    expect(buildTabWorkbenchStyle(true, 180, 99)).toEqual({
      '--gn-v2-tab-width': '180px',
      '--gn-tab-environment-accent-thickness': '2px',
    });
    expect(TAB_ENVIRONMENT_ACCENT_CSS_HEIGHT).toBe(
      'var(--gn-tab-environment-accent-thickness, 2px)',
    );
  });

  it('renders en-US v2 tab hover context for table tabs while keeping raw values raw', () => {
    setCurrentLanguage('en-US');
    const tab: TabData = {
      id: 'conn-1-main-users',
      title: 'users',
      type: 'table',
      connectionId: 'conn-1',
      tableName: '客户表',
    };

    const markup = renderToStaticMarkup(
      <TabHoverInfo
        tab={tab}
        displayTitle="[开发240] 表概览"
      />,
    );

    expect(markup).toContain('data-tab-hover-info="true"');
    expect(markup).toContain('[开发240] 表概览');
    expect(markup).toContain('Type');
    expect(markup).toContain('Table data');
    expect(markup).toContain('Connection');
    expect(markup).toContain('Unbound connection');
    expect(markup).toContain('Host');
    expect(markup).toContain('Not configured');
    expect(markup).toContain('Database');
    expect(markup).toContain('Not specified');
    expect(markup).toContain('Object');
    expect(markup).toContain('客户表');
    expect(markup).not.toContain('类型');
    expect(markup).not.toContain('表数据');
    expect(markup).not.toContain('未绑定连接');
    expect(markup).not.toContain('未配置');
    expect(markup).not.toContain('数据库');
    expect(markup).not.toContain('未指定');
    expect(markup).not.toContain('对象');
  });

  it('renders db identity for redis tabs without a database name', () => {
    setCurrentLanguage('en-US');
    const tab: TabData = {
      id: 'redis-keys-conn-1-db2',
      title: 'db2',
      type: 'redis-keys',
      connectionId: 'conn-1',
      redisDB: 2,
    };

    const markup = renderToStaticMarkup(
      <TabHoverInfo
        tab={tab}
        displayTitle="[缓存 | 10.0.0.8] db2"
        connectionLabel="缓存"
        hostSummary="10.0.0.8"
      />,
    );

    expect(markup).toContain('<span>Redis</span><strong>[缓存 | 10.0.0.8] db2</strong>');
    expect(markup).not.toContain('<span>REDIS</span>');
    expect(markup).toContain('Redis Key');
    expect(markup).toContain('Not specified');
    expect(markup).toContain('db2');
  });

  it('keeps v2 hover title focused on the tab object instead of appending secondary display fields', () => {
    const tab: TabData = {
      id: 'overview-1',
      title: '表概览 - front_end_sys',
      type: 'table-overview',
      connectionId: 'conn-1',
      dbName: 'front_end_sys',
    };
    const displayModel = buildTabDisplayModel(tab, {
      id: 'conn-1',
      name: '开发240',
      config: {
        type: 'mysql',
        host: '192.168.1.240',
        port: 3306,
        user: 'root',
        database: 'front_end_sys',
      },
    }, {
      layout: 'double',
      primaryElements: ['object', 'kind'],
      secondaryElements: ['connection', 'database'],
    });

    expect(displayModel.fullTitle).toContain('[开发240]');
    expect(resolveTabHoverTitle(displayModel, displayModel.fullTitle)).toBe('表概览 - front_end_sys');
  });

  it('stops hover card pointer events from reaching tab drag listeners without blocking text selection', () => {
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as React.SyntheticEvent<HTMLElement>;

    stopTabHoverDragPropagation(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('keeps tab hover hidden while the tab context menu is open', () => {
    expect(resolveTabHoverOpen(true, false)).toBe(true);
    expect(resolveTabHoverOpen(true, true)).toBe(false);
    expect(resolveTabHoverOpen(false, true)).toBe(false);
  });

  it('hides the v2 gray connection suffix when the title already carries the same prefix', () => {
    expect(shouldShowV2ConnectionLabel('[本地] videos', '本地')).toBe(false);
    expect(shouldShowV2ConnectionLabel('[缓存 | 10.0.0.8] db2', '缓存')).toBe(false);
    expect(shouldShowV2ConnectionLabel('新建查询', '本地')).toBe(true);
  });

  it('keeps SQL file close prompt keys in every catalog', () => {
    Object.entries(catalogs).forEach(([language, catalog]) => {
      TAB_MANAGER_SQL_FILE_CLOSE_KEYS.forEach((key) => {
        expect(catalog, `${language}:${key}`).toHaveProperty(key);
      });
    });
  });

  it('keeps tab context menu keys in every catalog', () => {
    Object.entries(catalogs).forEach(([language, catalog]) => {
      TAB_MANAGER_MENU_KEYS.forEach((key) => {
        expect(catalog, `${language}:${key}`).toHaveProperty(key);
      });
    });
  });
});
