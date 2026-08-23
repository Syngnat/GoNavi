import React from 'react';
import { readFileSync } from 'node:fs';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { readV2ThemeCss } from '../test/readV2ThemeCss';
import {
  formatQueryExecutionElapsed,
  resolveQueryExecutionSpeedIcon,
  useQueryExecutionElapsed,
} from './QueryEditorToolbar';

describe('QueryEditorToolbar layout', () => {
  it('keeps the v2 toolbar on a single scrollable row in small windows', () => {
    const toolbarSource = readFileSync(new URL('./QueryEditorToolbar.tsx', import.meta.url), 'utf8');
    const css = readV2ThemeCss();
    const toolbarCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar-main {'),
    );
    const toolbarMainCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar-main {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar-selects {'),
    );
    expect(css).toContain('body[data-ui-version="v2"] .gn-v2-query-toolbar-main');
    expect(toolbarCss).toContain('overflow-x: auto;');
    expect(toolbarCss).toContain('overflow-y: hidden;');
    expect(toolbarCss).toContain('flex-wrap: nowrap;');
    expect(toolbarMainCss).toContain('flex-wrap: nowrap;');
    expect(toolbarMainCss).toContain('min-width: 100%;');
    expect(toolbarMainCss).toContain('width: max-content;');
    expect(css).toContain('body[data-ui-version="v2"] .gn-v2-query-toolbar-actions {');
    expect(css).toContain('body[data-ui-version="v2"] .gn-v2-query-toolbar-action-pair {');
  });

  it('uses the table context-menu density across v2 action menus', () => {
    const css = readV2ThemeCss();
    const baseTokensCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] {'),
      css.indexOf('body[data-ui-version="v2"][data-platform="darwin"] {'),
    );
    const dropdownItemCss = css.slice(
      css.indexOf('/* Compact action menus share the table context-menu geometry. */'),
      css.indexOf('/* Icon + label share one baseline/vertical center'),
    );
    const titlebarMenuCss = css.slice(
      css.indexOf('/* Title-bar more menu: leaf rows and submenu rows share the same hover fill + alignment */'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-titlebar-quick-dropdown .ant-dropdown-menu-item:hover'),
    );
    const tabMenuCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-tab-context-menu-popup .ant-dropdown-menu {'),
      css.indexOf('/* ─── V2 DataGrid: toolbar, smart filters, table, statusbar ─ */'),
    );
    const tableMenuItemCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-context-menu-item {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-context-menu-item:hover {'),
    );
    const monacoMenuCss = css.slice(
      css.indexOf('/* Monaco context menu follows the same compact action-menu surface. */'),
      css.indexOf('/* Nested dropdown menus: collapse double border, no glow/halo */'),
    );

    expect(baseTokensCss).toContain('--gn-v2-menu-row-height: 28px;');
    expect(baseTokensCss).toContain('--gn-v2-menu-item-radius: 5px;');
    expect(dropdownItemCss).toContain('height: var(--gn-v2-menu-row-height) !important;');
    expect(dropdownItemCss).toContain('min-height: var(--gn-v2-menu-row-height) !important;');
    expect(dropdownItemCss).toContain('box-sizing: border-box !important;');
    expect(dropdownItemCss).toContain('padding: 4px 8px !important;');
    expect(titlebarMenuCss).toContain('min-height: var(--gn-v2-menu-row-height) !important;');
    expect(tabMenuCss).not.toContain('min-height: 34px');
    expect(tabMenuCss).not.toContain('.ant-dropdown-menu-item:first-child');
    expect(tableMenuItemCss).toContain('height: var(--gn-v2-menu-row-height);');
    expect(monacoMenuCss).toContain('min-height: var(--gn-v2-menu-row-height) !important;');
    expect(monacoMenuCss).toContain('background: var(--gn-bg-panel) !important;');
  });

  it('shares the active theme surface across the SQL toolbar and Monaco editor', () => {
    const css = readV2ThemeCss();
    const defaultMonacoCss = css.slice(
      css.indexOf('body[data-ui-version="v2"]:not([data-custom-theme]) {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-editor {'),
    );
    const editorCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-editor {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-editor-pane {'),
    );
    const toolbarCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar-main {'),
    );
    const toolbarSelectCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar .ant-select-selector {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar .ant-select-selection-item,'),
    );
    const monacoStageCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-monaco-stage {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-monaco-stage:has('),
    );

    expect(defaultMonacoCss).toContain('--gn-monaco-bg: var(--gn-bg-panel-2);');
    expect(editorCss).toContain('--gn-query-workbench-bg: var(--gn-bg-panel-2);');
    expect(toolbarCss).toContain('background: var(--gn-query-workbench-bg) !important;');
    expect(toolbarSelectCss).toContain('background: var(--gn-query-workbench-bg) !important;');
    expect(monacoStageCss).toContain(
      'background: var(--gn-monaco-bg, var(--gn-query-workbench-bg));',
    );
  });

  it('keeps run and stop buttons separated in the v2 toolbar action group', () => {
    const toolbarSource = readFileSync(new URL('./QueryEditorToolbar.tsx', import.meta.url), 'utf8');
    const css = readV2ThemeCss();
    expect(css).toContain('body[data-ui-version="v2"] .gn-v2-query-toolbar-action-group {');
    expect(css).not.toContain('.gn-v2-query-toolbar-action-group.ant-btn-group');
    expect(css).toContain('gap: 6px;');
  });

  it('formats live query execution time with stable tenths-of-a-second precision', () => {
    expect(formatQueryExecutionElapsed(0)).toBe('00:00.0');
    expect(formatQueryExecutionElapsed(61_299)).toBe('01:01.2');
    expect(formatQueryExecutionElapsed(3_661_999)).toBe('01:01:01.9');
    expect(formatQueryExecutionElapsed(Number.NaN)).toBe('00:00.0');
  });

  it('uses distinct speed icons at the one- and five-second boundaries', () => {
    expect(resolveQueryExecutionSpeedIcon(0)).toBe('⚡');
    expect(resolveQueryExecutionSpeedIcon(999)).toBe('⚡');
    expect(resolveQueryExecutionSpeedIcon(1_000)).toBe('🐇');
    expect(resolveQueryExecutionSpeedIcon(4_999)).toBe('🐇');
    expect(resolveQueryExecutionSpeedIcon(5_000)).toBe('🐢');
  });

  it('keeps the completed duration until the next execution starts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let elapsedMs = -1;
    let renderer: ReactTestRenderer | null = null;

    const Harness: React.FC<{ loading: boolean; runToken: number }> = ({ loading, runToken }) => {
      elapsedMs = useQueryExecutionElapsed(loading, runToken);
      return null;
    };

    try {
      act(() => {
        renderer = create(<Harness loading={false} runToken={0} />);
      });
      expect(elapsedMs).toBe(0);

      act(() => {
        renderer?.update(<Harness loading runToken={1} />);
      });
      act(() => {
        vi.advanceTimersByTime(350);
      });
      expect(elapsedMs).toBe(300);

      act(() => {
        renderer?.update(<Harness loading runToken={2} />);
      });
      expect(elapsedMs).toBe(0);

      act(() => {
        vi.advanceTimersByTime(350);
      });
      expect(elapsedMs).toBe(300);

      act(() => {
        renderer?.update(<Harness loading={false} runToken={2} />);
      });
      expect(elapsedMs).toBe(350);

      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(elapsedMs).toBe(350);

      act(() => {
        renderer?.update(<Harness loading runToken={3} />);
      });
      expect(elapsedMs).toBe(0);
    } finally {
      act(() => {
        renderer?.unmount();
      });
      vi.useRealTimers();
    }
  });

  it('keeps live and completed execution time at the editor bottom-left', () => {
    const toolbarSource = readFileSync(new URL('./QueryEditorToolbar.tsx', import.meta.url), 'utf8');
    const editorSource = readFileSync(new URL('./QueryEditor.tsx', import.meta.url), 'utf8');
    const css = readV2ThemeCss();
    const statusbarCss = css.slice(
      css.indexOf('.gn-query-execution-statusbar {'),
      css.indexOf('.gn-query-execution-timer {'),
    );
    const elapsedCss = css.slice(
      css.indexOf('.gn-query-execution-elapsed {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-resizer {'),
    );

    expect(toolbarSource).toContain('globalThis.setInterval(updateElapsed, QUERY_EXECUTION_TIMER_INTERVAL_MS)');
    expect(toolbarSource).toContain('startedAtRef.current = null');
    expect(toolbarSource).not.toContain('gn-query-toolbar-execution-slot');
    expect(editorSource).toContain('className="gn-query-execution-statusbar"');
    expect(editorSource).toContain('className="gn-query-execution-timer"');
    expect(editorSource).toContain('role="timer"');
    expect(editorSource).toContain('query_editor.execution.elapsed');
    const statusbarIndex = editorSource.indexOf('className="gn-query-execution-statusbar"');
    expect(statusbarIndex).toBeGreaterThan(editorSource.indexOf('<Editor'));
    expect(statusbarIndex).toBeLessThan(editorSource.indexOf('<QueryEditorResultsPanel', statusbarIndex));
    expect(statusbarCss).toContain('flex: 0 0 22px;');
    expect(statusbarCss).toContain('padding: 0 10px;');
    expect(elapsedCss).toContain('min-width: 10ch;');
    expect(elapsedCss).toContain('font-variant-numeric: tabular-nums;');
    expect(elapsedCss).toContain('letter-spacing: 0;');
  });

  it('optically centers the word-wrap icon in its v2 icon-only action', () => {
    const toolbarSource = readFileSync(new URL('./QueryEditorToolbar.tsx', import.meta.url), 'utf8');
    const css = readV2ThemeCss();
    const wordWrapCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar-word-wrap-action.ant-btn,'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar-action-group {'),
    );
    expect(wordWrapCss).toContain('align-items: center;');
    expect(wordWrapCss).toContain('justify-content: center;');
    expect(wordWrapCss).toContain('width: 16px;');
    expect(wordWrapCss).toContain('height: 16px;');
    expect(wordWrapCss).not.toContain('translateY');
  });

  it('keeps commit button hover styling in source and v2 css', () => {
    const css = readV2ThemeCss();
    const commitBaseCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-transaction-commit-button {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-transaction-commit-button:hover,'),
    );
    const commitHoverCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-transaction-commit-button:hover,'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-transaction-commit-button .gn-v2-toolbar-kbd {'),
    );
    const commitKbdHoverCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-transaction-commit-button:hover .gn-v2-toolbar-kbd,'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar-icon-action.ant-btn,'),
    );

    expect(css).toContain('.gn-v2-query-transaction-commit-button:hover');
    expect(css).toContain('.gn-v2-query-transaction-commit-button:focus-visible');
    expect(commitBaseCss).toContain('background: var(--gn-warn) !important;');
    expect(commitHoverCss).toContain(
      'background: var(--gn-warn-hover, var(--gn-warn)) !important;',
    );
    expect(commitHoverCss).toContain('box-shadow:');
    expect(commitKbdHoverCss).toContain('background:');
  });

  it('keeps transaction selectors compact after replacing selected labels with icons', () => {
    const css = readV2ThemeCss();
    const transactionModeCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar-transaction-mode-select {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar-transaction-delay-select {'),
    );
    const transactionDelayCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar-transaction-delay-select {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar .ant-select-selector {'),
    );

    expect(transactionModeCss).toContain('width: 48px !important;');
    expect(transactionModeCss).toContain('flex: 0 0 48px !important;');
    expect(transactionDelayCss).toContain('width: 48px !important;');
    expect(transactionDelayCss).toContain('flex: 0 0 48px !important;');
    expect(css).toContain(
      'body[data-ui-version="v2"] .gn-v2-query-toolbar .gn-v2-query-toolbar-icon-select .ant-select-selector {',
    );
  });

  it('uses a stable icon-button width for every v2 SQL toolbar action', () => {
    const toolbarSource = readFileSync(new URL('./QueryEditorToolbar.tsx', import.meta.url), 'utf8');
    const css = readV2ThemeCss();
    const iconActionCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar-icon-action.ant-btn,'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar-run-action.ant-btn {'),
    );
    expect(iconActionCss).toContain('width: 34px !important;');
    expect(iconActionCss).toContain('min-width: 34px !important;');
    expect(iconActionCss).toContain('padding: 0 !important;');
  });

  it('shows delayed full-name tooltips for truncated connection database and schema selectors', () => {
    const toolbarSource = readFileSync(new URL('./QueryEditorToolbar.tsx', import.meta.url), 'utf8');
    const css = readV2ThemeCss();
    const connectionSelectSource = toolbarSource.slice(
      toolbarSource.indexOf('gn-v2-query-toolbar-connection-select'),
      toolbarSource.indexOf('gn-v2-query-toolbar-database-select'),
    );
    const databaseSelectSource = toolbarSource.slice(
      toolbarSource.indexOf('gn-v2-query-toolbar-database-select'),
      toolbarSource.indexOf('gn-v2-query-toolbar-schema-select'),
    );
    const schemaSelectSource = toolbarSource.slice(
      toolbarSource.indexOf('gn-v2-query-toolbar-schema-select'),
      toolbarSource.indexOf('gn-v2-query-toolbar-max-rows-select'),
    );
    expect(connectionSelectSource).toContain('renderFullNameSelectTooltip');
    expect(databaseSelectSource).toContain('renderFullNameSelectTooltip');
    expect(schemaSelectSource).toContain('renderFullNameSelectTooltip');
    expect(css).toContain('.gn-v2-query-toolbar-schema-select {');
    expect(css).toContain('.gn-query-toolbar-select-full-name {');
    expect(css).toContain('text-overflow: ellipsis;');
    expect(css).toContain('white-space: nowrap;');
  });

  it('uses the table context-menu visual grammar for every v2 action popup', () => {
    const toolbarSource = readFileSync(new URL('./QueryEditorToolbar.tsx', import.meta.url), 'utf8');
    const queryEditorSource = readFileSync(new URL('./QueryEditor.tsx', import.meta.url), 'utf8');
    const sharedPopupSource = readFileSync(new URL('./common/V2ActionMenuPopup.tsx', import.meta.url), 'utf8');
    const css = readV2ThemeCss();

    expect(toolbarSource).toContain('renderV2ActionMenuPopup');
    expect(queryEditorSource).toContain('decorateV2MonacoContextMenu');
    expect(queryEditorSource).toContain('window.setTimeout(decorateV2MonacoContextMenu, 0)');
    expect(queryEditorSource).toContain('window.setTimeout(decorateV2MonacoContextMenu, 48)');
    expect(queryEditorSource).toContain('window.setTimeout(decorateV2MonacoContextMenu, 120)');
    expect(sharedPopupSource).toContain('gn-v2-context-menu-header gn-v2-action-menu-header');
    expect(sharedPopupSource).toContain('gn-v2-context-menu-engine-pill');
    expect(sharedPopupSource).toContain('.monaco-menu {');
    expect(sharedPopupSource).toContain('font-family: var(--gn-font-sans) !important;');
    expect(sharedPopupSource).toContain('color: var(--gn-fg-1) !important;');
    expect(sharedPopupSource).toContain('background: transparent !important;');
    expect(sharedPopupSource).toContain('background: var(--gn-bg-active) !important;');
    expect(sharedPopupSource).toContain('.monaco-menu .monaco-action-bar.vertical .action-item > .action-menu-item:hover');
    expect(sharedPopupSource).toContain('.monaco-menu .monaco-action-bar.vertical .action-item > .action-menu-item:focus');
    expect(sharedPopupSource).not.toContain('gn-v2-monaco-context-menu-header');
    expect(sharedPopupSource).not.toContain('menu.prepend(header)');
    expect(css).toContain('.gn-v2-action-menu-surface {');
    expect(css).toContain('.gn-v2-action-menu-body .ant-dropdown-menu-item-group-title {');
    expect(css).toContain('.gn-v2-action-menu-body .ant-dropdown-menu-item:not(:has(.ant-dropdown-menu-item-icon))::before');
    expect(css).toContain('body[data-ui-version="v2"] .monaco-menu {');
    expect(css).toContain('body[data-ui-version="v2"] .monaco-menu .monaco-action-bar .action-item .action-label.separator {');
    expect(css).not.toContain('.monaco-menu > .gn-v2-monaco-context-menu-header {');
  });

  it('uses the title-bar more menu surface for editor action popups', () => {
    const toolbarSource = readFileSync(new URL('./QueryEditorToolbar.tsx', import.meta.url), 'utf8');
    expect(toolbarSource).toContain("showHeader: false");
    expect(toolbarSource).toContain('gn-v2-titlebar-quick-dropdown');
  });

  it('uses distinct case icons for keyword case actions', () => {
    const queryEditorSource = readFileSync(new URL('./QueryEditor.tsx', import.meta.url), 'utf8');
    const css = readV2ThemeCss();
    const caseIconCss = css.match(/\.gn-query-format-case-icon \{[\s\S]*?\}/)?.[0] || '';
    expect(queryEditorSource).toContain('gn-query-format-case-icon-upper');
    expect(queryEditorSource).toContain('gn-query-format-case-icon-lower');
    expect(queryEditorSource).toContain('>AA</span>');
    expect(queryEditorSource).toContain('>aa</span>');
    expect(queryEditorSource).not.toContain('FontSizeOutlined');
    expect(queryEditorSource).not.toContain('FontColorsOutlined');
    expect(queryEditorSource).not.toContain('ArrowUpOutlined');
    expect(queryEditorSource).not.toContain('ArrowDownOutlined');
    expect(caseIconCss).toContain('.gn-query-format-case-icon {');
    expect(caseIconCss).toContain('width: 14px;');
    expect(caseIconCss).toContain('height: 14px;');
    expect(caseIconCss).toContain('font-size: 10px;');
    expect(caseIconCss).toContain('font-weight: 400;');
  });
});
