import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QueryEditor from './QueryEditor';
import {
    create,
    storeState,
    notifyStoreSubscribers,
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

  it('does not restore a missing table from a metadata request that started before validation', async () => {
    editorState.value = 'select * from customr;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'mkefu_ai_dev' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Tables_in_mkefu_ai_dev: 'customr' }],
    });
    let resolveColumns: ((value: { success: boolean; data: Array<Record<string, string>> }) => void) | undefined;
    backendApp.DBGetAllColumns.mockImplementationOnce(() => new Promise((resolve) => {
      resolveColumns = resolve;
    }));
    backendApp.DBTableExists.mockResolvedValueOnce({ success: true, data: { exists: false } });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'mkefu_ai_dev' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    const clickCustomr = () => editorState.mouseDownListeners[0]?.({
      target: { position: { lineNumber: 1, column: 'select * from customr'.length } },
      event: {
        browserEvent: { button: 0, buttons: 1 },
        ctrlKey: false,
        metaKey: true,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      },
    });
    await act(async () => {
      clickCustomr();
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
      }
    });
    expect(messageApi.warning).toHaveBeenCalledWith('表 customr 已不存在，已刷新 SQL 编辑器元数据。');

    await act(async () => {
      resolveColumns?.({
        success: true,
        data: [{ tableName: 'customr', name: 'id', type: 'bigint' }],
      });
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    backendApp.DBTableExists.mockClear();
    storeState.addTab.mockClear();
    await act(async () => {
      clickCustomr();
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBTableExists).not.toHaveBeenCalled();
    expect(storeState.addTab).not.toHaveBeenCalled();
  });

  it('keeps table navigation available when existence validation fails', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      editorState.value = 'select * from customer;';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({
        success: true,
        data: [{ Tables_in_main: 'customer' }],
      });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

      await act(async () => {
        create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      });
      await act(async () => {
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      backendApp.DBTableExists.mockRejectedValueOnce(new Error('metadata unavailable'));
      await act(async () => {
        editorState.mouseDownListeners[0]?.({
          target: { position: { lineNumber: 1, column: 'select * from customer'.length } },
          event: {
            browserEvent: { button: 0, buttons: 1 },
            ctrlKey: false,
            metaKey: true,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
          },
        });
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
      });

      expect(backendApp.DBGetTables).toHaveBeenCalledTimes(1);
      expect(backendApp.DBTableExists).toHaveBeenCalledWith(expect.anything(), 'main', 'customer');
      expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
      expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
        type: 'table',
        connectionId: 'conn-1',
        dbName: 'main',
        tableName: 'customer',
      }));
      expect(messageApi.warning).not.toHaveBeenCalled();
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('ignores a table navigation response after the query editor becomes inactive', async () => {
    editorState.value = 'select * from customer;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Tables_in_main: 'customer' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    let resolveValidation: ((value: { success: boolean; data: { exists: boolean } }) => void) | undefined;
    backendApp.DBTableExists.mockImplementationOnce(() => new Promise((resolve) => {
      resolveValidation = resolve;
    }));

    let renderer: ReactTestRenderer;
    const tab = createTab({ query: editorState.value, dbName: 'main' });
    await act(async () => {
      renderer = create(<QueryEditor tab={tab} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'select * from customer'.length } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      await Promise.resolve();
    });

    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(1);
    expect(backendApp.DBTableExists).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer!.update(<QueryEditor tab={tab} isActive={false} />);
    });
    await act(async () => {
      resolveValidation?.({ success: true, data: { exists: true } });
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('ignores a table navigation response after the Monaco editor is disposed', async () => {
    editorState.value = 'select * from customer;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Tables_in_main: 'customer' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    let resolveValidation: ((value: { success: boolean; data: { exists: boolean } }) => void) | undefined;
    backendApp.DBTableExists.mockImplementationOnce(() => new Promise((resolve) => {
      resolveValidation = resolve;
    }));

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
        target: { position: { lineNumber: 1, column: 'select * from customer'.length } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      await Promise.resolve();
    });

    const mountedModel = editorState.editor.getModel();
    editorState.editor.getModel.mockReturnValue(null);
    try {
      await act(async () => {
        resolveValidation?.({ success: true, data: { exists: false } });
        for (let i = 0; i < 4; i += 1) {
          await Promise.resolve();
        }
      });

      expect(backendApp.DBTableExists).toHaveBeenCalledTimes(1);
      expect(storeState.addTab).not.toHaveBeenCalled();
      expect(messageApi.warning).not.toHaveBeenCalled();
    } finally {
      editorState.editor.getModel.mockReturnValue(mountedModel);
    }
  });

  it('ignores a table navigation response after switching databases on the same connection', async () => {
    editorState.value = 'select * from customer;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({
      success: true,
      data: [{ Database: 'main' }, { Database: 'archive' }],
    });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Tables_in_main: 'customer' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    let resolveValidation: ((value: { success: boolean; data: { exists: boolean } }) => void) | undefined;
    backendApp.DBTableExists.mockImplementationOnce(() => new Promise((resolve) => {
      resolveValidation = resolve;
    }));

    let renderer: ReactTestRenderer;
    const tab = createTab({ query: editorState.value, dbName: 'main' });
    await act(async () => {
      renderer = create(<QueryEditor tab={tab} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 'select * from customer'.length } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      await Promise.resolve();
    });

    await act(async () => {
      renderer!.update(<QueryEditor tab={{ ...tab, dbName: 'archive' }} />);
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });
    await act(async () => {
      resolveValidation?.({ success: true, data: { exists: true } });
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBTableExists).toHaveBeenCalledWith(expect.anything(), 'main', 'customer');
    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('ignores a table navigation response after replacing the config of the same connection', async () => {
    editorState.value = 'select * from customer;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Tables_in_main: 'customer' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    let resolveValidation: ((value: { success: boolean; data: { exists: boolean } }) => void) | undefined;
    backendApp.DBTableExists.mockImplementationOnce(() => new Promise((resolve) => {
      resolveValidation = resolve;
    }));

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
        target: { position: { lineNumber: 1, column: 'select * from customer'.length } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
      await Promise.resolve();
    });

    storeState.connections = storeState.connections.map((connection) => (
      connection.id === 'conn-1'
        ? { ...connection, config: { ...connection.config, host: '10.0.0.2' } }
        : connection
    ));
    await act(async () => {
      notifyStoreSubscribers();
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });
    await act(async () => {
      resolveValidation?.({ success: true, data: { exists: true } });
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBTableExists).toHaveBeenCalledTimes(1);
    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('fails open when table existence validation times out', async () => {
    vi.useFakeTimers();
    try {
      editorState.value = 'select * from customer;';
      autoFetchState.visible = true;
      backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
      backendApp.DBGetTables.mockResolvedValueOnce({
        success: true,
        data: [{ Tables_in_main: 'customer' }],
      });
      backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
      backendApp.DBTableExists.mockImplementationOnce(() => new Promise(() => undefined));

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
          target: { position: { lineNumber: 1, column: 'select * from customer'.length } },
          event: {
            browserEvent: { button: 0, buttons: 1 },
            ctrlKey: false,
            metaKey: true,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
          },
        });
        await Promise.resolve();
      });

      expect(storeState.addTab).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        for (let i = 0; i < 4; i += 1) {
          await Promise.resolve();
        }
      });

      expect(backendApp.DBTableExists).toHaveBeenCalledTimes(1);
      expect(storeState.addTab).toHaveBeenCalledTimes(1);
      expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
        type: 'table',
        dbName: 'main',
        tableName: 'customer',
      }));
      expect(messageApi.warning).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('performs one table navigation action for repeated clicks on the same pending target', async () => {
    editorState.value = 'select * from customer;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Tables_in_main: 'customer' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    let resolveValidation: ((value: { success: boolean; data: { exists: boolean } }) => void) | undefined;
    backendApp.DBTableExists.mockImplementationOnce(() => new Promise((resolve) => {
      resolveValidation = resolve;
    }));

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    const clickCustomer = () => editorState.mouseDownListeners[0]?.({
      target: { position: { lineNumber: 1, column: 'select * from customer'.length } },
      event: {
        browserEvent: { button: 0, buttons: 1 },
        ctrlKey: false,
        metaKey: true,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      },
    });
    await act(async () => {
      clickCustomer();
      clickCustomer();
      await Promise.resolve();
    });
    expect(backendApp.DBTableExists).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveValidation?.({ success: true, data: { exists: true } });
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
      }
    });

    expect(storeState.addTab).toHaveBeenCalledTimes(1);
    expect(messageApi.warning).not.toHaveBeenCalled();
  });

  it('validates concurrent table links independently and clears each missing target', async () => {
    editorState.value = 'select * from alpha join beta on alpha.id = beta.id;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({
      success: true,
      data: [{ Tables_in_main: 'alpha' }, { Tables_in_main: 'beta' }],
    });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });

    backendApp.DBTableExists.mockResolvedValue({ success: true, data: { exists: false } });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    const clickTable = (tableName: string) => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: editorState.value.indexOf(tableName) + 2 } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: false,
          metaKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
      });
    };
    await act(async () => {
      clickTable('alpha');
      clickTable('beta');
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(1);
    expect(backendApp.DBTableExists).toHaveBeenCalledTimes(2);
    expect(backendApp.DBTableExists).toHaveBeenCalledWith(expect.anything(), 'main', 'alpha');
    expect(backendApp.DBTableExists).toHaveBeenCalledWith(expect.anything(), 'main', 'beta');
    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(storeState.addTab).not.toHaveBeenCalled();
    expect(messageApi.warning).toHaveBeenCalledWith('表 alpha 已不存在，已刷新 SQL 编辑器元数据。');
    expect(messageApi.warning).toHaveBeenCalledWith('表 beta 已不存在，已刷新 SQL 编辑器元数据。');
  });

  it('opens a routine object-edit tab on ctrl click without locating the sidebar tree', async () => {
    storeState.connections[0].config.type = 'postgres';
    editorState.value = 'call reporting.refresh_stats();';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      const text = String(sql || '');
      if (text.includes('pg_get_functiondef')) {
        return {
          success: true,
          data: [{
            routine_definition: 'CREATE OR REPLACE PROCEDURE reporting.refresh_stats() LANGUAGE plpgsql AS $$ BEGIN NULL; END; $$;',
          }],
        };
      }
      if (text.includes('FROM pg_proc') || text.includes('information_schema.routines')) {
        return {
          success: true,
          data: [{ schema_name: 'reporting', routine_name: 'refresh_stats', routine_type: 'PROCEDURE' }],
        };
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

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 21 } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault,
          stopPropagation,
        },
      });
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    expect(storeState.setActiveContext).not.toHaveBeenCalled();
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining('refresh_stats'),
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      queryMode: 'object-edit',
      routineName: 'reporting.refresh_stats',
      routineType: 'PROCEDURE',
      returnToTabId: 'tab-1',
      query: expect.stringContaining('CREATE OR REPLACE PROCEDURE reporting.refresh_stats()'),
    }));
    expect((window as any).dispatchEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'gonavi:locate-sidebar-object',
    }));
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('opens a MySQL procedure object-edit tab from a CALL routine link', async () => {
    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    editorState.value = 'CALL codex_tmp_proc_link_test();';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValueOnce({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBGetAllColumns.mockResolvedValueOnce({ success: true, data: [] });
    backendApp.DBQuery.mockImplementation(async (_config: any, _dbName: string, sql: string) => {
      const text = String(sql || '');
      if (text.includes('information_schema.routines') || text.includes('SHOW FUNCTION STATUS') || text.includes('SHOW PROCEDURE STATUS')) {
        return {
          success: true,
          data: [{ routine_name: 'codex_tmp_proc_link_test', routine_type: 'PROCEDURE', schema_name: 'main' }],
        };
      }
      if (text.includes('SHOW CREATE PROCEDURE')) {
        return {
          success: true,
          data: [{
            'Create Procedure': 'CREATE PROCEDURE codex_tmp_proc_link_test() BEGIN SELECT 1 AS codex_tmp_result; END',
          }],
        };
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

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber: 1, column: 12 } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          leftButton: true,
          ctrlKey: true,
          metaKey: false,
          preventDefault,
          stopPropagation,
        },
      });
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });

    expect(backendApp.DBQuery).toHaveBeenCalledWith(expect.any(Object), 'main', 'SHOW CREATE PROCEDURE `codex_tmp_proc_link_test`');
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining('codex_tmp_proc_link_test'),
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      queryMode: 'object-edit',
      query: expect.stringContaining('CREATE PROCEDURE codex_tmp_proc_link_test()'),
    }));
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('does not read the full editor model when ctrl/cmd clicking objects in large SQL', async () => {
    editorState.value = [
      ...Array.from({ length: 4000 }, (_, index) => `-- filler ${index + 1}`),
      'select * from analytics.events where id = 1',
    ].join('\n');
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

    editorState.editor.getModel().getValue.mockClear();
    editorState.editor.getModel().getValueLength.mockClear();
    const lineNumber = editorState.value.split('\n').length;
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    await act(async () => {
      editorState.mouseDownListeners[0]?.({
        target: { position: { lineNumber, column: 27 } },
        event: {
          browserEvent: { button: 0, buttons: 1 },
          ctrlKey: true,
          metaKey: false,
          preventDefault,
          stopPropagation,
        },
      });
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    });

    expect(editorState.editor.getModel().getValueLength).not.toHaveBeenCalled();
    expect(editorState.editor.getModel().getValue).not.toHaveBeenCalled();
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'analytics',
      tableName: 'events',
      initialViewMode: 'fields',
    }));
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('adds formatted DDL to the SQL table hover without opening the table', async () => {
    editorState.value = 'SELECT * FROM users';
    autoFetchState.visible = true;
    // ALTER 成功后会触发编辑器元数据重载，库/表元数据需持续返回以模拟真实场景（表仍然存在）
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBShowCreateTable
      .mockResolvedValueOnce({ success: true, data: 'CREATE TABLE users(id BIGINT PRIMARY KEY, name VARCHAR(64))' })
      .mockResolvedValueOnce({ success: true, data: 'CREATE TABLE users(id BIGINT PRIMARY KEY, name VARCHAR(64), email VARCHAR(128))' })
      .mockResolvedValueOnce({ success: true, data: 'CREATE TABLE users(id BIGINT PRIMARY KEY, name VARCHAR(64), email VARCHAR(128), status TINYINT)' });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(editorState.hoverProviders).toHaveLength(4);
    const ddlHover = await editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );

    expect(backendApp.DBShowCreateTable).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mysql' }),
      'main',
      'users',
    );
    expect(ddlHover?.contents?.[0]?.value).toContain('```sql');
    expect(ddlHover?.contents?.[0]?.value).toContain('CREATE TABLE users');
    const repeatedDdlHover = await editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    expect(repeatedDdlHover?.contents?.[0]?.value).toContain('CREATE TABLE users');
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(1);
    const metadataHover = editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
    );
    expect(metadataHover?.contents?.[0]?.value).toContain('**表** `users`');
    expect(storeState.addTab).not.toHaveBeenCalled();

    backendApp.DBQueryMulti.mockResolvedValueOnce({ success: true, data: [] });
    await act(async () => {
      editorState.value = 'ALTER TABLE users ADD COLUMN email VARCHAR(128)';
      editorState.latestOnChange?.(editorState.value);
      await findButton(renderer, '运行').props.onClick();
    });

    editorState.value = 'SELECT * FROM users';
    const refreshedDdlHover = await editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(2);
    expect(refreshedDdlHover?.contents?.[0]?.value).toContain('email VARCHAR(128)');

    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: false,
      partial: true,
      executedCount: 1,
      message: 'second statement failed',
      data: [],
    });
    await act(async () => {
      editorState.value = 'ALTER TABLE users ADD COLUMN status TINYINT; SELECT * FROM missing_table';
      editorState.latestOnChange?.(editorState.value);
      await findButton(renderer, '运行').props.onClick();
    });

    editorState.value = 'SELECT * FROM users';
    const partialBatchDdlHover = await editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(3);
    expect(partialBatchDdlHover?.contents?.[0]?.value).toContain('status TINYINT');
  });

  it('reuses a completed DDL hover cache after the database context makes a round trip', async () => {
    editorState.value = 'SELECT * FROM users';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({
      success: true,
      data: [{ Database: 'main' }, { Database: 'other' }],
    });
    backendApp.DBGetTables.mockImplementation(async (_config: unknown, dbName: string) => ({
      success: true,
      data: dbName === 'main' ? [{ Tables_in_main: 'users' }] : [],
    }));
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBShowCreateTable.mockResolvedValue({
      success: true,
      data: 'CREATE TABLE users (id BIGINT PRIMARY KEY)',
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    const firstDdlHover = await editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    expect(firstDdlHover?.contents?.[0]?.value).toContain('CREATE TABLE users');
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.update(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'other' })} />);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    await act(async () => {
      renderer.update(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

    const repeatedDdlHover = await editorState.hoverProviders[2]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );
    expect(repeatedDdlHover?.contents?.[0]?.value).toContain('CREATE TABLE users');
    expect(backendApp.DBShowCreateTable).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('does not use the active tab metadata for a non-active Monaco model', async () => {
    editorState.value = 'SELECT * FROM users';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBShowCreateTable.mockResolvedValue({
      success: true,
      data: 'CREATE TABLE users (id BIGINT PRIMARY KEY)',
    });

    const activeModel = editorState.editor.getModel();
    activeModel.uri = { toString: () => 'gonavi://active-model' };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });

    const foreignModel = {
      ...activeModel,
      uri: { toString: () => 'gonavi://foreign-model' },
    };
    const metadataHover = editorState.hoverProviders[0]?.provideHover(
      foreignModel,
      { lineNumber: 1, column: editorState.value.length },
    );
    const ddlHover = await editorState.hoverProviders[2]?.provideHover(
      foreignModel,
      { lineNumber: 1, column: editorState.value.length },
      { isCancellationRequested: false },
    );

    expect(metadataHover).toBeNull();
    expect(ddlHover).toBeNull();
    expect(backendApp.DBShowCreateTable).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('renders table metadata when a formatted query places FROM and the table on separate lines', async () => {
    editorState.value = 'SELECT *\nFROM\n  users';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_main: 'users' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const lineContent = editorState.editor.getModel().getLineContent(3);
    const metadataHover = editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 3, column: lineContent.length + 1 },
    );

    expect(metadataHover?.contents?.[0]?.value).toContain('**表** `users`');
  });

  it('renders metadata for the screenshot-shaped table reference with leading blank lines', async () => {
    editorState.value = '\n\nSELECT *\nFROM test_users;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_main: 'test_users' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const metadataHover = editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 4, column: 10 },
    );

    expect(metadataHover?.contents?.[0]?.value).toContain('**表** `test_users`');
  });

  it('renders metadata for a table in a later cross-line statement', async () => {
    editorState.value = 'SELECT * FROM test_users;\n\nSELECT *\nFROM\n  test_users;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'db1' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_db1: 'test_users' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'db1' })} />);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    const lineContent = editorState.editor.getModel().getLineContent(5);
    const metadataHover = editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 5, column: lineContent.length + 1 },
    );

    expect(metadataHover?.contents?.[0]?.value).toContain('**表** `test_users`');
    expect(metadataHover?.contents?.[0]?.value).toContain('库：`db1`');
    renderer.unmount();
  });

  it('renders a table source when the loaded table list does not contain the hovered name', async () => {
    editorState.value = 'SELECT *\nFROM test_users;';
    autoFetchState.visible = true;
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ Tables_in_main: 'other_table' }] });
    backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const metadataHover = editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 2, column: 15 },
    );

    expect(metadataHover?.contents?.[0]?.value).toContain('**表** `test_users`');
  });

  it('renders fallback table metadata when automatic metadata loading is disabled', async () => {
    editorState.value = 'SELECT * FROM test_users;';
    autoFetchState.visible = false;

    await act(async () => {
      create(<QueryEditor tab={createTab({ query: editorState.value, dbName: 'main' })} />);
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });

    const metadataHover = editorState.hoverProviders[0]?.provideHover(
      editorState.editor.getModel(),
      { lineNumber: 1, column: editorState.value.length },
    );

    expect(metadataHover?.contents?.[0]?.value).toContain('**表** `test_users`');
    expect(metadataHover?.contents?.[0]?.value).toContain('库：`main`');
  });
});
