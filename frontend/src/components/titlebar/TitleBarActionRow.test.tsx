/** @vitest-environment jsdom */

import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n/provider';
import { useStore } from '../../store';
import TitlebarActionsPlacementSettings from '../settings/TitlebarActionsPlacementSettings';
import TitleBarQuickActionsHost from '../TitleBarQuickActionsHost';
import TitleBarActionRow, { type TitleBarActionRowProps } from './TitleBarActionRow';

// jsdom 环境替换了全局 URL，按字符串路径读取样式源码。
const rowCss = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'titleBarActionRow.css'), 'utf8');

const createHandlers = () => ({
  onNewQuery: vi.fn(),
  onNewConnection: vi.fn(),
  onManageConnectionGroups: vi.fn(),
  onToggleAI: vi.fn(),
});

const rowProps = (handlers: ReturnType<typeof createHandlers>, overrides: Partial<TitleBarActionRowProps> = {}): TitleBarActionRowProps => ({
  placement: 'toolbar',
  messageQueuePrimary: false,
  aiActive: false,
  ...handlers,
  ...overrides,
});

/** 与 App 相同的摆放：工具条模式在标题栏之外，标题栏模式内联到品牌区。Host 先于入口行渲染。 */
const PlacementHarness: React.FC<{ onSqlTools: () => void }> = ({ onSqlTools }) => {
  const placement = useStore((state) => state.appearance.titlebarActionsPlacement);
  const row = <TitleBarActionRow {...rowProps(createHandlers(), { placement })} />;
  return (
    <>
      <TitleBarQuickActionsHost label="Tools" actions={[{ key: 'sql-tools', label: 'SQL tools', onClick: onSqlTools }]} />
      <div className="gn-v2-titlebar">
        <div className="gonavi-titlebar-leading" data-testid="leading">
          <span>GoNavi</span>
          {placement === 'titlebar' && row}
        </div>
      </div>
      {placement !== 'titlebar' && row}
    </>
  );
};

describe('TitleBarActionRow', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    useStore.getState().setAppearance({ titlebarActionsPlacement: 'toolbar', titlebarActionsDisplay: 'text' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useStore.getState().setAppearance({ titlebarActionsPlacement: 'toolbar', titlebarActionsDisplay: 'text' });
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  const render = async (node: React.ReactNode) => {
    await act(async () => {
      root.render(
        <I18nProvider preference="en-US" systemLanguages={['en-US']} onPreferenceChange={vi.fn()}>
          {node}
        </I18nProvider>,
      );
    });
  };

  const button = (selector: string) => container.querySelector(selector) as HTMLButtonElement;

  it('renders the whole row inside the separate toolbar by default', async () => {
    const handlers = createHandlers();
    await render(<TitleBarActionRow {...rowProps(handlers, { newQueryShortcut: 'Ctrl+T' })} />);

    const toolbar = container.querySelector('[data-gonavi-titlebar-toolbar="true"]');
    expect(toolbar).not.toBeNull();
    expect(container.querySelector('[data-titlebar-actions-placement="titlebar"]')).toBeNull();
    expect(toolbar?.querySelector('#gonavi-titlebar-quick-actions')).not.toBeNull();
    expect(toolbar?.querySelectorAll('[data-titlebar-toolbar-icon]').length).toBe(4);
    // 工具条不受标题栏显示方式影响，也不带精简名称。
    expect(toolbar?.querySelectorAll('.gn-titlebar-toolbar-item-short-label').length).toBe(0);
    expect(button('[data-gonavi-new-query-action="true"]').title).toBe('New Query · Ctrl+T');

    await act(async () => {
      button('[data-gonavi-create-connection-action="true"]').click();
      button('[data-gonavi-new-query-action="true"]').click();
      button('[data-gonavi-connection-group-management-action="true"]').click();
      button('[data-gonavi-ai-toolbar-action="true"]').click();
    });
    expect(handlers.onNewConnection).toHaveBeenCalledTimes(1);
    expect(handlers.onNewQuery).toHaveBeenCalledTimes(1);
    expect(handlers.onManageConnectionGroups).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleAI).toHaveBeenCalledTimes(1);
  });

  it('inlines the same entries without the toolbar when placed in the title bar', async () => {
    await render(
      <TitleBarActionRow
        {...rowProps(createHandlers(), { placement: 'titlebar', messageQueuePrimary: true, aiActive: true })}
        trailingSlot={<div id="gonavi-titlebar-about-action" />}
      />,
    );

    const inline = container.querySelector('.gonavi-titlebar-inline-actions[data-titlebar-actions-placement="titlebar"]');
    expect(inline).not.toBeNull();
    expect(container.querySelector('[data-gonavi-titlebar-toolbar="true"]')).toBeNull();
    expect(inline?.querySelector('[data-titlebar-primary-actions="true"]')).not.toBeNull();
    expect(inline?.querySelector('#gonavi-titlebar-quick-actions')).not.toBeNull();
    expect(inline?.querySelector('#gonavi-titlebar-about-action')).not.toBeNull();
    expect(button('[data-gonavi-ai-toolbar-action="true"]').getAttribute('aria-pressed')).toBe('true');
    expect(button('[data-gonavi-new-query-action="true"]').getAttribute('aria-label')).toBe('Message workbench');
    expect(inline?.getAttribute('data-titlebar-actions-display')).toBe('text');
  });

  it('keeps full names for tooltips while exposing short labels for the icon + text mode', async () => {
    await render(<TitleBarActionRow {...rowProps(createHandlers(), { placement: 'titlebar', display: 'icon-text' })} />);

    const inline = container.querySelector('.gonavi-titlebar-inline-actions');
    expect(inline?.getAttribute('data-titlebar-actions-display')).toBe('icon-text');
    const shortLabel = (selector: string) => button(selector).querySelector('.gn-titlebar-toolbar-item-short-label')?.textContent;
    expect(shortLabel('[data-gonavi-create-connection-action="true"]')).toBe('Connect');
    expect(shortLabel('[data-gonavi-new-query-action="true"]')).toBe('Query');
    expect(shortLabel('[data-gonavi-connection-group-management-action="true"]')).toBe('Groups');
    const groups = button('[data-gonavi-connection-group-management-action="true"]');
    expect(groups.getAttribute('aria-label')).toBe('Manage connection groups');
    expect(groups.title).toBe('Manage connection groups');
    expect(groups.querySelector('.gn-titlebar-toolbar-item-label')?.classList.contains('has-short-label')).toBe(true);
  });

  it('drives icons, full names and short labels from the display mode in scoped styles', () => {
    const scope = "body\\[data-ui-version='v2'\\] \\.gn-v2-titlebar \\.gonavi-titlebar-inline-actions";
    const rule = (selector: string, body: string) => new RegExp(`${scope}${selector}\\s*\\{[^}]*${body}[^}]*\\}`);
    expect(rowCss).toMatch(/\.gonavi-titlebar-inline-actions\s*\{\s*display:\s*contents;\s*\}/);
    expect(rowCss).toMatch(/\.gn-titlebar-toolbar-item-short-label\s*\{\s*display:\s*none;\s*\}/);
    expect(rowCss).toMatch(rule("\\[data-titlebar-actions-display='text'\\] \\.gn-titlebar-toolbar-item-icon", 'display: none;'));
    expect(rowCss).toMatch(rule(":not\\(\\[data-titlebar-actions-display='text'\\]\\) \\.gn-titlebar-toolbar-item-icon", 'display: inline-flex;'));
    expect(rowCss).toMatch(rule("\\[data-titlebar-actions-display='icon'\\] \\.gn-titlebar-toolbar-item-label", 'display: none;'));
    expect(rowCss).toMatch(rule("\\[data-titlebar-actions-display='icon-text'\\] \\.gn-titlebar-toolbar-item-label\\.has-short-label", 'display: none;'));
    expect(rowCss).toMatch(rule("\\[data-titlebar-actions-display='icon-text'\\] \\.gn-titlebar-toolbar-item-short-label", 'display: inline;'));
  });

  it('moves the sidebar quick actions into the new slot when the placement switches at runtime', async () => {
    const onSqlTools = vi.fn();
    await render(<PlacementHarness onSqlTools={onSqlTools} />);
    const sqlTools = () => Array.from(document.querySelectorAll('[data-titlebar-quick-action="sql-tools"]'));

    expect(sqlTools()).toHaveLength(1);
    expect(sqlTools()[0].closest('[data-gonavi-titlebar-toolbar="true"]')).not.toBeNull();

    const shortLabel = () => sqlTools()[0].querySelector('.gn-titlebar-toolbar-item-short-label')?.textContent;
    expect(shortLabel()).toBeUndefined();

    await act(async () => { useStore.getState().setAppearance({ titlebarActionsPlacement: 'titlebar' }); });
    expect(sqlTools()).toHaveLength(1);
    expect(sqlTools()[0].closest('[data-testid="leading"]')).not.toBeNull();
    expect(document.querySelector('[data-gonavi-titlebar-toolbar="true"]')).toBeNull();
    expect(shortLabel()).toBe('SQL');

    await act(async () => { useStore.getState().setAppearance({ titlebarActionsPlacement: 'toolbar' }); });
    expect(sqlTools()).toHaveLength(1);
    expect(sqlTools()[0].closest('[data-gonavi-titlebar-toolbar="true"]')).not.toBeNull();
    expect(shortLabel()).toBeUndefined();

    await act(async () => { (sqlTools()[0] as HTMLButtonElement).click(); });
    expect(onSqlTools).toHaveBeenCalledTimes(1);
  });

  it('switches the placement from the settings pills', async () => {
    await render(<TitlebarActionsPlacementSettings />);
    const pill = (value: string) => button(`[data-titlebar-actions-placement="${value}"]`);

    const displayPill = (value: string) => button(`[data-titlebar-actions-display="${value}"]`);

    expect(pill('toolbar').getAttribute('aria-pressed')).toBe('true');
    expect(pill('titlebar').textContent).toBe('Title bar, next to GoNavi');
    // 显示方式只对标题栏生效，工具条模式下不出现。
    expect(container.querySelector('[data-titlebar-actions-display-settings="true"]')).toBeNull();

    await act(async () => { pill('titlebar').click(); });
    expect(useStore.getState().appearance.titlebarActionsPlacement).toBe('titlebar');
    expect(pill('titlebar').getAttribute('aria-pressed')).toBe('true');
    expect(pill('toolbar').getAttribute('aria-pressed')).toBe('false');
    expect(Array.from(container.querySelectorAll('[data-titlebar-actions-display]')).map((node) => node.textContent))
      .toEqual(['Text only', 'Icons only', 'Icons + labels']);
    expect(displayPill('text').getAttribute('aria-pressed')).toBe('true');

    await act(async () => { displayPill('icon-text').click(); });
    expect(useStore.getState().appearance.titlebarActionsDisplay).toBe('icon-text');
    expect(displayPill('icon-text').getAttribute('aria-pressed')).toBe('true');
    expect(displayPill('text').getAttribute('aria-pressed')).toBe('false');
  });
});
