// 拆分后各场景文件共用的 describe 级 beforeEach / afterEach。
import { vi } from 'vitest';
import { resetDataGridDdlViewSharedStateForTests } from './useDataGridDdlView';
import { setCurrentLanguage } from '../i18n';
import { resetTableMetadataRequestCacheForTests } from '../utils/tableMetadataRequestCache';
import { storeState, backendApp, testRenderState } from './dataGridDdlTestState';

export const setUpDataGridDdlTest = () => {
    resetTableMetadataRequestCacheForTests();
    backendApp.DBGetColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetIndexes.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetForeignKeys.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetTriggers.mockResolvedValue({ success: true, data: [] });
    backendApp.DBQuery.mockResolvedValue({ success: true, data: [] });
    backendApp.DBShowCreateTable.mockResolvedValue({ success: true, data: 'CREATE TABLE users' });
    setCurrentLanguage('zh-CN');
    storeState.queryOptions.showColumnComment = false;
    storeState.queryOptions.showColumnType = false;

    storeState.connections[0].config.type = 'mysql';
    storeState.connections[0].config.database = 'main';
    storeState.dataEditTransactionOptions = {
      commitMode: 'manual',
      autoCommitDelayMs: 5000,
    };
    storeState.setDataEditTransactionOptions.mockReset();
    storeState.setDataEditTransactionOptions.mockImplementation((options: Partial<typeof storeState.dataEditTransactionOptions>) => {
      storeState.dataEditTransactionOptions = {
        ...storeState.dataEditTransactionOptions,
        ...options,
      };
    });
    storeState.addSqlLog.mockReset();
    storeState.addTab.mockReset();
    storeState.setActiveContext.mockReset();
    storeState.tablePinnedLeftColumns = {};
    storeState.setTablePinnedLeftColumns.mockReset();
    testRenderState.latestColumns = [];
    testRenderState.latestTableProps = null;
    testRenderState.latestMonacoMouseDownListeners = [];
    testRenderState.latestMonacoMouseUpListeners = [];
    testRenderState.latestMonacoScrollChangeListeners = [];
    testRenderState.latestMonacoMouseTargetType = null;
    testRenderState.latestMonacoScrollLeft = 0;
    testRenderState.latestMonacoEditor = null;
    testRenderState.latestDatePickerProps = null;
    testRenderState.latestTimePickerProps = null;
    testRenderState.formValidateFields.mockReset();
    testRenderState.formValidateFields.mockResolvedValue({});
    testRenderState.formGetFieldValue.mockReset();
    resetDataGridDdlViewSharedStateForTests();

    const localStorageState = new Map<string, string>();

    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      activeElement: null,
      elementFromPoint: vi.fn(() => null),
      createElement: vi.fn(() => ({
        style: {},
        getContext: vi.fn(() => ({ measureText: vi.fn(() => ({ width: 0 })) })),
      })),
      body: { style: {} },
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      innerHeight: 768,
      innerWidth: 1024,
      getComputedStyle: vi.fn(() => ({ font: '12px sans-serif' })),
      localStorage: {
        getItem: vi.fn((key: string) => localStorageState.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          localStorageState.set(key, String(value));
        }),
        removeItem: vi.fn((key: string) => {
          localStorageState.delete(key);
        }),
      },
    });
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      userAgent: '',
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    });
    vi.stubGlobal('HTMLElement', class {});
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  };

export const tearDownDataGridDdlTest = () => {
    vi.useRealTimers();
    backendApp.ImportData.mockReset();
    backendApp.ExportTable.mockReset();
    backendApp.ExportData.mockReset();
    backendApp.ExportDataWithOptions.mockReset();
    backendApp.ExportQuery.mockReset();
    backendApp.ExportQueryWithOptions.mockReset();
    backendApp.ApplyChanges.mockReset();
    backendApp.PreviewChanges.mockReset();
    backendApp.DBGetColumns.mockReset();
    backendApp.DBGetIndexes.mockReset();
    backendApp.DBGetForeignKeys.mockReset();
    backendApp.DBGetTriggers.mockReset();
    backendApp.DBQuery.mockReset();
    backendApp.DBShowCreateTable.mockReset();
    resetDataGridDdlViewSharedStateForTests();
    vi.unstubAllGlobals();
  };
