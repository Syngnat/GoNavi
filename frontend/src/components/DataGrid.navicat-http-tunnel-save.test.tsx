import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DataGrid, { GONAVI_ROW_KEY } from './DataGrid';
import DataGridShell from './DataGridShell';
import DataGridToolbarFrame from './DataGridToolbarFrame';
import DataGridPreviewPanel from './DataGridPreviewPanel';
import type { DataGridProps } from './DataGridCore';
import { t } from '../i18n';
import type { ConnectionConfig } from '../types';
import { getDirtyWorkbenchTabCloseGuards } from '../utils/workbenchTabCloseProtection';
import { backendApp, messageApi, storeState, testRenderState } from './dataGridDdlTestState';
import { findButton, waitForEffects, createRenderedCellTarget } from './dataGridDdlTestHelpers';
import { setUpDataGridDdlTest, tearDownDataGridDdlTest } from './dataGridDdlTestHooks';

vi.mock('../store', async () => (await import('./dataGridDdlTestState')).mockModule1());
vi.mock('../../wailsjs/go/app/App', async () => (await import('./dataGridDdlTestState')).mockModule2());
vi.mock('../../wailsjs/runtime/runtime', async () => (await import('./dataGridDdlTestState')).mockModule3());
vi.mock('react-dom', async () => (await import('./dataGridDdlTestState')).mockModule4());
vi.mock('@monaco-editor/react', async () => (await import('./dataGridDdlTestState')).mockModule5());
vi.mock('./ImportPreviewModal', async () => (await import('./dataGridDdlTestState')).mockModule6());
vi.mock('./TableDesigner', async () => (await import('./dataGridDdlTestState')).mockModule7());
vi.mock('@ant-design/icons', async () => (await import('./dataGridDdlTestState')).mockModule8());
vi.mock('@dnd-kit/core', async () => (await import('./dataGridDdlTestState')).mockModule9());
vi.mock('@dnd-kit/sortable', async () => (await import('./dataGridDdlTestState')).mockModule10());
vi.mock('@dnd-kit/utilities', async () => (await import('./dataGridDdlTestState')).mockModule11());
vi.mock('antd', async () => (await import('./dataGridDdlTestState')).mockModule12());

const reasonKey = 'data_grid.message.navicat_http_tunnel_save_unsupported';
const scriptTunnel = {
  useHttpTunnel: true,
  httpTunnel: { host: 'https://example.test/ntunnel_mysql.php', port: 443 },
};
const baseProps: DataGridProps = {
  data: [{ [GONAVI_ROW_KEY]: 'row-1', id: 1, name: 'Ada' }],
  columnNames: ['id', 'name'], loading: false, tableName: 'users',
  dbName: 'main', connectionId: 'conn-1', pkColumns: ['id'], workbenchTabId: 'tunnel-grid',
};
const originalConfig = { ...storeState.connections[0].config };
let renderer: ReactTestRenderer | undefined;

const setConnection = (overrides: Partial<ConnectionConfig> = {}) => {
  storeState.connections[0].config = { ...originalConfig, ...overrides };
};
const renderGrid = async (props: DataGridProps = baseProps) => {
  await act(async () => { renderer = create(<DataGrid {...props} />); });
  await waitForEffects();
  return renderer!;
};
const switchToScriptTunnel = async () => {
  setConnection(scriptTunnel);
  await act(async () => { renderer!.update(<DataGrid {...baseProps} onReload={() => undefined} />); });
  await waitForEffects();
  expect(renderer!.root.findByType(DataGridToolbarFrame).props.canModifyData).toBe(false);
};
const addPendingRow = async () => {
  await act(async () => { renderer!.root.findByType(DataGridToolbarFrame).props.onAddRow(); });
  await waitForEffects();
  expect(renderer!.root.findByType(DataGridToolbarFrame).props.pendingChangeCount).toBe(1);
};

const pressSaveShortcut = async (targetInGrid: boolean) => {
  const removed = new Set(vi.mocked(window.removeEventListener).mock.calls.map(([, listener]) => listener));
  const listeners = vi.mocked(window.addEventListener).mock.calls
    .filter(([name, listener, capture]) => name === 'keydown' && capture === true && !removed.has(listener))
    .map(([, listener]) => listener as EventListener);
  const event = {
    key: 's', code: 'KeyS', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
    isComposing: false,
    target: { closest: (selector: string) => targetInGrid && selector === '.data-grid-root' ? {} : null },
    preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
  };
  await act(async () => {
    listeners.forEach((listener) => listener(event as unknown as KeyboardEvent));
    await Promise.resolve();
  });
  return event;
};

describe('data grid saving through Navicat HTTP script tunnels', () => {
  beforeEach(() => {
    setConnection();
    setUpDataGridDdlTest();
    messageApi.warning.mockClear();
    messageApi.info.mockClear();
    backendApp.ApplyChanges.mockResolvedValue({ success: true, data: { inserts: [], updates: [], deletes: [] } });
    backendApp.PreviewChanges.mockResolvedValue({ success: true, data: { inserts: [], updates: [], deletes: [] } });
  });
  afterEach(() => {
    act(() => { renderer?.unmount(); });
    renderer = undefined;
    setConnection();
    tearDownDataGridDdlTest();
  });

  it('explains the restriction and refuses new row, cell and paste edits while keeping browsing available', async () => {
    setConnection(scriptTunnel);
    const grid = await renderGrid();
    const toolbar = grid.root.findByType(DataGridToolbarFrame);
    expect(toolbar.props.canModifyData).toBe(false);
    const disabledCommit = grid.root.findByProps({ 'data-grid-disabled-action': 'commit' });
    expect(disabledCommit.props).toMatchObject({ role: 'button', tabIndex: 0, 'aria-disabled': 'true' });
    expect(disabledCommit.props['aria-label']).toContain(t(reasonKey));
    expect(disabledCommit.findByType('button').props).toMatchObject({ disabled: true, 'aria-hidden': 'true', tabIndex: -1 });
    expect(grid.root.findByProps({ className: 'data-grid-save-restriction-label' }).children)
      .toEqual([t('data_grid.toolbar.navicat_http_tunnel_read_only')]);
    expect(findButton(grid, t('data_grid.toolbar.export'))).toBeTruthy();
    await act(async () => {
      toolbar.props.onAddRow();
      testRenderState.latestTableProps.rowSelection.onChange(['row-1']);
    });
    await act(async () => { grid.root.findByType(DataGridToolbarFrame).props.onDeleteSelected(); });
    const shell = grid.root.findByType(DataGridShell);
    await act(async () => {
      shell.props.handlePasteCopiedRowsAsNew();
      shell.props.handleOpenContextMenuRowEditor();
    });
    const doubleClickSurface = grid.root.findAll(
      (node) => typeof node.props.onDoubleClickCapture === 'function',
    )[0];
    await act(async () => {
      doubleClickSurface.props.onDoubleClickCapture({
        target: createRenderedCellTarget('row-1', 'name'),
        preventDefault: vi.fn(), stopPropagation: vi.fn(),
      });
    });
    expect(grid.root.findAllByProps({ 'data-modal-title': t('data_grid.cell_viewer.title_with_column', { column: 'name' }) }))
      .toHaveLength(1);
    expect(grid.root.findAllByProps({ 'data-grid-virtual-inline-input': 'true' })).toHaveLength(0);
    expect(grid.root.findByType(DataGridToolbarFrame).props.hasChanges).toBe(false);
    expect(testRenderState.latestTableProps.dataSource).toHaveLength(1);
    expect(backendApp.ApplyChanges).not.toHaveBeenCalled();
  });

  it.each(['manual', 'auto'] as const)('blocks direct %s saves without losing existing edits', async (source) => {
    await renderGrid();
    await addPendingRow();
    await switchToScriptTunnel();
    let saved: boolean | undefined;
    await act(async () => { saved = await renderer!.root.findByType(DataGridToolbarFrame).props.onCommit(source); });
    expect(saved).toBe(false);
    expect(backendApp.ApplyChanges).not.toHaveBeenCalled();
    expect(storeState.addSqlLog).not.toHaveBeenCalled();
    expect(messageApi.warning).toHaveBeenCalledWith(t(reasonKey));
    expect(renderer!.root.findByType(DataGridToolbarFrame).props.pendingChangeCount).toBe(1);
    expect(getDirtyWorkbenchTabCloseGuards(['tunnel-grid'])).toHaveLength(1);
  });

  it('keeps preview and explicit rollback available for edits made before switching transport', async () => {
    await renderGrid();
    await addPendingRow();
    const pendingRows = [...testRenderState.latestTableProps.dataSource];
    await switchToScriptTunnel();
    expect(testRenderState.latestTableProps.dataSource).toEqual(pendingRows);
    await act(async () => { await findButton(renderer!, t('data_grid.toolbar.preview_sql')).props.onClick(); });
    expect(backendApp.PreviewChanges).toHaveBeenCalledOnce();
    expect(renderer!.root.findByType(DataGridToolbarFrame).props.hasChanges).toBe(true);
    await act(async () => { findButton(renderer!, t('data_grid.toolbar.rollback')).props.onClick(); });
    expect(renderer!.root.findByType(DataGridToolbarFrame).props.hasChanges).toBe(false);
    expect(getDirtyWorkbenchTabCloseGuards(['tunnel-grid'])).toHaveLength(0);
    expect(backendApp.ApplyChanges).not.toHaveBeenCalled();
  });

  it('cancels scheduled auto commit when transport becomes a script tunnel', async () => {
    vi.useFakeTimers();
    storeState.dataEditTransactionOptions = { commitMode: 'auto', autoCommitDelayMs: 3000 };
    await renderGrid();
    await addPendingRow();
    expect(renderer!.root.findByType(DataGridToolbarFrame).props.autoCommitRemainingSeconds).not.toBeNull();
    await switchToScriptTunnel();
    await act(async () => { vi.advanceTimersByTime(10000); await Promise.resolve(); });
    expect(backendApp.ApplyChanges).not.toHaveBeenCalled();
    expect(renderer!.root.findByType(DataGridToolbarFrame).props.pendingChangeCount).toBe(1);
    expect(renderer!.root.findByType(DataGridToolbarFrame).props.autoCommitRemainingSeconds).toBeNull();
  });

  it('explains an in-grid save shortcut and does not consume shortcuts outside the grid', async () => {
    await renderGrid();
    await addPendingRow();
    await switchToScriptTunnel();
    const outsideEvent = await pressSaveShortcut(false);
    expect(outsideEvent.preventDefault).not.toHaveBeenCalled();
    expect(messageApi.warning).not.toHaveBeenCalled();
    const insideEvent = await pressSaveShortcut(true);
    expect(insideEvent.preventDefault).toHaveBeenCalledOnce();
    expect(messageApi.warning).toHaveBeenCalledWith(t(reasonKey));
    expect(backendApp.ApplyChanges).not.toHaveBeenCalled();
    expect(renderer!.root.findByType(DataGridToolbarFrame).props.pendingChangeCount).toBe(1);
  });

  it('refuses save on close and keeps the guard dirty until explicit discard', async () => {
    await renderGrid();
    await addPendingRow();
    await switchToScriptTunnel();
    const [{ guard }] = getDirtyWorkbenchTabCloseGuards(['tunnel-grid']);
    let saved: boolean | undefined;
    await act(async () => { saved = await guard.save(); });
    expect(saved).toBe(false);
    expect(guard.isDirty()).toBe(true);
    expect(backendApp.ApplyChanges).not.toHaveBeenCalled();
    expect(messageApi.warning).toHaveBeenCalledWith(t(reasonKey));
    await act(async () => { await guard.discard(); });
    expect(getDirtyWorkbenchTabCloseGuards(['tunnel-grid'])).toHaveLength(0);
    expect(renderer!.root.findByType(DataGridToolbarFrame).props.hasChanges).toBe(false);
  });

  it('preserves a dirty preview-panel draft when save on close is refused', async () => {
    await renderGrid();
    await act(async () => { renderer!.root.findByType(DataGridShell).props.toggleDataPanel(); });
    await act(async () => {
      renderer!.root.findByType(DataGridShell).props.handleVirtualTableClickCapture({
        target: createRenderedCellTarget('row-1', 'name'),
      });
    });
    const panel = renderer!.root.findByType(DataGridPreviewPanel);
    expect(panel.props.focusedCellWritable).toBe(true);
    await act(async () => {
      panel.props.onValueChange('unsaved panel draft');
      panel.props.onDirtyChange(true);
    });
    expect(renderer!.root.findByType(DataGridToolbarFrame).props.hasChanges).toBe(false);
    await switchToScriptTunnel();
    const [{ guard }] = getDirtyWorkbenchTabCloseGuards(['tunnel-grid']);
    let saved: boolean | undefined;
    await act(async () => { saved = await guard.save(); });
    expect(saved).toBe(false);
    expect(guard.isDirty()).toBe(true);
    expect(renderer!.root.findByType(DataGridPreviewPanel).props.dataPanelValue).toBe('unsaved panel draft');
    expect(renderer!.root.findByType(DataGridPreviewPanel).props.focusedCellWritable).toBe(false);
    expect(messageApi.warning).toHaveBeenCalledWith(t(reasonKey));
    expect(backendApp.ApplyChanges).not.toHaveBeenCalled();
    expect(renderer!.root.findByType(DataGridShell).props.dataPanelOriginalRef.current).toBe('Ada');
    await act(async () => { await guard.discard(); });
    expect(getDirtyWorkbenchTabCloseGuards(['tunnel-grid'])).toHaveLength(0);
    expect(renderer!.root.findByType(DataGridPreviewPanel).props.dataPanelValue).toBe('Ada');
  });

  it('does not apply an open row editor after switching to a script tunnel', async () => {
    await renderGrid();
    await act(async () => { renderer!.root.findByType(DataGridShell).props.openCurrentViewRowEditor(); });
    expect(renderer!.root.findByType(DataGridShell).props.rowEditorOpen).toBe(true);
    await switchToScriptTunnel();
    const shell = renderer!.root.findByType(DataGridShell);
    shell.props.rowEditorForm.getFieldsValue = () => ({ id: 1, name: 'unsaved row draft' });
    await act(async () => { shell.props.applyRowEditor(); });
    expect(renderer!.root.findByType(DataGridToolbarFrame).props.hasChanges).toBe(false);
    expect(testRenderState.latestTableProps.dataSource[0].name).toBe('Ada');
    expect(renderer!.root.findByType(DataGridShell).props.rowEditorOpen).toBe(true);
    expect(backendApp.ApplyChanges).not.toHaveBeenCalled();
  });

  it('ignores an inline save whose validation finishes after the transport changes', async () => {
    await renderGrid();
    await act(async () => {
      renderer!.root.findByType(DataGridShell).props.handleVirtualTableDoubleClickCapture({
        target: createRenderedCellTarget('row-1', 'name'),
        preventDefault: vi.fn(), stopPropagation: vi.fn(),
      });
    });
    const row = testRenderState.latestTableProps.dataSource[0];
    const column = testRenderState.latestColumns.find((item) => item.key === 'name');
    const editingCell = create(<div>{column.render(row.name, row, 0)}</div>);
    const blur = editingCell.root.findByProps({ className: 'data-grid-inline-editor-input' }).props.onBlur;
    editingCell.unmount();
    let resolveValidation!: (value: Record<string, unknown>) => void;
    testRenderState.formValidateFields.mockImplementationOnce(() => new Promise((resolve) => {
      resolveValidation = resolve;
    }));
    testRenderState.formGetFieldValue.mockReturnValue('late inline draft');
    await act(async () => { blur(); await Promise.resolve(); });
    expect(testRenderState.formValidateFields).toHaveBeenCalledOnce();
    testRenderState.formGetFieldValue.mockClear();
    await switchToScriptTunnel();
    await act(async () => { resolveValidation({}); await Promise.resolve(); });
    expect(testRenderState.formGetFieldValue).not.toHaveBeenCalled();
    expect(testRenderState.latestTableProps.dataSource[0].name).toBe('Ada');
    expect(renderer!.root.findByType(DataGridToolbarFrame).props.hasChanges).toBe(false);
  });

  it.each(['direct', 'http-connect'] as const)('preserves the normal %s commit path', async (transport) => {
    if (transport === 'http-connect') setConnection({ useHttpTunnel: true, httpTunnel: { host: 'proxy.test', port: 8080 } });
    await renderGrid();
    expect(renderer!.root.findByType(DataGridToolbarFrame).props.canModifyData).toBe(true);
    expect(renderer!.root.findAllByProps({ 'data-grid-disabled-action': 'commit' })).toHaveLength(0);
    await addPendingRow();
    await act(async () => { await renderer!.root.findByType(DataGridToolbarFrame).props.onCommit(); });
    expect(backendApp.ApplyChanges).toHaveBeenCalledOnce();
    expect(renderer!.root.findByType(DataGridToolbarFrame).props.hasChanges).toBe(false);
  });
});
