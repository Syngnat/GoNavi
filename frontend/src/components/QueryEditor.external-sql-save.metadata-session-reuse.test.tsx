import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QueryEditor from './QueryEditor';
import {
    create,
    storeState,
    notifyStoreSubscribers,
    backendApp,
    autoFetchState,
    antdSelectState,
    editorState,
    createTab,
} from './queryEditorExternalSqlSaveTestSupport';
import { setUpQueryEditorExternalSqlSaveTest, tearDownQueryEditorExternalSqlSaveTest } from './queryEditorExternalSqlSaveTestHooks';
import { QUERY_EDITOR_SESSION_METADATA_STALE_MS } from './queryEditor/metadata/queryEditorSessionMetadataStore';

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

const SQL = 'select * from users join orders on true';
const USERS_COLUMN = 'select * from us'.length;
const ORDERS_COLUMN = 'select * from users join ord'.length;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const flush = async (rounds = 40) => {
  await act(async () => {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  });
};

const latestSchemaSelect = () => [...antdSelectState.props].reverse().find((props) => (
  String(props.className || '').includes('gn-v2-query-toolbar-schema-select')
));

const metadataRequestCount = () => (
  backendApp.DBGetTables.mock.calls.length
  + backendApp.DBGetAllColumns.mock.calls.length
  + backendApp.DBQuery.mock.calls.length
);

const mockPostgresCatalog = (tables: () => string[]) => {
  backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [{ Database: 'main' }] });
  backendApp.DBGetTables.mockImplementation(async () => ({
    success: true,
    data: tables().map((name) => ({ Table: name })),
  }));
  backendApp.DBGetAllColumns.mockResolvedValue({ success: true, data: [] });
  backendApp.DBQuery.mockImplementation(async (_config: unknown, _dbName: string, sql: string) => {
    if (/current_schema\(\)/i.test(sql)) return { success: true, data: [{ schema_name: 'public' }] };
    if (/FROM pg_namespace WHERE/i.test(sql)) {
      return { success: true, data: [{ schema_name: 'public' }, { schema_name: 'sales' }] };
    }
    return { success: true, data: [] };
  });
};

const openQueryTab = async (tabId: string) => {
  const listenerIndex = editorState.mouseDownListeners.length;
  await act(async () => {
    create(<QueryEditor tab={createTab({ id: tabId, query: SQL, dbName: 'main' })} isActive />);
  });
  return {
    // Whether Ctrl/Cmd+click resolved the identifier under the cursor to an object.
    ctrlClick: (column: number): boolean => {
      const preventDefault = vi.fn();
      editorState.mouseDownListeners[listenerIndex]?.({
        target: { position: { lineNumber: 1, column } },
        event: { leftButton: true, ctrlKey: true, metaKey: false, preventDefault, stopPropagation: vi.fn() },
      });
      return preventDefault.mock.calls.length > 0;
    },
  };
};

describe('QueryEditor metadata reuse across query tabs', () => {
  beforeEach(() => {
    setUpQueryEditorExternalSqlSaveTest();
    autoFetchState.visible = true;
    storeState.connections[0].config.type = 'postgres';
    editorState.value = SQL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tearDownQueryEditorExternalSqlSaveTest();
  });

  it('lets a second query tab navigate at once without loading the catalog or the schema list again', async () => {
    mockPostgresCatalog(() => ['public.users']);
    const firstTab = await openQueryTab('tab-1');
    await flush();
    expect(firstTab.ctrlClick(USERS_COLUMN)).toBe(true);
    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(1);
    const requestsAfterFirstTab = metadataRequestCount();

    // Anything the second tab still asked the database for would now hang.
    const never = new Promise<never>(() => undefined);
    backendApp.DBGetTables.mockImplementation(() => never);
    backendApp.DBGetAllColumns.mockImplementation(() => never);
    backendApp.DBQuery.mockImplementation(() => never);
    antdSelectState.props.length = 0;
    const secondTab = await openQueryTab('tab-2');

    expect(secondTab.ctrlClick(USERS_COLUMN)).toBe(true);
    expect(latestSchemaSelect()).toMatchObject({ value: 'public', loading: false, disabled: false });
    expect(latestSchemaSelect()?.options.map((option: any) => option.value)).toEqual(['public', 'sales']);
    expect(antdSelectState.props.some((props) => (
      String(props.className || '').includes('gn-v2-query-toolbar-schema-select') && props.loading
    ))).toBe(false);
    await flush();
    expect(metadataRequestCount()).toBe(requestsAfterFirstTab);
  });

  it('loads the catalog again for the next tab after a structure change was reported', async () => {
    let tables = ['public.users'];
    mockPostgresCatalog(() => tables);
    const baseWindow: any = window;
    const refreshListeners: Array<(event: Event) => void> = [];
    vi.stubGlobal('window', {
      ...baseWindow,
      addEventListener: (type: string, handler: (event: Event) => void) => {
        if (type === 'gonavi:sidebar-database-refresh') refreshListeners.push(handler);
      },
      removeEventListener: (_type: string, handler: (event: Event) => void) => {
        const index = refreshListeners.indexOf(handler);
        if (index >= 0) refreshListeners.splice(index, 1);
      },
      dispatchEvent: (event: Event) => {
        refreshListeners.slice().forEach((handler) => handler(event));
        return true;
      },
    });
    await openQueryTab('tab-1');
    await flush();
    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(1);

    tables = ['public.users', 'public.orders'];
    await act(async () => {
      window.dispatchEvent(new CustomEvent('gonavi:sidebar-database-refresh', {
        detail: { connectionId: 'conn-1', dbName: 'main' },
      }));
    });
    await flush();
    // The open tab reloaded once; the tab opened afterwards shares that reload.
    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(2);
    const secondTab = await openQueryTab('tab-2');
    await flush();

    expect(secondTab.ctrlClick(ORDERS_COLUMN)).toBe(true);
    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(2);
  });

  it('starts loading the columns on Ctrl+click and opens the table as soon as they arrive', async () => {
    mockPostgresCatalog(() => ['public.users']);
    const tab = await openQueryTab('tab-1');
    await flush();
    // The existence check is still on its way; columns coming back already prove the table is there.
    backendApp.DBTableExists.mockImplementation(() => new Promise(() => undefined));
    backendApp.DBGetColumns.mockResolvedValue({ success: true, data: [{ name: 'id', type: 'bigint' }] });

    expect(tab.ctrlClick(USERS_COLUMN)).toBe(true);
    expect(backendApp.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'main', 'public.users');
    await flush();

    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({ type: 'table', tableName: 'public.users' }));
  });

  it('still waits for the existence check when the columns request tells nothing', async () => {
    mockPostgresCatalog(() => ['public.users']);
    const tab = await openQueryTab('tab-1');
    await flush();
    const validation = deferred<unknown>();
    backendApp.DBTableExists.mockImplementation(() => validation.promise);
    backendApp.DBGetColumns.mockResolvedValue({ success: true, data: [] });

    expect(tab.ctrlClick(USERS_COLUMN)).toBe(true);
    await flush();
    expect(storeState.addTab).not.toHaveBeenCalled();

    validation.resolve({ success: true, data: { exists: false } });
    await flush();
    expect(storeState.addTab).not.toHaveBeenCalled();
  });

  it('serves an old catalog at once and refreshes it in the background', async () => {
    let tables = ['public.users'];
    mockPostgresCatalog(() => tables);
    await openQueryTab('tab-1');
    await flush();
    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(1);

    const loadedAt = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(loadedAt + QUERY_EDITOR_SESSION_METADATA_STALE_MS + 1_000);
    tables = ['public.users', 'public.orders'];
    const refreshedTables = deferred<unknown>();
    backendApp.DBGetTables.mockImplementationOnce(() => refreshedTables.promise);
    antdSelectState.props.length = 0;
    const secondTab = await openQueryTab('tab-2');
    await flush();

    // The refresh is on its way, but neither navigation nor the schema picker waits for it.
    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(2);
    expect(secondTab.ctrlClick(USERS_COLUMN)).toBe(true);
    expect(secondTab.ctrlClick(ORDERS_COLUMN)).toBe(false);
    expect(antdSelectState.props.some((props) => (
      String(props.className || '').includes('gn-v2-query-toolbar-schema-select') && props.loading
    ))).toBe(false);

    // An unrelated store update re-runs the editor's loading effect; the refresh must survive that.
    await act(async () => {
      storeState.connections = [...storeState.connections];
      notifyStoreSubscribers();
    });
    await flush();
    expect(secondTab.ctrlClick(ORDERS_COLUMN)).toBe(false);

    refreshedTables.resolve({ success: true, data: tables.map((name) => ({ Table: name })) });
    await flush();
    expect(secondTab.ctrlClick(ORDERS_COLUMN)).toBe(true);
    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(2);
  });
});
