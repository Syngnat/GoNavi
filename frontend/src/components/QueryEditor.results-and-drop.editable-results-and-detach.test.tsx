import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QueryEditor from './QueryEditor';
import QueryEditorResultsPanel from './QueryEditorResultsPanel';
import { storeState, backendApp, messageApi, dataGridState, autoFetchState, editorState } from './queryEditorResultsAndDropTestState';
import {
    create,
    findButton,
    createTab,
    createResultTabTestEventTarget,
    createResultTabPointerCaptureTarget,
} from './queryEditorResultsAndDropTestHelpers';
import { setUpQueryEditorResultsAndDropTest, tearDownQueryEditorResultsAndDropTest } from './queryEditorResultsAndDropTestHooks';

vi.mock('../store', async (importOriginal) => (await import('./queryEditorResultsAndDropTestState')).mockModule1(importOriginal));

vi.mock('../../wailsjs/go/app/App', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule2());

vi.mock('../utils/nativeDetachedWindowHost', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule3());

vi.mock('../utils/autoFetchVisibility', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule4());

vi.mock('@monaco-editor/react', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule5());

vi.mock('./DataGrid', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule6());

vi.mock('./resultDiff/ResultDiffWizard', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule7());

vi.mock('./resultDiff/ViewDataVerifyWizard', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule8());

vi.mock('./LogPanel', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule9());

vi.mock('./DetachDragPreview', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule10());

vi.mock('@ant-design/icons', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule11());

vi.mock('antd', async () => (await import('./queryEditorResultsAndDropTestState')).mockModule12());

describe('QueryEditor external SQL save', () => {
  beforeEach(setUpQueryEditorResultsAndDropTest);

  afterEach(tearDownQueryEditorResultsAndDropTest);

  it('keeps object hyperlink tab opening tied to the dragged database after drop', async () => {
    const domListeners: Record<string, ((event?: any) => void)[]> = {};
    editorState.domNode = {
      style: { cursor: '' },
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        domListeners[type] ||= [];
        domListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
    } as any;
    editorState.editor.getTargetAtClientPoint = vi.fn(() => ({
      position: { lineNumber: 1, column: 'SELECT * FROM '.length + 1 },
    }));
    editorState.value = 'SELECT * FROM ';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }, { Database: 'front_end_sys' }] });
    backendApp.DBGetTables
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] })
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_front_end_sys: 'fs_mkefu_regist_record' }] });
    backendApp.DBGetAllColumns
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      domListeners.drop?.forEach((listener) => listener({
        clientX: 10,
        clientY: 10,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        dataTransfer: {
          types: ['application/x-gonavi-sql-object', 'text/plain'],
          getData: (type: string) => {
            if (type === 'application/x-gonavi-sql-object') {
              return JSON.stringify({
                text: 'fs_mkefu_regist_record',
                nodeType: 'table',
                connectionId: 'conn-1',
                dbName: 'front_end_sys',
              });
            }
            if (type === 'text/plain') {
              return 'fs_mkefu_regist_record';
            }
            return '';
          },
        },
      }));
    });

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'SELECT * FROM front_end_sys.fs_mkefu_regist_record'.length } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
    });

    expect(storeState.setActiveContext).not.toHaveBeenCalled();
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'front_end_sys',
      tableName: 'fs_mkefu_regist_record',
      objectType: 'table',
    }));
  });

  it('runs selected SQL before cursor SQL', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['selected'], rows: [{ selected: 2 }] }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'select 1;\nselect 2 as selected;\nselect 3;',
      })} />);
    });

    editorState.position = { lineNumber: 1, column: 4 };
    editorState.selection = {
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 'select 2 as selected'.length + 1,
    };

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(expect.anything(), 'main', expect.stringContaining('select 2 as selected'), 'query-1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 1');
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).not.toContain('select 3');
  });

  it('allows editable table columns while leaving expression columns out of commits', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['DISPLAY_NAME', 'NAME_UPPER', '__gonavi_locator_1_ID'],
        rows: [{ DISPLAY_NAME: 'old-name', NAME_UPPER: 'OLD-NAME', __gonavi_locator_1_ID: 7 }],
      }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'ID', key: 'PRI' }, { name: 'NAME', key: '' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'main',
        query: 'SELECT NAME AS DISPLAY_NAME, UPPER(NAME) AS NAME_UPPER FROM users',
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.tableName).toBe('users');
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'primary-key',
      columns: ['ID'],
      valueColumns: ['__gonavi_locator_1_ID'],
      hiddenColumns: ['__gonavi_locator_1_ID'],
      writableColumns: {
        DISPLAY_NAME: 'NAME',
      },
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('`ID` AS `__gonavi_locator_1_ID`');
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('keeps DuckDB qualified table query results writable when primary key metadata arrives', async () => {
    storeState.connections[0].config.type = 'duckdb';
    storeState.connections[0].config.database = 'main';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME', '__gonavi_locator_1_id'], rows: [{ NAME: 'launch', __gonavi_locator_1_id: 7 }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'id', key: 'PRI' }, { name: 'name', key: '' }],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'SELECT NAME FROM main.events' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'main', 'main.events');
    expect(dataGridState.latestProps?.tableName).toBe('main.events');
    expect(dataGridState.latestProps?.pkColumns).toEqual(['id']);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'primary-key',
      columns: ['id'],
      valueColumns: ['__gonavi_locator_1_id'],
      hiddenColumns: ['__gonavi_locator_1_id'],
      writableColumns: {
        NAME: 'name',
      },
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('"id" AS "__gonavi_locator_1_id"');
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('uses hidden DuckDB rowid when query results have no primary or unique key', async () => {
    storeState.connections[0].config.type = 'duckdb';
    storeState.connections[0].config.database = 'main';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['NAME', '__gonavi_duckdb_rowid__'], rows: [{ NAME: 'launch', __gonavi_duckdb_rowid__: 17 }] }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [{ name: 'name', key: '' }],
    });
    backendApp.DBGetIndexes.mockResolvedValueOnce({
      success: true,
      data: [],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: 'SELECT NAME FROM main.events' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.tableName).toBe('main.events');
    expect(dataGridState.latestProps?.pkColumns).toEqual([]);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'duckdb-rowid',
      columns: ['rowid'],
      valueColumns: ['__gonavi_duckdb_rowid__'],
      hiddenColumns: ['__gonavi_duckdb_rowid__'],
      writableColumns: {
        NAME: 'name',
      },
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('rowid AS "__gonavi_duckdb_rowid__"');
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('auto aliases Oracle duplicate explicit columns before alias star expansion', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'APP';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['EHR_USERID_1', 'USERID', 'EHR_USERID', 'USERNAME'],
        rows: [{
          EHR_USERID_1: 'emp-1',
          USERID: 7,
          EHR_USERID: 'emp-1',
          USERNAME: 'alice',
        }],
      }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [
        { name: 'USERID', key: 'PRI' },
        { name: 'EHR_USERID', key: '' },
        { name: 'USERNAME', key: '' },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        dbName: 'APP',
        query: 'SELECT EHR_USERID, a.* FROM S_USER_BASE a',
      })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'primary-key',
      columns: ['USERID'],
      valueColumns: ['USERID'],
      writableColumns: {
        USERID: 'USERID',
        EHR_USERID: 'EHR_USERID',
        USERNAME: 'USERNAME',
      },
      readOnly: false,
    });
    expect(String(backendApp.DBQueryMulti.mock.calls[0][2])).toContain('EHR_USERID AS EHR_USERID_1, a.*');
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('keeps a multiline single-table result tied to its editable all-columns locator', async () => {
    const sql = [
      'SELECT a.COMPID, a.MEMCARDNO,',
      '  a.MODIFYUSER, a.MODIFYTIME',
      'FROM D_MEMBER_CARDTYPE_MODFIY_LOG a',
    ].join('\n');
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['COMPID', 'MEMCARDNO', 'MODIFYUSER', 'MODIFYTIME'],
        rows: [{ COMPID: 1, MEMCARDNO: 'M-1', MODIFYUSER: 'admin', MODIFYTIME: '2026-07-10' }],
      }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [
        { name: 'COMPID', key: '' },
        { name: 'MEMCARDNO', key: '' },
        { name: 'MODIFYUSER', key: '' },
        { name: 'MODIFYTIME', key: '' },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: sql })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.tableName).toBe('D_MEMBER_CARDTYPE_MODFIY_LOG');
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'all-columns',
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    expect(dataGridState.latestProps?.columnPinScope).toBeUndefined();
    renderer!.unmount();
  });

  it.each([
    ['leading line comments', '-- 1856887305879470081\n-- 3257969823961465780\nSELECT * FROM contract WHERE contract_code = \'YEC202608039\';'],
    ['leading block comments', '/* export batch: 3257963896428446491 */\nSELECT * FROM contract WHERE contract_code = \'YEC202608039\';'],
    ['leading hash comments', '# exported query\nSELECT * FROM contract WHERE contract_code = \'YEC202608039\';'],
    ['comments containing SQL join keywords', '/* JOIN notes from the previous export */\nSELECT * FROM contract WHERE contract_code = \'YEC202608039\';'],
    ['a comment between FROM and the table', 'SELECT * FROM /* primary contract source */ contract WHERE contract_code = \'YEC202608039\';'],
  ])('keeps a single-table result editable with %s', async (_label, sql) => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{
        columns: ['id', 'contract_code'],
        rows: [{ id: 1, contract_code: 'YEC202608039' }],
      }],
    });
    backendApp.DBGetColumns.mockResolvedValueOnce({
      success: true,
      data: [
        { name: 'id', key: 'PRI' },
        { name: 'contract_code', key: '' },
      ],
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'main', query: sql })} />);
    });
    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dataGridState.latestProps?.tableName).toBe('contract');
    expect(dataGridState.latestProps?.editLocator).toMatchObject({
      strategy: 'primary-key',
      columns: ['id'],
      readOnly: false,
    });
    expect(dataGridState.latestProps?.readOnly).toBe(false);
    renderer!.unmount();
  });

  it.each([
    'mysql',
    'mariadb',
    'oceanbase',
    'diros',
    'sphinx',
    'postgres',
    'kingbase',
    'highgo',
    'vastbase',
    'opengauss',
    'gaussdb',
    'sqlserver',
    'sqlite',
    'duckdb',
    'oracle',
    'dameng',
    'tdengine',
    'clickhouse',
  ])(
    'keeps aggregate query results silently read-only for %s',
    async (dbType) => {
      storeState.connections[0].config.type = dbType;
      storeState.connections[0].config.database = dbType === 'oracle' || dbType === 'dameng' ? 'APP' : 'main';
      backendApp.DBQueryMulti.mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['COUNT'], rows: [{ COUNT: 1 }] }],
      });

      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(<QueryEditor tab={createTab({
          dbName: storeState.connections[0].config.database,
          query: 'SELECT count(1) FROM users',
        })} />);
      });

      await act(async () => {
        await findButton(renderer!, '运行').props.onClick();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const expectedTableName = dbType === 'oracle' || dbType === 'dameng' ? 'USERS' : 'users';
      expect(dataGridState.latestProps?.tableName).toBe(expectedTableName);
      expect(dataGridState.latestProps?.editLocator).toBeUndefined();
      expect(dataGridState.latestProps?.readOnly).toBe(true);
      expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
      expect(backendApp.DBGetIndexes).not.toHaveBeenCalled();
      expect(messageApi.warning).not.toHaveBeenCalled();
    },
  );
});

describe('QueryEditorResultsPanel result-tab detach lifecycle', () => {
  let renderer: ReactTestRenderer | null = null;
  let windowTarget: ReturnType<typeof createResultTabTestEventTarget> & Record<string, any>;
  let documentTarget: Record<string, any>;
  let classNames: Set<string>;
  let removeAllRanges: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    classNames = new Set<string>();
    removeAllRanges = vi.fn();
    windowTarget = Object.assign(createResultTabTestEventTarget(), {
      screenX: 0,
      screenY: 0,
      outerWidth: 1200,
      outerHeight: 800,
      innerWidth: 1200,
      innerHeight: 800,
      getSelection: vi.fn(() => ({ rangeCount: 1, removeAllRanges })),
    });
    documentTarget = {
      body: {
        style: {
          userSelect: 'text',
          webkitUserSelect: 'auto',
        },
      },
      documentElement: {
        classList: {
          add: vi.fn((className: string) => classNames.add(className)),
          remove: vi.fn((className: string) => classNames.delete(className)),
          contains: (className: string) => classNames.has(className),
        },
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('window', windowTarget);
    vi.stubGlobal('document', documentTarget);
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = null;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const renderDetachableResultPanel = async (onOpenResultInWindow = vi.fn()) => {
    await act(async () => {
      renderer = create(
        <QueryEditorResultsPanel
          resultSets={[{
            key: 'result-1',
            sql: 'select 1',
            rows: [{ value: 1 }],
            columns: ['value'],
            pkColumns: [],
            readOnly: true,
          }]}
          activeResultKey="result-1"
          isActive
          loading={false}
          executionError=""
          sqlLogCount={0}
          darkMode={false}

          currentDb="main"
          currentConnectionId="conn-1"
          toggleShortcutLabel=""
          onActiveResultKeyChange={vi.fn()}
          onHide={vi.fn()}
          onCloseResult={vi.fn()}
          onCloseOtherResultTabs={vi.fn()}
          onCloseResultTabsToLeft={vi.fn()}
          onCloseResultTabsToRight={vi.fn()}
          onCloseAllResultTabs={vi.fn()}
          onResultPinnedChange={vi.fn()}
          onOpenResultInWindow={onOpenResultInWindow}
          onReloadResult={vi.fn()}
          onResultPageChange={vi.fn()}
          onResultSort={vi.fn()}
          onDiagnoseExecutionError={vi.fn()}
        />,
      );
    });
  };

  const beginResultTabDrag = (captureTarget = createResultTabPointerCaptureTarget()) => {
    const resultTabLabel = renderer!.root.findAll((node) =>
      typeof node.props?.onPointerDown === 'function'
      && String(node.props?.className || '').split(/\s+/).includes('query-result-tab-label'),
    )[0];
    act(() => {
      resultTabLabel.props.onPointerDown({
        button: 0,
        buttons: 1,
        isPrimary: true,
        target: { closest: () => null },
        currentTarget: captureTarget,
        pointerId: 7,
        clientX: 100,
        clientY: 100,
        screenX: 300,
        screenY: 300,
      });
    });
    return captureTarget;
  };

  it('keeps the actual result table identity separate from metadata lookup names', async () => {
    await act(async () => {
      renderer = create(
        <QueryEditorResultsPanel
          resultSets={[{
            key: 'result-1',
            sql: 'select * from APP.USERS',
            rows: [{ id: 1 }],
            columns: ['id'],
            tableName: 'APP.USERS',
            metadataTableName: 'USERS',
            pkColumns: ['id'],
            readOnly: false,
          }]}
          activeResultKey="result-1"
          isActive
          loading={false}
          executionError=""
          sqlLogCount={0}
          darkMode={false}

          currentDb="APP"
          currentConnectionId="conn-1"
          toggleShortcutLabel=""
          onActiveResultKeyChange={vi.fn()}
          onHide={vi.fn()}
          onCloseResult={vi.fn()}
          onCloseOtherResultTabs={vi.fn()}
          onCloseResultTabsToLeft={vi.fn()}
          onCloseResultTabsToRight={vi.fn()}
          onCloseAllResultTabs={vi.fn()}
          onResultPinnedChange={vi.fn()}
          onOpenResultInWindow={vi.fn()}
          onReloadResult={vi.fn()}
          onResultPageChange={vi.fn()}
          onResultSort={vi.fn()}
          onDiagnoseExecutionError={vi.fn()}
        />,
      );
    });

    expect(dataGridState.latestProps?.tableName).toBe('APP.USERS');
    expect(dataGridState.latestProps?.dbName).toBe('APP');
  });

  it('restores selection state and removes global listeners when the window blurs', async () => {
    const onOpenResultInWindow = vi.fn();
    await renderDetachableResultPanel(onOpenResultInWindow);
    const captureTarget = beginResultTabDrag();

    act(() => {
      windowTarget.dispatch('pointermove', {
        pointerId: 7,
        buttons: 1,
        clientX: 120,
        clientY: 130,
        preventDefault: vi.fn(),
      });
    });

    expect(documentTarget.body.style.userSelect).toBe('none');
    expect(documentTarget.body.style.webkitUserSelect).toBe('none');
    expect(classNames.has('gn-result-tab-detaching')).toBe(true);
    expect(windowTarget.listenerCount('selectstart')).toBe(1);
    expect(windowTarget.listenerCount('dragstart')).toBe(1);
    expect(removeAllRanges).toHaveBeenCalled();

    act(() => {
      windowTarget.dispatch('blur');
      windowTarget.dispatch('blur');
      captureTarget.dispatch('lostpointercapture', { pointerId: 7 });
    });

    expect(documentTarget.body.style.userSelect).toBe('text');
    expect(documentTarget.body.style.webkitUserSelect).toBe('auto');
    expect(classNames.has('gn-result-tab-detaching')).toBe(false);
    expect(windowTarget.listenerCount('pointermove')).toBe(0);
    expect(windowTarget.listenerCount('pointerup')).toBe(0);
    expect(windowTarget.listenerCount('pointercancel')).toBe(0);
    expect(windowTarget.listenerCount('blur')).toBe(0);
    expect(windowTarget.listenerCount('selectstart')).toBe(0);
    expect(windowTarget.listenerCount('dragstart')).toBe(0);
    expect(captureTarget.listenerCount('lostpointercapture')).toBe(0);
    expect(captureTarget.releasePointerCapture).toHaveBeenCalledTimes(1);
    expect(onOpenResultInWindow).not.toHaveBeenCalled();
  });

  it('ignores other pointers and cleans up when the active pointer loses capture', async () => {
    await renderDetachableResultPanel();
    const captureTarget = beginResultTabDrag();

    act(() => {
      windowTarget.dispatch('pointermove', {
        pointerId: 9,
        buttons: 0,
        clientX: 180,
        clientY: 180,
        preventDefault: vi.fn(),
      });
      windowTarget.dispatch('pointerup', { pointerId: 9 });
      captureTarget.dispatch('lostpointercapture', { pointerId: 9 });
    });

    expect(windowTarget.listenerCount('pointermove')).toBe(1);
    expect(captureTarget.listenerCount('lostpointercapture')).toBe(1);
    expect(captureTarget.releasePointerCapture).not.toHaveBeenCalled();

    act(() => {
      captureTarget.dispatch('lostpointercapture', { pointerId: 7 });
    });

    expect(windowTarget.listenerCount('pointermove')).toBe(0);
    expect(windowTarget.listenerCount('pointerup')).toBe(0);
    expect(windowTarget.listenerCount('pointercancel')).toBe(0);
    expect(windowTarget.listenerCount('blur')).toBe(0);
    expect(captureTarget.listenerCount('lostpointercapture')).toBe(0);
  });

  it('self-heals on buttons=0 even when releasing pointer capture throws', async () => {
    const onOpenResultInWindow = vi.fn();
    await renderDetachableResultPanel(onOpenResultInWindow);
    const captureTarget = beginResultTabDrag(createResultTabPointerCaptureTarget(true));

    expect(() => {
      act(() => {
        windowTarget.dispatch('pointermove', {
          pointerId: 7,
          buttons: 0,
          clientX: 160,
          clientY: 160,
          preventDefault: vi.fn(),
        });
      });
    }).not.toThrow();

    expect(captureTarget.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(windowTarget.listenerCount('pointermove')).toBe(0);
    expect(windowTarget.listenerCount('pointerup')).toBe(0);
    expect(windowTarget.listenerCount('pointercancel')).toBe(0);
    expect(windowTarget.listenerCount('blur')).toBe(0);
    expect(captureTarget.listenerCount('lostpointercapture')).toBe(0);
    expect(onOpenResultInWindow).not.toHaveBeenCalled();
  });

  it('restores active drag state when the result panel unmounts', async () => {
    await renderDetachableResultPanel();
    const captureTarget = beginResultTabDrag();

    act(() => {
      windowTarget.dispatch('pointermove', {
        pointerId: 7,
        buttons: 1,
        clientX: 120,
        clientY: 130,
        preventDefault: vi.fn(),
      });
    });
    expect(classNames.has('gn-result-tab-detaching')).toBe(true);

    act(() => {
      renderer?.unmount();
    });
    renderer = null;

    expect(documentTarget.body.style.userSelect).toBe('text');
    expect(documentTarget.body.style.webkitUserSelect).toBe('auto');
    expect(classNames.has('gn-result-tab-detaching')).toBe(false);
    expect(windowTarget.listenerCount('pointermove')).toBe(0);
    expect(windowTarget.listenerCount('pointerup')).toBe(0);
    expect(windowTarget.listenerCount('pointercancel')).toBe(0);
    expect(windowTarget.listenerCount('blur')).toBe(0);
    expect(windowTarget.listenerCount('selectstart')).toBe(0);
    expect(windowTarget.listenerCount('dragstart')).toBe(0);
    expect(captureTarget.listenerCount('lostpointercapture')).toBe(0);
    expect(captureTarget.releasePointerCapture).toHaveBeenCalledWith(7);
  });
});
