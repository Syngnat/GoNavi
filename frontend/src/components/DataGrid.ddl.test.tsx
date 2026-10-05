import { readFileSync } from 'node:fs';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DataGrid, {
    attachDataGridVirtualEditRenderVersion,
    buildColumnMetaMap,
    buildDataGridCommitChangeSet,
    collectDataGridCellSelectionRowKeys,
    filterDataGridCellSelectionToVisibleRows,
    resolveDataGridCellSelectionAnchor,
    collectDataGridFillTemplateTargetRowKeys,
    GONAVI_ROW_KEY,
    hasDataGridVirtualEditRenderVersionChanged,
    shouldOmitBlankDataGridInsertValue,
} from './DataGrid';
import DataGridPageFind from './DataGridPageFind';
import DataGridToolbarFrame from './DataGridToolbarFrame';
import { t } from '../i18n';
import { parseMongoEditedValue } from '../utils/mongodb';
import { DUCKDB_ROWID_LOCATOR_COLUMN, ORACLE_ROWID_LOCATOR_COLUMN } from '../utils/rowLocator';
import {
  storeState,
  backendApp,
  testRenderState,
  messageApi,
} from './dataGridDdlTestState';
import {
    textContent,
    findButton,
    waitForEffects,
    normalizeValue,
    rowKeyToString,
    commitColumnGuard,
} from './dataGridDdlTestHelpers';
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

describe('DataGrid cell selection row keys', () => {
  it('deduplicates every record covered by a rectangular cell selection', () => {
    const cellKeys = Array.from({ length: 6 }, (_, rowIndex) => (
      ['id', 'user_id', 'app_key'].map((columnName) => `row-${rowIndex + 1}\u0001${columnName}`)
    )).flat();

    expect(collectDataGridCellSelectionRowKeys([
      ...cellKeys,
      'row-3\u0001id',
      'malformed-cell-key',
      '\u0001empty-row-key',
    ])).toEqual(['row-1', 'row-2', 'row-3', 'row-4', 'row-5', 'row-6']);
  });

  it('merges checked and cell-selected rows while excluding the fill-template source row', () => {
    expect(collectDataGridFillTemplateTargetRowKeys({
      selectedRowKeys: ['row-1', 'row-2', 'row-2'],
      selectedCellKeys: [
        'row-1\u0001name',
        'row-3\u0001id',
        'row-3\u0001name',
      ],
      sourceRowKey: 'row-1',
      rowKeyToString: String,
    })).toEqual(['row-2', 'row-3']);
  });

  it('keeps only cell selections belonging to currently visible rows', () => {
    expect(filterDataGridCellSelectionToVisibleRows({
      cellKeys: [
        'row-1\u0001name',
        'row-2\u0001name',
        'row-3\u0001name',
        'malformed-cell-key',
      ],
      rows: [
        { __gonavi_row_key__: 'row-1' },
        { __gonavi_row_key__: 'row-3' },
      ],
    })).toEqual(new Set(['row-1\u0001name', 'row-3\u0001name']));
  });

  it('moves a hidden selection anchor to the first visible selected cell', () => {
    expect(resolveDataGridCellSelectionAnchor({
      cellKeys: [
        'row-2\u0001name',
        'row-3\u0001id',
        'row-3\u0001name',
      ],
      rows: [
        { __gonavi_row_key__: 'row-3' },
        { __gonavi_row_key__: 'row-2' },
      ],
      columnNames: ['id', 'name'],
      preferredAnchor: { rowKey: 'row-1', colName: 'name' },
    })).toEqual({
      rowKey: 'row-3',
      colName: 'id',
      rowIndex: 0,
      colIndex: 0,
    });
  });
});

describe('DataGrid commit change set', () => {
  it('omits blank generated columns from inserts while preserving ordinary blank values', () => {
    const columnMetaMap = buildColumnMetaMap([
      {
        name: 'id',
        type: 'bigint',
        nullable: 'NO',
        key: 'PRI',
        default: "nextval('users_id_seq'::regclass)",
        extra: 'auto_increment',
        comment: '',
      },
      {
        name: 'display_name',
        type: 'text',
        nullable: 'NO',
        key: '',
        extra: '',
        comment: '',
      },
    ]);
    const normalizeInsertValue = (columnName: string, value: any, mode: 'insert' | 'update') => (
      shouldOmitBlankDataGridInsertValue(value, mode, columnMetaMap[columnName])
        ? undefined
        : value
    );

    const result = buildDataGridCommitChangeSet({
      addedRows: [{ [GONAVI_ROW_KEY]: 'new-1', id: '', display_name: '' }],
      modifiedRows: {},
      deletedRowKeys: new Set(),
      data: [],
      editLocator: {
        strategy: 'primary-key',
        columns: ['id'],
        valueColumns: ['id'],
        readOnly: false,
      },
      visibleColumnNames: ['id', 'display_name'],
      rowKeyToString,
      normalizeCommitCellValue: normalizeInsertValue,
      shouldCommitColumn: commitColumnGuard,
    });

    expect(columnMetaMap.id).toMatchObject({
      default: "nextval('users_id_seq'::regclass)",
      extra: 'auto_increment',
      nullable: 'NO',
    });
    expect(result).toEqual({
      ok: true,
      changes: {
        inserts: [{ display_name: '' }],
        updates: [],
        deletes: [],
        previousDeletes: [],
        locatorStrategy: 'primary-key',
        locatorColumns: [{ key: 'id' }],
      },
    });
  });

  it('does not omit generated-column nulls or blank values during updates', () => {
    const generatedMeta = {
      type: 'bigint',
      comment: '',
      default: "nextval('users_id_seq'::regclass)",
      extra: 'auto_increment',
      nullable: 'NO',
    };

    expect(shouldOmitBlankDataGridInsertValue('', 'insert', generatedMeta)).toBe(true);
    expect(shouldOmitBlankDataGridInsertValue(null, 'insert', generatedMeta)).toBe(false);
    expect(shouldOmitBlankDataGridInsertValue('', 'update', generatedMeta)).toBe(false);
    expect(shouldOmitBlankDataGridInsertValue('', 'insert', { ...generatedMeta, default: '', extra: '' })).toBe(false);
  });

  it('uses unique locator values instead of falling back to the whole row', () => {
    const result = buildDataGridCommitChangeSet({
      addedRows: [],
      modifiedRows: {
        'row-1': { [GONAVI_ROW_KEY]: 'row-1', EMAIL: 'a@example.com', NAME: 'new-name', AGE: 42 },
      },
      deletedRowKeys: new Set(),
      data: [{ [GONAVI_ROW_KEY]: 'row-1', EMAIL: 'a@example.com', NAME: 'old-name', AGE: 42 }],
      editLocator: {
        strategy: 'unique-key',
        columns: ['EMAIL'],
        valueColumns: ['EMAIL'],
        readOnly: false,
      },
      visibleColumnNames: ['EMAIL', 'NAME', 'AGE'],
      rowKeyToString,
      normalizeCommitCellValue: normalizeValue,
      shouldCommitColumn: commitColumnGuard,
    });

    expect(result).toEqual({
      ok: true,
      changes: {
        inserts: [],
        updates: [{
          keys: { EMAIL: 'a@example.com' },
          values: { NAME: 'new-name' },
          previousValues: { NAME: 'old-name' },
        }],
        deletes: [],
        previousDeletes: [],
        locatorStrategy: 'unique-key',
        locatorColumns: [{ key: 'EMAIL' }],
      },
    });
  });

  it('uses hidden Oracle ROWID only as locator and excludes it from update values', () => {
    const result = buildDataGridCommitChangeSet({
      addedRows: [],
      modifiedRows: {
        'row-1': { [GONAVI_ROW_KEY]: 'row-1', NAME: 'new-name', [ORACLE_ROWID_LOCATOR_COLUMN]: 'BBBB' },
      },
      deletedRowKeys: new Set(),
      data: [{ [GONAVI_ROW_KEY]: 'row-1', NAME: 'old-name', [ORACLE_ROWID_LOCATOR_COLUMN]: 'AAAA' }],
      editLocator: {
        strategy: 'oracle-rowid',
        columns: ['ROWID'],
        valueColumns: [ORACLE_ROWID_LOCATOR_COLUMN],
        hiddenColumns: [ORACLE_ROWID_LOCATOR_COLUMN],
        readOnly: false,
      },
      visibleColumnNames: ['NAME'],
      rowKeyToString,
      normalizeCommitCellValue: normalizeValue,
      shouldCommitColumn: commitColumnGuard,
    });

    expect(result).toEqual({
      ok: true,
      changes: {
        inserts: [],
        updates: [{
          keys: { ROWID: 'AAAA' },
          values: { NAME: 'new-name' },
          previousValues: { NAME: 'old-name' },
        }],
        deletes: [],
        previousDeletes: [],
        locatorStrategy: 'oracle-rowid',
        // ROWID 是伪列，值被投影到隐藏别名列：反向语句需要两者才能拼出 WHERE ROWID = <值>。
        locatorColumns: [{ key: 'ROWID', valueColumn: ORACLE_ROWID_LOCATOR_COLUMN }],
      },
    });
  });

  it('uses hidden DuckDB rowid only as locator and excludes it from update values', () => {
    const result = buildDataGridCommitChangeSet({
      addedRows: [],
      modifiedRows: {
        'row-1': { [GONAVI_ROW_KEY]: 'row-1', NAME: 'new-name', [DUCKDB_ROWID_LOCATOR_COLUMN]: 18 },
      },
      deletedRowKeys: new Set(),
      data: [{ [GONAVI_ROW_KEY]: 'row-1', NAME: 'old-name', [DUCKDB_ROWID_LOCATOR_COLUMN]: 17 }],
      editLocator: {
        strategy: 'duckdb-rowid',
        columns: ['rowid'],
        valueColumns: [DUCKDB_ROWID_LOCATOR_COLUMN],
        hiddenColumns: [DUCKDB_ROWID_LOCATOR_COLUMN],
        readOnly: false,
      },
      visibleColumnNames: ['NAME'],
      rowKeyToString,
      normalizeCommitCellValue: normalizeValue,
      shouldCommitColumn: commitColumnGuard,
    });

    expect(result).toEqual({
      ok: true,
      changes: {
        inserts: [],
        updates: [{
          keys: { rowid: 17 },
          values: { NAME: 'new-name' },
          previousValues: { NAME: 'old-name' },
        }],
        deletes: [],
        previousDeletes: [],
        locatorStrategy: 'duckdb-rowid',
        locatorColumns: [{ key: 'rowid', valueColumn: DUCKDB_ROWID_LOCATOR_COLUMN }],
      },
    });
  });

  it('commits only writable result columns and maps aliases back to table columns', () => {
    const result = buildDataGridCommitChangeSet({
      addedRows: [],
      modifiedRows: {
        'row-1': {
          [GONAVI_ROW_KEY]: 'row-1',
          DISPLAY_NAME: 'new-name',
          NAME_UPPER: 'NEW-NAME',
        },
      },
      deletedRowKeys: new Set(),
      data: [{
        [GONAVI_ROW_KEY]: 'row-1',
        ID: 7,
        DISPLAY_NAME: 'old-name',
        NAME_UPPER: 'OLD-NAME',
      }],
      editLocator: {
        strategy: 'primary-key',
        columns: ['ID'],
        valueColumns: ['ID'],
        writableColumns: {
          DISPLAY_NAME: 'NAME',
        },
        readOnly: false,
      },
      visibleColumnNames: ['DISPLAY_NAME', 'NAME_UPPER'],
      rowKeyToString,
      normalizeCommitCellValue: normalizeValue,
      shouldCommitColumn: commitColumnGuard,
    });

    expect(result).toEqual({
      ok: true,
      changes: {
        inserts: [],
        updates: [{
          keys: { ID: 7 },
          values: { NAME: 'new-name' },
          // 变更前值同样映射回表列名：DISPLAY_NAME 的旧值归到 NAME 下，
          // 否则反向 UPDATE 会写到不存在的结果集列上。
          previousValues: { NAME: 'old-name' },
        }],
        deletes: [],
        previousDeletes: [],
        locatorStrategy: 'primary-key',
        locatorColumns: [{ key: 'ID' }],
      },
    });
  });

  it('uses MongoDB _id as the locator and keeps _id out of update values', () => {
    const result = buildDataGridCommitChangeSet({
      addedRows: [{
        [GONAVI_ROW_KEY]: 'new-1',
        _id: '507f1f77bcf86cd799439013',
        __gonavi_mongodb_id_locator__: { $oid: '507f1f77bcf86cd799439013' },
        name: 'insert-name',
      }],
      modifiedRows: {
        'row-1': {
          [GONAVI_ROW_KEY]: 'row-1',
          _id: '507f1f77bcf86cd799439999',
          __gonavi_mongodb_id_locator__: '507f1f77bcf86cd799439999',
          name: 'new-name',
        },
      },
      deletedRowKeys: new Set(['row-2']),
      data: [
        {
          [GONAVI_ROW_KEY]: 'row-1',
          _id: '507f1f77bcf86cd799439011',
          __gonavi_mongodb_id_locator__: { $oid: '507f1f77bcf86cd799439011' },
          name: 'old-name',
        },
        {
          [GONAVI_ROW_KEY]: 'row-2',
          _id: '507f1f77bcf86cd799439012',
          __gonavi_mongodb_id_locator__: '507f1f77bcf86cd799439012',
          name: 'to-delete',
        },
      ],
      editLocator: {
        strategy: 'primary-key',
        columns: ['_id'],
        valueColumns: ['__gonavi_mongodb_id_locator__'],
        hiddenColumns: ['__gonavi_mongodb_id_locator__'],
        writableColumns: {
          name: 'name',
        },
        readOnly: false,
      },
      visibleColumnNames: ['_id', 'name'],
      rowKeyToString,
      normalizeCommitCellValue: normalizeValue,
      shouldCommitColumn: commitColumnGuard,
    });

    expect(result).toEqual({
      ok: true,
      changes: {
        inserts: [{ name: 'insert-name' }],
        updates: [{
          keys: { _id: { $oid: '507f1f77bcf86cd799439011' } },
          values: { name: 'new-name' },
          previousValues: { name: 'old-name' },
        }],
        deletes: [{ _id: '507f1f77bcf86cd799439012' }],
        // 删除行快照同样排除隐藏定位伪列，只保留可写回的表列。
        previousDeletes: [{ name: 'to-delete' }],
        locatorStrategy: 'primary-key',
        locatorColumns: [{ key: '_id', valueColumn: '__gonavi_mongodb_id_locator__' }],
      },
    });
  });

  it('keeps MongoDB explicit typed edit values in the final commit payload', () => {
    const result = buildDataGridCommitChangeSet({
      addedRows: [{
        [GONAVI_ROW_KEY]: 'new-1',
        _id: '507f1f77bcf86cd799439013',
        age: '{"$numberLong":"12"}',
        ratio: '1.5',
      }],
      modifiedRows: {},
      deletedRowKeys: new Set(),
      data: [],
      editLocator: {
        strategy: 'primary-key',
        columns: ['_id'],
        valueColumns: ['_id'],
        readOnly: false,
      },
      visibleColumnNames: ['_id', 'age', 'ratio'],
      rowKeyToString,
      normalizeCommitCellValue: (columnName, value) => parseMongoEditedValue(
        columnName,
        value,
        columnName === 'ratio' ? { $numberDouble: '0.5' } : undefined,
      ),
      shouldCommitColumn: commitColumnGuard,
    });

    expect(result).toEqual({
      ok: true,
      changes: {
        inserts: [{
          _id: { $oid: '507f1f77bcf86cd799439013' },
          age: { $numberLong: '12' },
          ratio: { $numberDouble: '1.5' },
        }],
        updates: [],
        deletes: [],
        previousDeletes: [],
        locatorStrategy: 'primary-key',
        locatorColumns: [{ key: '_id' }],
      },
    });
  });

  it('fails closed when no safe locator is available', () => {
    const result = buildDataGridCommitChangeSet({
      addedRows: [],
      modifiedRows: {
        'row-1': { [GONAVI_ROW_KEY]: 'row-1', NAME: 'new-name' },
      },
      deletedRowKeys: new Set(),
      data: [{ [GONAVI_ROW_KEY]: 'row-1', NAME: 'old-name' }],
      editLocator: undefined,
      visibleColumnNames: ['NAME'],
      rowKeyToString,
      normalizeCommitCellValue: normalizeValue,
      shouldCommitColumn: commitColumnGuard,
      rowLocatorMessages: {
        noSafeLocator: () => 'No safe row locator is available for this result set.',
      },
    } as any);

    expect(result).toEqual({ ok: false, error: 'No safe row locator is available for this result set.' });
  });

  it('rejects delete rows when unique locator value is null', () => {
    const result = buildDataGridCommitChangeSet({
      addedRows: [],
      modifiedRows: {},
      deletedRowKeys: new Set(['row-1']),
      data: [{ [GONAVI_ROW_KEY]: 'row-1', EMAIL: null, NAME: 'old-name' }],
      editLocator: {
        strategy: 'unique-key',
        columns: ['EMAIL'],
        valueColumns: ['EMAIL'],
        readOnly: false,
      },
      visibleColumnNames: ['EMAIL', 'NAME'],
      rowKeyToString,
      normalizeCommitCellValue: normalizeValue,
      shouldCommitColumn: commitColumnGuard,
    });

    expect(result).toEqual({ ok: false, error: 'Locator column EMAIL is empty, so changes cannot be submitted safely.' });
  });

  it('keeps DataGrid safe locator fallback messages out of source Chinese literals', () => {
    const dataGridSource = readFileSync(new URL('./DataGrid.tsx', import.meta.url), 'utf8');
    const rowLocatorSource = readFileSync(new URL('../utils/rowLocator.ts', import.meta.url), 'utf8');

    expect(`${dataGridSource}\n${rowLocatorSource}`).not.toMatch(/当前结果没有可用的安全行定位方式|定位列 .* 的值为空，无法安全提交修改/);
  });

  it('keeps DataGrid AI insight prompt wrapper localized', () => {
    const dataGridSource = readFileSync(new URL('./DataGrid.tsx', import.meta.url), 'utf8');
    const dataGridShellSource = readFileSync(new URL('./DataGridShell.tsx', import.meta.url), 'utf8');

    expect(`${dataGridSource}\n${dataGridShellSource}`).not.toMatch(/请帮我分析以下查询结果数据|请分析数据特征|业务上的洞察/);
  });

  it('marks the active virtual editing row so shouldCellUpdate can reopen inline editors', () => {
    const rows = [
      { [GONAVI_ROW_KEY]: 'row-1', id: 1, name: 'alpha' },
      { [GONAVI_ROW_KEY]: 'row-2', id: 2, name: 'beta' },
    ];

    const nextRows = attachDataGridVirtualEditRenderVersion(rows, { sessionId: 1, rowKey: 'row-1', dataIndex: 'name', title: 'name' });
    const reopenedRows = attachDataGridVirtualEditRenderVersion(rows, { sessionId: 2, rowKey: 'row-1', dataIndex: 'name', title: 'name' });

    expect(nextRows[0]).not.toBe(rows[0]);
    expect(nextRows[1]).toBe(rows[1]);
    expect(hasDataGridVirtualEditRenderVersionChanged(nextRows[0], rows[0])).toBe(true);
    expect(hasDataGridVirtualEditRenderVersionChanged(nextRows[1], rows[1])).toBe(false);
    expect(hasDataGridVirtualEditRenderVersionChanged(reopenedRows[0], nextRows[0])).toBe(true);
  });
});

describe('DataGrid DDL interactions', () => {
  beforeEach(setUpDataGridDdlTest);

  afterEach(tearDownDataGridDdlTest);

  it('toggles one row when its row number cell is clicked', async () => {

    const rows = [
      { [GONAVI_ROW_KEY]: 'row-1', id: 1 },
      { [GONAVI_ROW_KEY]: 'row-2', id: 2 },
    ];
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={rows}
          columnNames={['id']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          showRowNumberColumn
        />,
      );
    });
    await waitForEffects();

    const rowNumberColumn = testRenderState.latestColumns.find(
      (column) => column.key === '__gonavi_row_number__',
    );
    const stopPropagation = vi.fn();
    await act(async () => {
      rowNumberColumn.onCell(rows[1], 1).onClick({ stopPropagation });
    });
    await waitForEffects();

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(testRenderState.latestTableProps.rowHoverable).toBe(false);
    expect(testRenderState.latestTableProps.rowSelection.selectedRowKeys).toEqual(['row-2']);

    await act(async () => {
      rowNumberColumn.onCell(rows[1], 1).onClick({ stopPropagation });
    });
    await waitForEffects();

    expect(stopPropagation).toHaveBeenCalledTimes(2);
    expect(testRenderState.latestTableProps.rowSelection.selectedRowKeys).toEqual([]);
    renderer!.unmount();
  });

  it(
    'opens the referenced table DDL from a query result',
    async () => {

      backendApp.DBShowCreateTable.mockResolvedValueOnce({
        success: true,
        data: 'CREATE TABLE users (`id` bigint)',
      });

      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          <DataGrid
            data={[{ __gonavi_row_key__: 'row-1', id: 1 }]}
            columnNames={['id']}
            loading={false}
            tableName="users"
            dbName="main"
            ddlDbName="main"
            ddlTableName="users"
            connectionId="conn-1"
            exportScope="queryResult"
          />,
        );
      });
      await waitForEffects();

      await act(async () => {
        findButton(renderer!, '查看 DDL').props.onClick();
      });
      await waitForEffects();

      expect(backendApp.DBShowCreateTable).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'mysql' }),
        'main',
        'users',
      );
      expect(textContent(renderer!.root)).toContain('CREATE TABLE users');
      expect(textContent(renderer!.root)).not.toContain('对象设计');
    },
  );

  it('ignores stale DDL responses after the table context changes', async () => {
    let resolveFirstRequest: (value: any) => void = () => {};
    backendApp.DBShowCreateTable.mockReturnValueOnce(new Promise((resolve) => {
      resolveFirstRequest = resolve;
    }));
    backendApp.DBShowCreateTable.mockResolvedValueOnce({
      success: true,
      data: 'CREATE TABLE orders',
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1 }]}
          columnNames={['id']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          pkColumns={['id']}
          onReload={() => {}}
        />,
      );
    });
    await waitForEffects();

    await act(async () => {
      findButton(renderer!, '查看 DDL').props.onClick();
    });

    await act(async () => {
      renderer!.update(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-2', id: 2 }]}
          columnNames={['id']}
          loading={false}
          tableName="orders"
          dbName="main"
          connectionId="conn-1"
        />,
      );
      resolveFirstRequest({ success: true, data: 'CREATE TABLE users' });
    });
    await waitForEffects();

    expect(textContent(renderer!.root)).not.toContain('CREATE TABLE users');
    expect(renderer!.root.findAll((node) => node.props['data-modal-title'] === 'DDL - orders')).toHaveLength(0);
  });

  it(
    'opens the referenced table when clicking a foreign-key column header',
    async () => {

      backendApp.DBGetForeignKeys.mockResolvedValueOnce({
        success: true,
        data: [{
          columnName: 'customer_id',
          refTableName: 'customers',
          refColumnName: 'id',
          constraintName: 'fk_orders_customer',
        }],
      });

      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          <DataGrid
            data={[{ __gonavi_row_key__: 'row-1', id: 1, customer_id: 10 }]}
            columnNames={['id', 'customer_id']}
            loading={false}
            tableName="orders"
            dbName="main"
            connectionId="conn-1"
          />,
        );
      });
      await waitForEffects();

      const fkColumn = testRenderState.latestColumns.find((column) => column.key === 'customer_id');
      expect(fkColumn).toBeTruthy();
      const headerRenderer = create(<>{fkColumn.title}</>);
      const fkJump = headerRenderer.root.findByProps({ 'data-grid-fk-jump': 'true' });
      await act(async () => {
        fkJump.props.onClick({
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
      });

      expect(storeState.setActiveContext).toHaveBeenCalledWith({ connectionId: 'conn-1', dbName: 'main' });
      expect(storeState.addTab).toHaveBeenCalledWith({
        id: 'conn-1-main-table-customers',
        title: 'customers',
        type: 'table',
        connectionId: 'conn-1',
        dbName: 'main',
        tableName: 'customers',
        objectType: 'table',
      });
    },
  );

  it('selects every editable cell in a column when its header is clicked in cell edit mode', async () => {
    messageApi.info.mockResolvedValue(undefined);
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[
            { __gonavi_row_key__: 'row-1', id: 1, name: 'Ada' },
            { __gonavi_row_key__: 'row-2', id: 2, name: 'Linus' },
          ]}
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

    await act(async () => {
      renderer!.root.findByType(DataGridToolbarFrame).props.onToggleCellEditMode();
    });
    await waitForEffects();

    const nameColumn = testRenderState.latestColumns.find((column) => column.key === 'name');
    expect(nameColumn?.editable).toBe(true);
    const headerProps = nameColumn.onHeaderCell(nameColumn);
    const event = {
      target: { closest: vi.fn(() => null) },
      currentTarget: { querySelector: vi.fn(() => null) },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    await act(async () => {
      headerProps.onClickCapture(event);
    });

    const toolbar = renderer!.root.findByType(DataGridToolbarFrame);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(toolbar.props.cellEditMode).toBe(true);
    expect(toolbar.props.selectedCellsSize).toBe(2);
    renderer!.unmount();
  });

  it('deletes every record represented by a cell-only column selection', async () => {
    messageApi.info.mockResolvedValue(undefined);
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[
            { __gonavi_row_key__: 'row-1', id: 1, name: 'Ada' },
            { __gonavi_row_key__: 'row-2', id: 2, name: 'Linus' },
          ]}
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

    await act(async () => {
      renderer!.root.findByType(DataGridToolbarFrame).props.onToggleCellEditMode();
    });
    await waitForEffects();

    const nameColumn = testRenderState.latestColumns.find((column) => column.key === 'name');
    expect(nameColumn?.editable).toBe(true);
    const headerProps = nameColumn.onHeaderCell(nameColumn);
    await act(async () => {
      headerProps.onClickCapture({
        target: { closest: vi.fn(() => null) },
        currentTarget: { querySelector: vi.fn(() => null) },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    let toolbar = renderer!.root.findByType(DataGridToolbarFrame);
    expect(toolbar.props.selectedRowKeysLength).toBe(0);
    expect(toolbar.props.selectedCellsSize).toBe(2);
    expect(toolbar.props.deleteTargetRowCount).toBe(2);
    expect(findButton(renderer!, t('data_grid.toolbar.delete_selected')).props.disabled).toBeFalsy();

    await act(async () => {
      toolbar.props.onRefresh();
    });
    await waitForEffects();

    toolbar = renderer!.root.findByType(DataGridToolbarFrame);
    expect(toolbar.props.selectedCellsSize).toBe(0);
    expect(toolbar.props.deleteTargetRowCount).toBe(0);
    expect(findButton(renderer!, t('data_grid.toolbar.delete_selected')).props.disabled).toBe(true);

    await act(async () => {
      headerProps.onClickCapture({
        target: { closest: vi.fn(() => null) },
        currentTarget: { querySelector: vi.fn(() => null) },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });

    await act(async () => {
      findButton(renderer!, t('data_grid.toolbar.delete_selected')).props.onClick();
    });
    await waitForEffects();

    toolbar = renderer!.root.findByType(DataGridToolbarFrame);
    expect(toolbar.props.pendingChangeCount).toBe(2);
    expect(toolbar.props.selectedCellsSize).toBe(0);
    expect(toolbar.props.deleteTargetRowCount).toBe(0);
    expect(findButton(renderer!, t('data_grid.toolbar.delete_selected')).props.disabled).toBe(true);
    expect(
      testRenderState.latestTableProps.dataSource.map((row: Record<string, unknown>) => (
        testRenderState.latestTableProps.rowClassName(row)
      )),
    ).toEqual(['row-deleted', 'row-deleted']);
    renderer!.unmount();
  });

  it('navigates and closes the current-page finder from its keyboard controls', async () => {
    const onCancel = vi.fn();
    const onNavigatePrevious = vi.fn();
    const onNavigateNext = vi.fn();
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGridPageFind

          pageFindText="Ada"
          normalizedPageFindText="ada"
          hasMatches
          activePageFindPosition={1}
          matchCount={2}
          occurrenceCount={2}
          matchedCellCount={2}
          onPageFindTextChange={() => {}}
          onCancel={onCancel}
          onNavigatePrevious={onNavigatePrevious}
          onNavigateNext={onNavigateNext}
        />,
      );
    });
    const input = renderer!.root.findByType('input');
    const createKeyEvent = (key: string, shiftKey = false) => ({
      key,
      shiftKey,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    await act(async () => {
      input.props.onKeyDown(createKeyEvent('Enter'));
      input.props.onKeyDown(createKeyEvent('Enter', true));
      input.props.onKeyDown(createKeyEvent('Escape'));
    });

    expect(onNavigateNext).toHaveBeenCalledTimes(1);
    expect(onNavigatePrevious).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    renderer!.unmount();
  });

  it('opens the V2 current-page finder with Ctrl+F and closes it without duplicating the widget', async () => {

    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    });
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[
            { __gonavi_row_key__: 'row-1', id: 1, name: 'Ada' },
            { __gonavi_row_key__: 'row-2', id: 2, name: 'Linus' },
          ]}
          columnNames={['id', 'name']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
        />,
      );
    });
    await waitForEffects();

    expect(renderer!.root.findAllByType(DataGridPageFind)).toHaveLength(0);
    const keydownRegistrations = vi.mocked(window.addEventListener).mock.calls.filter(
      ([type, _listener, options]) => type === 'keydown' && options === true,
    );
    expect(keydownRegistrations).toHaveLength(1);
    const handlePageFindShortcut = keydownRegistrations[0][1] as EventListener;
    const createFindShortcutEvent = () => ({
      key: 'f',
      code: 'KeyF',
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      target: document.body,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    }) as unknown as KeyboardEvent;

    const firstShortcut = createFindShortcutEvent();
    await act(async () => {
      handlePageFindShortcut(firstShortcut);
    });
    expect(firstShortcut.preventDefault).toHaveBeenCalledTimes(1);
    expect(firstShortcut.stopPropagation).toHaveBeenCalledTimes(1);
    expect(firstShortcut.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findAllByType(DataGridPageFind)).toHaveLength(1);

    const secondShortcut = createFindShortcutEvent();
    await act(async () => {
      handlePageFindShortcut(secondShortcut);
    });
    expect(renderer!.root.findAllByType(DataGridPageFind)).toHaveLength(1);

    await act(async () => {
      renderer!.root.findByType(DataGridPageFind).props.onCancel();
    });
    expect(renderer!.root.findAllByType(DataGridPageFind)).toHaveLength(0);
    renderer!.unmount();
  });

  it('does not claim document-level Cmd+F for a query result without DataGrid focus', async () => {

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1, name: 'Ada' }]}
          columnNames={['id', 'name']}
          loading={false}
          tableName="users"
          dbName="main"
          connectionId="conn-1"
          exportScope="queryResult"
        />,
      );
    });
    await waitForEffects();

    const keydownRegistrations = vi.mocked(window.addEventListener).mock.calls.filter(
      ([type, _listener, options]) => type === 'keydown' && options === true,
    );
    expect(keydownRegistrations).toHaveLength(1);
    const event = {
      key: 'f',
      code: 'KeyF',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      target: document.body,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    await act(async () => {
      (keydownRegistrations[0][1] as EventListener)(event);
    });

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(renderer!.root.findAllByType(DataGridPageFind)).toHaveLength(0);
    renderer!.unmount();
  });

  it('commits pending edits with Ctrl+S when the editable grid is focused', async () => {

    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
    backendApp.ApplyChanges.mockResolvedValue({
      success: true,
      message: 'ok',
      data: { deletes: [], updates: [], inserts: [] },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1, name: 'Ada' }]}
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
    await act(async () => {
      renderer!.root.findByType(DataGridToolbarFrame).props.onAddRow();
    });
    await waitForEffects();

    const saveListeners = vi.mocked(window.addEventListener).mock.calls
      .filter(([type, _listener, options]) => type === 'keydown' && options === true)
      .map(([_type, listener]) => listener as EventListener)
      .filter(Boolean);
    expect(saveListeners.length).toBeGreaterThan(0);
    const eventTarget = { closest: (selector: string) => selector === '.data-grid-root' ? {} : null };
    const event = {
      key: 's', code: 'KeyS', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false,
      isComposing: false, target: eventTarget,
      preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    await act(async () => {
      saveListeners.forEach((listener) => listener(event));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(backendApp.ApplyChanges).toHaveBeenCalledTimes(1);
    renderer!.unmount();
  });

  it('sends before-image hints to ApplyChanges so a commit stays restorable', async () => {

    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
    backendApp.ApplyChanges.mockReset();
    backendApp.ApplyChanges.mockResolvedValue({
      success: true,
      message: 'ok',
      data: { deletes: [], updates: [], inserts: [] },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DataGrid
          data={[{ __gonavi_row_key__: 'row-1', id: 1, name: 'Ada' }]}
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
    await act(async () => {
      renderer!.root.findByType(DataGridToolbarFrame).props.onAddRow();
    });
    await waitForEffects();

    const saveListeners = vi.mocked(window.addEventListener).mock.calls
      .filter(([type, _listener, options]) => type === 'keydown' && options === true)
      .map(([_type, listener]) => listener as EventListener)
      .filter(Boolean);
    const eventTarget = { closest: (selector: string) => selector === '.data-grid-root' ? {} : null };
    const event = {
      key: 's', code: 'KeyS', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false,
      isComposing: false, target: eventTarget,
      preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    await act(async () => {
      saveListeners.forEach((listener) => listener(event));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(backendApp.ApplyChanges).toHaveBeenCalledTimes(1);
    const payload = backendApp.ApplyChanges.mock.calls[0][3] as any;
    // 只传 inserts/updates/deletes 会让后端拿不到定位列，快照生成静默失效 ——
    // 提交照样成功，但事后无法还原。这两项必须随提交一起送达。
    expect(payload).toHaveProperty('previousDeletes');
    expect(payload).toHaveProperty('locatorColumns');
    expect(payload.locatorColumns).toEqual([{ key: 'id' }]);
    renderer!.unmount();
  });
});
