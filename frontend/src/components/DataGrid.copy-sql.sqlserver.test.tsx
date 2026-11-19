import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DataGrid from './DataGrid';
import { t } from '../i18n';
import { backendApp, storeState, testRenderState } from './dataGridDdlTestState';
import { createRenderedCellTarget, findButton, waitForEffects } from './dataGridDdlTestHelpers';
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

describe('DataGrid SQL Server copy-as-SQL', () => {
  beforeEach(setUpDataGridDdlTest);
  afterEach(tearDownDataGridDdlTest);

  it('quotes INSERT identifiers with SQL Server brackets through the real context menu', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    backendApp.DBGetColumns.mockResolvedValue({
      success: true,
      data: [
        { Name: 'id', Type: 'bigint' },
        { Name: 'name', Type: 'nvarchar' },
      ],
    });

    const rows = [{ __gonavi_row_key__: 'row-1', id: 1, name: 'alpha' }];
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={rows}
          columnNames={['id', 'name']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          pkColumns={['id']}
        />,
      );
    });
    await waitForEffects();

    const idColumn = testRenderState.latestColumns.find((column) => column.key === 'id');
    expect(idColumn).toBeTruthy();
    await act(async () => {
      idColumn.onCell(rows[0]).onContextMenu({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientX: 120,
        clientY: 88,
        currentTarget: createRenderedCellTarget('row-1', 'id'),
        target: createRenderedCellTarget('row-1', 'id'),
      });
    });

    await act(async () => {
      findButton(renderer, t('data_grid.context_menu.copy_as_insert')).props.onClick({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    const copied = String((navigator.clipboard.writeText as any).mock.calls.at(-1)?.[0] || '');
    expect(copied).toContain('INSERT INTO [users] ([id], [name]) VALUES');
    expect(copied).toContain("VALUES ('1', N'alpha');");
    expect(copied).not.toContain('`');
    renderer.unmount();
  });
});
