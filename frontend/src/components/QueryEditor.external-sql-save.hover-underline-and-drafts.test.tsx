import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentLanguage } from '../i18n';
import { setGlobalImeCompositionActive } from '../utils/shortcuts';
import { getQueryTabDraft, getSQLFileTabDraft } from '../utils/sqlFileTabDrafts';
import QueryEditor from './QueryEditor';
import {
    create,
    storeState,
    backendApp,
    messageApi,
    autoFetchState,
    editorState,
    findButton,
    createTab,
} from './queryEditorExternalSqlSaveTestSupport';
import { setUpQueryEditorExternalSqlSaveTest, tearDownQueryEditorExternalSqlSaveTest } from './queryEditorExternalSqlSaveTestHooks';

vi.mock('../store', async (importOriginal) => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule1(importOriginal));

vi.mock('../../wailsjs/runtime', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule2());

vi.mock('../../wailsjs/go/app/App', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule3());

vi.mock('../utils/autoFetchVisibility', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule4());

vi.mock('@monaco-editor/react', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule5());

vi.mock('./DataGrid', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule6());

vi.mock('./resultDiff/ResultDiffWizard', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule7());

vi.mock('./resultDiff/ViewDataVerifyWizard', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule8());

vi.mock('./LogPanel', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule9());

vi.mock('@ant-design/icons', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule10());

vi.mock('antd', async () => (await import('./queryEditorExternalSqlSaveTestSupport')).mockModule11());

describe('QueryEditor external SQL save', () => {
  beforeEach(setUpQueryEditorExternalSqlSaveTest);

  afterEach(tearDownQueryEditorExternalSqlSaveTest);

  it('keeps hover underline active when ctrl/cmd is pressed repeatedly without moving the mouse', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    editorState.value = 'select * from analytics.events where id = 1';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }, { Database: 'analytics' }] });
    backendApp.DBGetTables
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] })
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_analytics: 'events' }] });
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
      editorState.mouseMoveListeners[0]?.({
        target: { position: { lineNumber: 1, column: 27 } },
        event: {
          ctrlKey: true,
          metaKey: false,
        },
      });
    });

    const firstDecorationCallCount = editorState.editor.deltaDecorations.mock.calls.length;
    expect(firstDecorationCallCount).toBeGreaterThan(0);
    expect(editorState.domNode.style.cursor).toBe('pointer');

    await act(async () => {
      const repeatedCtrlEvent = {
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        key: 'Control',
        code: 'ControlLeft',
        repeat: true,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        target: null,
      };
      windowListeners.keydown?.forEach((listener) => listener(repeatedCtrlEvent));
      windowListeners.keydown?.forEach((listener) => listener(repeatedCtrlEvent));
    });

    expect(editorState.editor.deltaDecorations.mock.calls.length).toBeGreaterThan(firstDecorationCallCount);
    expect(editorState.domNode.style.cursor).toBe('pointer');
    const lastDecorationCall = editorState.editor.deltaDecorations.mock.calls.at(-1);
    expect(lastDecorationCall?.[1]?.[0]?.options?.inlineClassName).toBe('gonavi-query-editor-link-hint');
  });

  it('ignores IME candidate keydown events when syncing modifier hover state', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    editorState.value = 'select 1';

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value })} />);
    });

    editorState.editor.updateOptions.mockClear();
    editorState.editor.deltaDecorations.mockClear();

    await act(async () => {
      const imeEvent = {
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        key: 'Process',
        keyCode: 229,
        which: 229,
        isComposing: true,
        nativeEvent: {
          isComposing: true,
          keyCode: 229,
          which: 229,
        },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        target: null,
      };
      windowListeners.keydown?.forEach((listener) => listener(imeEvent));
    });

    expect(editorState.editor.updateOptions).not.toHaveBeenCalledWith({ mouseStyle: 'text' });
    expect(editorState.editor.deltaDecorations).not.toHaveBeenCalled();
  });

  it('does not churn decorations while selecting text without a navigation modifier', async () => {
    editorState.value = 'select users.id from users';

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value })} />);
    });

    editorState.editor.updateOptions.mockClear();
    editorState.editor.deltaDecorations.mockClear();

    await act(async () => {
      editorState.mouseMoveListeners[0]?.({
        target: { position: { lineNumber: 1, column: 10 } },
        event: { ctrlKey: false, metaKey: false },
      });
    });

    expect(editorState.editor.updateOptions).not.toHaveBeenCalled();
    expect(editorState.editor.deltaDecorations).not.toHaveBeenCalled();
  });

  it('ignores candidate number keys while a composition session is active', async () => {
    const windowListeners: Record<string, ((event?: any) => void)[]> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event?: any) => void) => {
        windowListeners[type] ||= [];
        windowListeners[type].push(listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    editorState.value = 'select 1';

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value })} />);
    });

    setGlobalImeCompositionActive(true);
    editorState.editor.updateOptions.mockClear();
    editorState.editor.deltaDecorations.mockClear();

    await act(async () => {
      const candidateSelectEvent = {
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        key: '1',
        keyCode: 49,
        which: 49,
        isComposing: false,
        nativeEvent: {
          isComposing: false,
        },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        target: null,
      };
      windowListeners.keydown?.forEach((listener) => listener(candidateSelectEvent));
    });

    expect(editorState.editor.updateOptions).not.toHaveBeenCalled();
    expect(editorState.editor.deltaDecorations).not.toHaveBeenCalled();
  });

  it('opens a view object-edit tab on ctrl left click inside the editor', async () => {
    editorState.value = 'select * from reporting.active_users';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (sql.includes('information_schema.views') || sql.includes('pg_catalog.pg_views') || sql.includes('USER_VIEWS') || sql.includes('ALL_VIEWS')) {
        return { success: true, data: [{ view_name: 'active_users', schema_name: 'reporting', view_definition: 'select id from users' }] };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 31 } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    expect(storeState.setActiveContext).not.toHaveBeenCalled();
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^query-edit-object-conn-1-main-reporting-reporting\.active_users-\d+$/),
      title: '修改视图: reporting.active_users',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      schemaName: 'reporting',
      queryMode: 'object-edit',
      viewName: 'active_users',
      viewKind: 'view',
      objectType: 'view',
      returnToTabId: 'tab-1',
      query: expect.stringContaining('CREATE OR REPLACE VIEW reporting.active_users AS'),
    }));
    expect((window as any).dispatchEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'gonavi:locate-sidebar-object',
    }));
  });

  it('uses the complete Oracle view DDL when opening object edit from the editor', async () => {
    const viewName = 'H2.CV_GD_YNCRM_SALESDTLLIST';
    const preview = '[CLOB preview: 4096/9362 bytes] SELECT compid, saleno FROM sales_detail';
    const fullDDL = `CREATE OR REPLACE VIEW ${viewName} AS SELECT compid, saleno FROM sales_detail WHERE deleted_flag = 0`;
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'hydeekf';
    editorState.value = `select * from ${viewName}`;
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'H2' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBShowCreateTable.mockResolvedValueOnce({ success: true, data: fullDDL });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (sql.includes('USER_VIEWS') || sql.includes('ALL_VIEWS')) {
        if (sql.includes('TEXT AS view_definition')) {
          return { success: true, data: [{ view_definition: preview }] };
        }
        return { success: true, data: [{ schema_name: 'H2', view_name: 'CV_GD_YNCRM_SALESDTLLIST' }] };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'H2' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
      }
    });

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: editorState.value.indexOf(viewName) + Math.floor(viewName.length / 2) + 1 } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBShowCreateTable).toHaveBeenCalledWith(expect.anything(), 'H2', viewName);
    const addTabCall = storeState.addTab.mock.calls[storeState.addTab.mock.calls.length - 1]?.[0];
    const editQuery = String(addTabCall?.query || '');
    expect(editQuery).toMatch(/CREATE OR REPLACE VIEW H2\.CV_GD_YNCRM_SALESDTLLIST AS/i);
    expect(editQuery).toContain('deleted_flag = 0');
    expect(editQuery).not.toContain('[CLOB preview:');
  });

  it('uses the complete Oracle trigger DDL when opening object edit from the editor', async () => {
    const triggerName = 'H2.TR_T_MEMCARD_REG';
    const fullDDL = `CREATE OR REPLACE TRIGGER "H2"."TR_T_MEMCARD_REG"
BEFORE INSERT OR UPDATE ON "H2"."T_MEMCARD_REG"
FOR EACH ROW
BEGIN
${'  NULL;\n'.repeat(700)}  -- FULL_TRIGGER_DDL_TAIL
END;`;
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'hydeekf';
    editorState.value = `call ${triggerName}();`;
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'H2' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetTriggers.mockResolvedValue({
      success: true,
      data: [{ name: 'TR_T_MEMCARD_REG', timing: 'BEFORE EACH ROW', event: 'INSERT OR UPDATE', statement: fullDDL }],
    });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (sql.includes('ALL_TRIGGERS') && sql.includes('ORDER BY TABLE_NAME')) {
        return {
          success: true,
          data: [{ schema_name: 'H2', table_name: 'T_MEMCARD_REG', trigger_name: 'TR_T_MEMCARD_REG' }],
        };
      }
      if (sql.includes('DBMS_METADATA.GET_DDL')) {
        return {
          success: true,
          data: [{ trigger_definition: `[CLOB preview: 4096/${fullDDL.length} bytes] ${fullDDL.slice(0, 4096)}` }],
        };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'H2' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
      }
    });

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: editorState.value.indexOf(triggerName) + Math.floor(triggerName.length / 2) + 1 } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBGetTriggers).toHaveBeenCalledWith(expect.anything(), 'H2', 'H2.T_MEMCARD_REG');
    const addTabCall = storeState.addTab.mock.calls[storeState.addTab.mock.calls.length - 1]?.[0];
    const editQuery = String(addTabCall?.query || '');
    expect(editQuery).toContain('FULL_TRIGGER_DDL_TAIL');
    expect(editQuery).not.toContain('[CLOB preview:');
    expect(editQuery).not.toContain('请补全 CREATE TRIGGER 语句');
    expect(editQuery).not.toMatch(/\bDROP\s+TRIGGER\b/i);
  });

  it('opens trigger and routine object-edit tabs on ctrl left click inside the editor', async () => {
    editorState.value = 'call audit.users_bi(); call reporting.refresh_stats();';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (sql.includes('SHOW CREATE TRIGGER')) {
        return { success: true, data: [{ 'SQL Original Statement': 'CREATE TRIGGER audit.users_bi BEFORE INSERT ON audit.users FOR EACH ROW SET @a = 1' }] };
      }
      if (sql.includes('information_schema.triggers') || sql.includes('SHOW TRIGGERS') || sql.includes('USER_TRIGGERS') || sql.includes('ALL_TRIGGERS')) {
        return { success: true, data: [{ trigger_name: 'users_bi', table_name: 'users', schema_name: 'audit' }] };
      }
      if (sql.includes('information_schema.routines') || sql.includes('SHOW FUNCTION STATUS') || sql.includes('SHOW PROCEDURE STATUS') || sql.includes('USER_OBJECTS') || sql.includes('ALL_OBJECTS')) {
        return { success: true, data: [{ routine_name: 'refresh_stats', routine_type: 'PROCEDURE', schema_name: 'reporting' }] };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }
    });

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 12 } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 39 } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^query-edit-trigger-conn-1-main-audit-audit\.users_bi-\d+$/),
      title: '修改触发器: audit.users_bi',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      schemaName: 'audit',
      queryMode: 'object-edit',
      returnToTabId: 'tab-1',
      query: expect.stringContaining('CREATE TRIGGER audit.users_bi'),
    }));
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^query-edit-routine-conn-1-main-reporting-reporting\.refresh_stats-\d+$/),
      title: '编辑 存储过程：reporting.refresh_stats',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      schemaName: 'reporting',
      queryMode: 'object-edit',
      routineName: 'reporting.refresh_stats',
      routineType: 'PROCEDURE',
      returnToTabId: 'tab-1',
      query: expect.stringContaining('CREATE OR REPLACE PROCEDURE reporting.refresh_stats()'),
    }));
    expect((window as any).dispatchEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'gonavi:locate-sidebar-object',
    }));
  });

  it('keeps dotted trigger metadata names intact when opening object edit from the editor', async () => {
    editorState.value = 'call audit.`a.b`();';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (sql.includes('SHOW CREATE TRIGGER')) {
        return {
          success: true,
          data: [{
            'SQL Original Statement': 'CREATE TRIGGER `audit`.`a.b` BEFORE INSERT ON `audit`.`order.items` FOR EACH ROW SET @a = 1',
          }],
        };
      }
      if (sql.includes('information_schema.triggers') || sql.includes('SHOW TRIGGERS')) {
        return {
          success: true,
          data: [{ trigger_name: 'a.b', table_name: 'order.items', schema_name: 'audit' }],
        };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: editorState.value.indexOf('a.b') + 2 } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });

    const triggerLookup = backendApp.DBQuery.mock.calls
      .map((call: any[]) => String(call[2] || ''))
      .find((sql: string) => sql.startsWith('SHOW CREATE TRIGGER'));
    expect(triggerLookup).toContain('SHOW CREATE TRIGGER `audit`.`a.b`');
    expect(triggerLookup).not.toContain('`a`.`b`');
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'query',
      queryMode: 'object-edit',
      triggerName: 'audit.`a.b`',
      triggerTableName: 'audit.`order.items`',
    }));
  });

  it('opens sequence and package object-edit tabs on ctrl left click inside the editor', async () => {
    editorState.value = 'select billing.order_seq.nextval from dual; begin billing.pkg_order.sync_order(1); end;';
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'main';
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      if (sql.includes('ALL_SEQUENCES') || sql.includes('USER_SEQUENCES')) {
        return {
          success: true,
          data: [{
            sequence_owner: 'BILLING',
            sequence_name: 'ORDER_SEQ',
            min_value: 1,
            max_value: 999999,
            increment_by: 1,
            cache_size: 20,
            cycle_flag: 'N',
            order_flag: 'N',
          }],
        };
      }
      if (sql.includes('ALL_SOURCE') || sql.includes('USER_SOURCE')) {
        if (sql.includes("TYPE = 'PACKAGE BODY'")) {
          return { success: true, data: [{ TEXT: 'PACKAGE BODY pkg_order AS\nPROCEDURE sync_order(p_id NUMBER) IS BEGIN NULL; END;\nEND pkg_order;\n' }] };
        }
        return { success: true, data: [{ TEXT: 'PACKAGE pkg_order AS\nPROCEDURE sync_order(p_id NUMBER);\nEND pkg_order;\n' }] };
      }
      if (sql.includes('ALL_OBJECTS') && sql.includes("OBJECT_TYPE = 'PACKAGE'")) {
        return { success: true, data: [{ package_name: 'pkg_order', schema_name: 'billing' }] };
      }
      return { success: true, data: [] };
    });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
      }
    });

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 18 } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 59 } },
        event: {
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^query-edit-object-conn-1-main-BILLING-BILLING\.ORDER_SEQ-\d+$/),
      title: '修改序列: BILLING.ORDER_SEQ',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      schemaName: 'BILLING',
      queryMode: 'object-edit',
      sequenceName: 'BILLING.ORDER_SEQ',
      query: expect.stringContaining('CREATE SEQUENCE BILLING.ORDER_SEQ'),
    }));
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^query-edit-object-conn-1-main-billing-billing\.pkg_order-\d+$/),
      title: '修改存储包: billing.pkg_order',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      schemaName: 'billing',
      queryMode: 'object-edit',
      packageName: 'billing.pkg_order',
      query: expect.stringContaining('CREATE OR REPLACE PACKAGE pkg_order'),
    }));
    expect((window as any).dispatchEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'gonavi:locate-sidebar-object',
    }));
  });

  describe('object navigation tab title localization', () => {
    it('uses the English catalog title for view object-edit tabs', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      editorState.value = 'select * from reporting.active_users';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
      backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
        if (sql.includes('information_schema.views') || sql.includes('pg_catalog.pg_views') || sql.includes('USER_VIEWS') || sql.includes('ALL_VIEWS')) {
          return { success: true, data: [{ view_name: 'active_users', schema_name: 'reporting', view_definition: 'select id from users' }] };
        }
        return { success: true, data: [] };
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      await act(async () => {
        editorState.mouseDownListeners[0]?.({
          target: { position: { lineNumber: 1, column: 31 } },
          event: {
            leftButton: true,
            ctrlKey: true,
            metaKey: false,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
          },
        });
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.stringMatching(/^query-edit-object-conn-1-main-reporting-reporting\.active_users-\d+$/),
        title: 'Edit View: reporting.active_users',
        type: 'query',
        schemaName: 'reporting',
        queryMode: 'object-edit',
      }));
    });

    it('uses the English catalog titles for trigger and procedure object-edit tabs', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      editorState.value = 'call audit.users_bi(); call reporting.refresh_stats();';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
      backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
        if (sql.includes('SHOW CREATE TRIGGER')) {
          return { success: true, data: [{ 'SQL Original Statement': 'CREATE TRIGGER audit.users_bi BEFORE INSERT ON audit.users FOR EACH ROW SET @a = 1' }] };
        }
        if (sql.includes('information_schema.triggers') || sql.includes('SHOW TRIGGERS') || sql.includes('USER_TRIGGERS') || sql.includes('ALL_TRIGGERS')) {
          return { success: true, data: [{ trigger_name: 'users_bi', table_name: 'users', schema_name: 'audit' }] };
        }
        if (sql.includes('information_schema.routines') || sql.includes('SHOW FUNCTION STATUS') || sql.includes('SHOW PROCEDURE STATUS') || sql.includes('USER_OBJECTS') || sql.includes('ALL_OBJECTS')) {
          return { success: true, data: [{ routine_name: 'refresh_stats', routine_type: 'PROCEDURE', schema_name: 'reporting' }] };
        }
        return { success: true, data: [] };
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        for (let i = 0; i < 10; i += 1) {
          await Promise.resolve();
        }
      });

      await act(async () => {
        editorState.mouseDownListeners[0]?.({
          target: { position: { lineNumber: 1, column: 12 } },
          event: {
            leftButton: true,
            ctrlKey: true,
            metaKey: false,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
          },
        });
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      await act(async () => {
        editorState.mouseDownListeners[0]?.({
          target: { position: { lineNumber: 1, column: 39 } },
          event: {
            leftButton: true,
            ctrlKey: true,
            metaKey: false,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
          },
        });
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.stringMatching(/^query-edit-trigger-conn-1-main-audit-audit\.users_bi-\d+$/),
        title: 'Edit trigger: audit.users_bi',
        type: 'query',
        schemaName: 'audit',
        queryMode: 'object-edit',
      }));
      expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.stringMatching(/^query-edit-routine-conn-1-main-reporting-reporting\.refresh_stats-\d+$/),
        title: 'Edit Procedure: reporting.refresh_stats',
        type: 'query',
        schemaName: 'reporting',
        queryMode: 'object-edit',
      }));
    });

    it('uses the English catalog title for materialized view object-edit tabs', async () => {
      storeState.languagePreference = 'en-US';
      setCurrentLanguage('en-US');
      storeState.connections[0].config.type = 'starrocks';
      editorState.value = 'select * from analytics.mv_daily_stats';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'analytics' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [{ Tables_in_analytics: 'events' }] });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
      backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
        if (sql.includes("UPPER(TABLE_TYPE) LIKE '%MATERIALIZED%'") || sql.includes('SHOW MATERIALIZED VIEWS')) {
          return { success: true, data: [{ object_name: 'mv_daily_stats', schema_name: 'analytics' }] };
        }
        if (sql.includes('SHOW CREATE MATERIALIZED VIEW') || sql.includes('SHOW CREATE TABLE')) {
          return { success: true, data: [{ 'Create Table': 'CREATE MATERIALIZED VIEW analytics.mv_daily_stats AS SELECT 1 AS id' }] };
        }
        return { success: true, data: [] };
      });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'analytics' })} />);
      });
      await act(async () => {
        for (let i = 0; i < 10; i += 1) {
          await Promise.resolve();
        }
      });

      await act(async () => {
        editorState.mouseDownListeners[0]?.({
          target: { position: { lineNumber: 1, column: 37 } },
          event: {
            leftButton: true,
            ctrlKey: true,
            metaKey: false,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
          },
        });
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.stringMatching(/^query-edit-object-conn-1-analytics-analytics-analytics\.mv_daily_stats-\d+$/),
        title: 'Edit Materialized view: analytics.mv_daily_stats',
        type: 'query',
        schemaName: 'analytics',
        queryMode: 'object-edit',
      }));
    });
  });

  it('switches current database on cmd left click for database identifiers', async () => {
    editorState.value = 'use analytics';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }, { Database: 'analytics' }] });
    backendApp.DBGetTables
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_main: 'users' }] })
      .mockResolvedValueOnce({ success: true, data: [{ Tables_in_analytics: 'events' }] });
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
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 6 } },
        event: {
          leftButton: true,
          ctrlKey: false,
          metaKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
    });

    expect(storeState.setActiveContext).toHaveBeenCalledWith({ connectionId: 'conn-1', dbName: 'analytics' });
    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(storeState.updateQueryTabDraft).toHaveBeenLastCalledWith('tab-1', expect.objectContaining({
      dbName: 'analytics',
    }));
  });

  it('skips heavy autocomplete metadata fetch for object edit query tabs', async () => {
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }, { Database: 'analytics' }] });

    await act(async () => {
      create(<QueryEditor tab={createTab({
        query: 'CREATE OR REPLACE VIEW reporting.active_users AS SELECT * FROM users;',
        dbName: 'main',
        queryMode: 'object-edit',
      })} />);
    });
    await act(async () => {
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBGetDatabases).toHaveBeenCalledTimes(1);
    expect(backendApp.DBGetTables).not.toHaveBeenCalled();
    expect(backendApp.DBGetAllColumns).not.toHaveBeenCalled();
    expect(backendApp.DBQuery).not.toHaveBeenCalled();
    expect(editorState.editor.deltaDecorations).toHaveBeenCalledWith([], []);
  });

  it('keeps the editor empty when a tab draft is externally synced to an empty query', async () => {
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT * FROM ' })} />);
    });

    await act(async () => {
      renderer.update(<QueryEditor tab={createTab({ query: '' })} />);
    });

    expect(editorState.value).toBe('');
    expect(editorState.editor.setValue).toHaveBeenCalledWith('');
  });

  it('does not restore a closed external SQL file after unmount cleanup', async () => {
    const filePath = '/Users/me/Documents/gonavi-queries/closed.sql';
    const tab = createTab({ filePath, query: 'select 1;' });
    storeState.tabs = [tab];

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={tab} />);
    });
    await act(async () => {
      editorState.value = 'select 2;';
      editorState.latestOnChange?.(editorState.value);
    });
    expect(getSQLFileTabDraft('tab-1')).toBe('select 2;');

    storeState.tabs = [];
    await act(async () => {
      renderer.unmount();
    });

    expect(getSQLFileTabDraft('tab-1')).toBe('');
  });

  it('writes the latest external SQL draft when the tab still exists on unmount', async () => {
    const filePath = '/Users/me/Documents/gonavi-queries/open.sql';
    const tab = createTab({ filePath, query: 'select 1;' });
    storeState.tabs = [tab];

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={tab} />);
    });
    editorState.value = 'select 2;';

    await act(async () => {
      renderer.unmount();
    });

    expect(getSQLFileTabDraft('tab-1')).toBe('select 2;');
  });

  it('writes external SQL file tabs back to disk without creating saved queries', async () => {
    let renderer!: ReactTestRenderer;
    const filePath = '/Users/me/Documents/gonavi-queries/report.sql';

    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ filePath })} />);
    });

    editorState.value = 'select 2;';

    await act(async () => {
      await findButton(renderer!, '保存').props.onClick();
    });

    expect(backendApp.WriteSQLFile).toHaveBeenCalledWith(filePath, 'select 2;');
    expect(storeState.saveQuery).not.toHaveBeenCalled();
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      filePath,
      query: 'select 2;',
      savedQueryId: undefined,
    }));
    expect(messageApi.success).toHaveBeenCalledWith('SQL 文件已保存。');
  });

  it('keeps external SQL file typing out of persisted tab drafts to avoid input freezes', async () => {
    const filePath = '/Users/me/Documents/gonavi-queries/report.sql';

    await act(async () => {
      create(<QueryEditor tab={createTab({ filePath })} />);
    });

    storeState.updateQueryTabDraft.mockClear();
    editorState.editor.deltaDecorations.mockClear();
    editorState.editor.getModel().getValue.mockClear();
    editorState.editor.getModel().getValueLength.mockClear();

    await act(async () => {
      editorState.value = 'select 1;\n1';
      editorState.latestOnChange?.(editorState.value);
      editorState.modelContentListeners.forEach((listener) => listener({
        changes: [{ text: '1' }],
      }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeState.updateQueryTabDraft).not.toHaveBeenCalledWith('tab-1', expect.objectContaining({
      query: 'select 1;\n1',
    }));
    expect(getSQLFileTabDraft('tab-1')).toBe('select 1;\n1');
    expect(editorState.editor.deltaDecorations).not.toHaveBeenCalled();
    expect(editorState.editor.getModel().getValue).not.toHaveBeenCalled();
    expect(editorState.editor.getModel().getValueLength).not.toHaveBeenCalled();
  });

  it('keeps large regular query typing out of persisted tab drafts to avoid input freezes', async () => {
    const largeSql = `select * from users;\n${'x'.repeat(60_000)}`;

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: 'select 1;' })} />);
    });

    storeState.updateQueryTabDraft.mockClear();
    editorState.editor.deltaDecorations.mockClear();
    editorState.editor.getModel().getValue.mockClear();
    editorState.editor.getModel().getValueLength.mockClear();

    await act(async () => {
      editorState.value = largeSql;
      editorState.latestOnChange?.(largeSql);
      editorState.modelContentListeners.forEach((listener) => listener({
        changes: [{ text: largeSql }],
      }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeState.updateQueryTabDraft).not.toHaveBeenCalledWith('tab-1', expect.objectContaining({
      query: largeSql,
    }));
    expect(getQueryTabDraft('tab-1')).toBe(largeSql);
    expect(editorState.editor.deltaDecorations).not.toHaveBeenCalled();
    expect(editorState.editor.getModel().getValueLength).not.toHaveBeenCalled();
    expect(editorState.editor.getModel().getValue).not.toHaveBeenCalled();
  });
});
