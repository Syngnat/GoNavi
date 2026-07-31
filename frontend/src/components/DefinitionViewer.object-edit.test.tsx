import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TabData } from '../types';
import { I18nProvider } from '../i18n/provider';
import { clearQueryTabDraft, hasQueryTabDraft, setQueryTabDraft } from '../utils/sqlFileTabDrafts';
import DefinitionViewer from './DefinitionViewer';

const storeState = vi.hoisted(() => ({
  connections: [
    {
      id: 'conn-1',
      name: 'local',
      config: {
        type: 'postgres',
        host: '127.0.0.1',
        port: 5432,
        user: 'postgres',
        password: '',
        database: 'main',
      },
    },
  ],
  theme: 'light',
  addTab: vi.fn(),
  setActiveContext: vi.fn(),
}));

const backendApp = vi.hoisted(() => ({
  DBQuery: vi.fn(),
  DBShowCreateTable: vi.fn(),
}));

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof storeState) => any) => selector(storeState),
}));

vi.mock('../../wailsjs/go/app/App', () => backendApp);
vi.mock('../i18n/runtime', () => ({
  syncLanguageRuntime: vi.fn(async () => undefined),
}));

vi.mock('@ant-design/icons', () => ({
  EditOutlined: () => <span data-icon="edit" />,
}));

vi.mock('./MonacoEditor', () => ({
  default: ({ value, options }: any) => (
    <pre data-editor="true" data-readonly={String(options?.readOnly)}>
      {value}
    </pre>
  ),
}));

vi.mock('antd', () => ({
  Spin: ({ tip }: any) => <div>{tip}</div>,
  Alert: ({ message, description }: any) => <div>{message}{description}</div>,
  Button: ({ children, onClick, icon }: any) => (
    <button type="button" onClick={onClick}>
      {icon}
      {children}
    </button>
  ),
}));

const flushPromises = async (count = 6) => {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
};

const renderWithI18n = (tab: TabData) => (
  <I18nProvider
    preference="en-US"
    systemLanguages={['en-US']}
    onPreferenceChange={() => undefined}
  >
    <DefinitionViewer tab={tab} />
  </I18nProvider>
);

const findButtonText = (node: any): string => (
  (node.children || [])
    .map((item: any) => (typeof item === 'string' ? item : findButtonText(item)))
    .join('')
);

const createTab = (overrides: Partial<TabData> = {}): TabData => ({
  id: 'view-def-conn-1-main-reporting.active_users',
  title: '视图: reporting.active_users',
  type: 'view-def',
  connectionId: 'conn-1',
  dbName: 'main',
  viewName: 'reporting.active_users',
  viewKind: 'view',
  schemaName: 'reporting',
  ...overrides,
});

describe('DefinitionViewer object edit entry', () => {
  beforeEach(() => {
    storeState.addTab.mockReset();
    storeState.setActiveContext.mockReset();
    storeState.theme = 'light';
    storeState.connections[0].config.type = 'postgres';
    clearQueryTabDraft('routine-def-conn-1-H2-H2.F_GET_BUSPRICE');
    backendApp.DBQuery.mockReset();
    backendApp.DBShowCreateTable.mockReset();
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [{ view_definition: 'SELECT id, name FROM users' }],
    });
    backendApp.DBShowCreateTable.mockResolvedValue({
      success: false,
      message: 'not configured for this test',
    });
  });

  it('opens an editable query tab for view definitions', async () => {
    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(createTab()));
      await flushPromises();
    });

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];
    const editorText = String(renderer.root.findAll((node: any) => node.props['data-editor'] === 'true')[0].children.join(''));
    expect(editorText).toContain('CREATE OR REPLACE VIEW reporting.active_users AS');
    expect(editorText).toContain('SELECT id, name FROM users;');

    await act(async () => {
      button.props.onClick();
    });

    expect(storeState.setActiveContext).toHaveBeenCalledWith({ connectionId: 'conn-1', dbName: 'main' });
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: 'view-def-conn-1-main-reporting.active_users',
      title: 'Edit View: reporting.active_users',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      queryMode: 'object-edit',
      query: expect.stringContaining('CREATE OR REPLACE VIEW reporting.active_users AS'),
    }));
    expect(storeState.addTab.mock.calls[0][0].query).toContain('-- Edit View: reporting.active_users');
    expect(storeState.addTab.mock.calls[0][0].query).toContain('-- Confirm the syntax is compatible with the current database before running it');
    expect(storeState.addTab.mock.calls[0][0].query).toContain('SELECT id, name FROM users;');
  });

  it('formats a one-line Oracle catalog view definition for display and editing', async () => {
    storeState.connections[0].config.type = 'oracle';
    backendApp.DBShowCreateTable.mockResolvedValue({
      success: true,
      data: `CREATE OR REPLACE VIEW APP.V_RISK AS SELECT a.id,NVL(b.org_name,'-') AS org_name FROM org a LEFT JOIN org_info b ON b.org_id=a.id WHERE a.deleted_flag=0`,
    });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(createTab({
        id: 'view-def-conn-1-APP-APP.V_RISK',
        title: '视图: APP.V_RISK',
        dbName: 'APP',
        viewName: 'APP.V_RISK',
        schemaName: 'APP',
      })));
      await flushPromises();
    });

    expect(backendApp.DBShowCreateTable).toHaveBeenCalledWith(expect.anything(), 'APP', 'APP.V_RISK');
    expect(backendApp.DBQuery).not.toHaveBeenCalled();
    const editorText = String(renderer.root.findAll((node: any) => node.props['data-editor'] === 'true')[0].children.join(''));
    expect(editorText).toContain('CREATE OR REPLACE VIEW APP.V_RISK AS');
    expect(editorText).toContain('SELECT\n  a.id,');
    expect(editorText).toContain('\nFROM\n  org a');
    expect(editorText).toContain('\nWHERE\n  a.deleted_flag = 0;');

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];
    await act(async () => {
      button.props.onClick();
    });

    const query = String(storeState.addTab.mock.calls[0][0].query || '');
    expect(query).toContain('SELECT\n  a.id,');
    expect(query).toContain('\nWHERE\n  a.deleted_flag = 0;');
  });

  it('adds CREATE OR REPLACE without duplicating view fragments returned without ddl prefix', async () => {
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [{ view_definition: 'VIEW reporting.active_users AS\nSELECT id, name FROM users' }],
    });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(createTab()));
      await flushPromises();
    });

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];

    await act(async () => {
      button.props.onClick();
    });

    const query = storeState.addTab.mock.calls[0][0].query;
    expect(query).toContain('CREATE OR REPLACE VIEW reporting.active_users AS');
    expect(query).toContain('SELECT id, name FROM users;');
    expect(query).not.toContain('AS\nVIEW reporting.active_users AS');
  });

  it('opens an editable query tab for routine definitions', async () => {
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [{ routine_definition: 'CREATE OR REPLACE FUNCTION reporting.refresh_stats() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;' }],
    });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(createTab({
        id: 'routine-def-conn-1-main-reporting.refresh_stats',
        title: '函数: reporting.refresh_stats',
        type: 'routine-def',
        routineName: 'reporting.refresh_stats',
        routineType: 'FUNCTION',
        viewName: undefined,
        viewKind: undefined,
      })));
      await flushPromises();
    });

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];

    await act(async () => {
      button.props.onClick();
    });

    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: 'routine-def-conn-1-main-reporting.refresh_stats',
      title: 'Edit Function/procedure: reporting.refresh_stats',
      type: 'query',
      queryMode: 'object-edit',
      query: expect.stringContaining('CREATE OR REPLACE FUNCTION reporting.refresh_stats()'),
    }));
  });

  it('reuses the displayed routine definition when opening object edit without refetching', async () => {
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [{ routine_definition: 'CREATE OR REPLACE FUNCTION reporting.refresh_stats() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;' }],
    });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(createTab({
        id: 'routine-def-conn-1-main-reporting.refresh_stats',
        title: '函数: reporting.refresh_stats',
        type: 'routine-def',
        routineName: 'reporting.refresh_stats',
        routineType: 'FUNCTION',
        viewName: undefined,
        viewKind: undefined,
      })));
      await flushPromises();
    });

    backendApp.DBQuery.mockClear();
    backendApp.DBQuery.mockImplementation(() => new Promise(() => undefined));

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];

    await act(async () => {
      button.props.onClick();
      await Promise.resolve();
    });

    expect(backendApp.DBQuery).not.toHaveBeenCalled();
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: 'routine-def-conn-1-main-reporting.refresh_stats',
      title: 'Edit Function/procedure: reporting.refresh_stats',
      type: 'query',
      queryMode: 'object-edit',
      query: expect.stringContaining('CREATE OR REPLACE FUNCTION reporting.refresh_stats()'),
    }));
  });

  it('opens an editable query tab for event definitions', async () => {
    storeState.connections[0].config.type = 'mysql';
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [{
        Event: 'daily_cleanup',
        'Create Event': 'CREATE EVENT `daily_cleanup`\nON SCHEDULE EVERY 1 DAY\nDO DELETE FROM logs',
      }],
    });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(createTab({
        id: 'event-def-conn-1-main-daily_cleanup',
        title: '事件: daily_cleanup',
        type: 'event-def',
        eventName: 'daily_cleanup',
        viewName: undefined,
        viewKind: undefined,
      })));
      await flushPromises();
    });

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];

    await act(async () => {
      button.props.onClick();
    });

    const query = storeState.addTab.mock.calls[0][0].query;
    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: 'event-def-conn-1-main-daily_cleanup',
      title: 'Edit Event: daily_cleanup',
      type: 'query',
      queryMode: 'object-edit',
      query: expect.stringContaining('CREATE EVENT `daily_cleanup`'),
    }));
    expect(query).toContain('-- Edit Event: daily_cleanup');
    expect(query).toContain('ON SCHEDULE EVERY 1 DAY');
    expect(query).not.toContain('SHOW CREATE EVENT');
  });

  it('uses SQL Server catalog metadata when loading routine definitions', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [{ routine_definition: 'CREATE PROCEDURE [reporting].[refresh_stats]\nAS\nSELECT 1;' }],
    });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(createTab({
        id: 'routine-def-conn-1-main-reporting.refresh_stats',
        title: '存储过程: reporting.refresh_stats',
        type: 'routine-def',
        routineName: 'reporting.refresh_stats',
        routineType: 'PROCEDURE',
        viewName: undefined,
        viewKind: undefined,
      })));
      await flushPromises();
    });

    const sql = String(backendApp.DBQuery.mock.calls[0][2] || '');
    expect(sql).toContain('FROM [main].sys.all_sql_modules AS m');
    expect(sql).toContain("WHERE o.name = N'refresh_stats'");
    expect(sql).toContain("AND s.name = N'reporting'");
    expect(sql).not.toContain('OBJECT_DEFINITION');
    expect(String(renderer.root.findAll((node: any) => node.props['data-editor'] === 'true')[0].children.join(''))).toContain('CREATE PROCEDURE [reporting].[refresh_stats]');
  });

  it('joins SQL Server sp_helptext rows when catalog metadata is empty', async () => {
    storeState.connections[0].config.type = 'sqlserver';
    backendApp.DBQuery
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({
        success: true,
        data: [
          { Text: 'CREATE PROCEDURE [reporting].[refresh_stats]\n' },
          { Text: 'AS\n' },
          { Text: 'BEGIN\n  SELECT 1;\nEND' },
        ],
      });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(createTab({
        id: 'routine-def-conn-1-main-reporting.refresh_stats',
        title: '存储过程: reporting.refresh_stats',
        type: 'routine-def',
        routineName: 'reporting.refresh_stats',
        routineType: 'PROCEDURE',
        viewName: undefined,
        viewKind: undefined,
      })));
      await flushPromises();
    });

    expect(backendApp.DBQuery.mock.calls[1][2]).toBe("EXEC [main].sys.sp_helptext @objname = N'[reporting].[refresh_stats]'");
    const editorText = String(renderer.root.findAll((node: any) => node.props['data-editor'] === 'true')[0].children.join(''));
    expect(editorText).toContain('CREATE PROCEDURE [reporting].[refresh_stats]');
    expect(editorText).toContain('BEGIN\n  SELECT 1;\nEND');
  });

  it('adds CREATE OR REPLACE for routine source snippets returned without ddl prefix', async () => {
    storeState.connections[0].config.type = 'oracle';
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [
        { TEXT: 'PROCEDURE proc_tally2accept(p_id IN NUMBER) IS\n' },
        { TEXT: '  v_count PLS_INTEGER;\n' },
        { TEXT: 'BEGIN\n' },
        { TEXT: '  SELECT COUNT(*) INTO v_count FROM dual;\n' },
        { TEXT: 'END;\n' },
      ],
    });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(createTab({
        id: 'routine-def-conn-1-main-proc_tally2accept',
        title: '存储过程: proc_tally2accept',
        type: 'routine-def',
        routineName: 'proc_tally2accept',
        routineType: 'PROCEDURE',
        viewName: undefined,
        viewKind: undefined,
      })));
      await flushPromises();
    });

    const editorText = String(renderer.root.findAll((node: any) => node.props['data-editor'] === 'true')[0].children.join(''));
    expect(editorText).toContain('CREATE OR REPLACE PROCEDURE proc_tally2accept(p_id IN NUMBER)');
    expect(editorText).toContain('v_count PLS_INTEGER;');

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];

    await act(async () => {
      button.props.onClick();
    });

    const query = storeState.addTab.mock.calls[0][0].query;
    expect(query).toContain('CREATE OR REPLACE PROCEDURE proc_tally2accept(p_id IN NUMBER)');
    expect(query).toContain('v_count PLS_INTEGER;');
    expect(query).toContain('SELECT COUNT(*) INTO v_count FROM dual;');
  });

  it('clears stale same-tab drafts before opening object edit so comments are not replaced', async () => {
    storeState.connections[0].config.type = 'oracle';
    const tab = createTab({
      id: 'routine-def-conn-1-H2-H2.F_GET_BUSPRICE',
      title: '函数: H2.F_GET_BUSPRICE',
      type: 'routine-def',
      dbName: 'H2',
      routineName: 'H2.F_GET_BUSPRICE',
      routineType: 'FUNCTION',
      viewName: undefined,
      viewKind: undefined,
    });
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [
        { TEXT: 'FUNCTION "F_GET_BUSPRICE"(p_compid t_store_d.compid%TYPE,\n' },
        { TEXT: '                            p_busno  t_store_d.busno%TYPE,\n' },
        { TEXT: '                            p_wareid t_store_d.wareid%TYPE,\n' },
        { TEXT: '                            p_type   INTEGER)\n' },
        { TEXT: 'RETURN t_ware_saleprice.saleprice%TYPE IS\n\n' },
        { TEXT: 'BEGIN\n' },
        { TEXT: '  /*根据机构跟商品，返回对应的价格信息\n' },
        { TEXT: '  1: p_compid 企业编码\n' },
        { TEXT: '  2: p_busno 业务机构\n' },
        { TEXT: '  3: p_wareid 商品编码\n' },
        { TEXT: '  4: p_type 类型 1, 当前机构商品毛利率; 2, 当前机构商品毛利; 3, 当前机构商品最新进价; 4, 当前机构商品销售价\n' },
        { TEXT: '  */\n' },
        { TEXT: '  NULL; -- add by txy 1723 20171129 增加库存不等于0的条件\n' },
        { TEXT: 'END;\n' },
      ],
    });

    setQueryTabDraft(tab.id, [
      '-- 修改函数/存储过程: H2.F_GET_BUSPRICE',
      'CREATE OR REPLACE FUNCTION "F_GET_BUSPRICE" AS',
      'BEGIN',
      '  /*根据机构跟商品，返回对应的价格信息',
      '  1: p_compid 企业编码',
      '  */',
      'END;',
    ].join('\n'));
    expect(hasQueryTabDraft(tab.id)).toBe(true);

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(tab));
      await flushPromises();
    });

    const editorText = String(renderer.root.findAll((node: any) => node.props['data-editor'] === 'true')[0].children.join(''));
    expect(editorText).toContain('CREATE OR REPLACE FUNCTION "F_GET_BUSPRICE"');
    expect(editorText).toContain('4: p_type 类型 1, 当前机构商品毛利率; 2, 当前机构商品毛利; 3, 当前机构商品最新进价; 4, 当前机构商品销售价');

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];
    await act(async () => {
      await button.props.onClick();
      await flushPromises();
    });

    const editQuery = String(storeState.addTab.mock.calls[0][0].query || '');
    expect(editQuery).toContain('4: p_type 类型 1, 当前机构商品毛利率; 2, 当前机构商品毛利; 3, 当前机构商品最新进价; 4, 当前机构商品销售价');
    expect(editQuery).toContain('NULL; -- add by txy 1723 20171129 增加库存不等于0的条件');
    expect(hasQueryTabDraft(tab.id)).toBe(false);
  });

  it('opens an editable query tab for Oracle sequence definitions', async () => {
    storeState.connections[0].config.type = 'oracle';
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [{
        SEQUENCE_OWNER: 'H2',
        SEQUENCE_NAME: 'HWMS_PACK_SEQNO',
        MIN_VALUE: 1,
        MAX_VALUE: 999999999999,
        INCREMENT_BY: 1,
        CYCLE_FLAG: 'N',
        ORDER_FLAG: 'N',
        CACHE_SIZE: 20,
      }],
    });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(createTab({
        id: 'sequence-def-conn-1-H2-H2.HWMS_PACK_SEQNO',
        title: 'Sequence: H2.HWMS_PACK_SEQNO',
        type: 'sequence-def',
        sequenceName: 'H2.HWMS_PACK_SEQNO',
        viewName: undefined,
        viewKind: undefined,
      })));
      await flushPromises();
    });

    expect(String(backendApp.DBQuery.mock.calls[0][2] || '')).toContain('FROM ALL_SEQUENCES');
    const editorText = String(renderer.root.findAll((node: any) => node.props['data-editor'] === 'true')[0].children.join(''));
    expect(editorText).toContain('CREATE SEQUENCE H2.HWMS_PACK_SEQNO');
    expect(editorText).toContain('CACHE 20');

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];
    await act(async () => {
      await button.props.onClick();
      await flushPromises();
    });

    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: 'sequence-def-conn-1-H2-H2.HWMS_PACK_SEQNO',
      type: 'query',
      queryMode: 'object-edit',
      query: expect.stringContaining('CREATE SEQUENCE H2.HWMS_PACK_SEQNO'),
    }));
  });

  it('loads Oracle package specification and body definitions without dropping lines', async () => {
    storeState.connections[0].config.type = 'oracle';
    backendApp.DBQuery
      .mockResolvedValueOnce({
        success: true,
        data: [
          { TEXT: 'PACKAGE pkg_order AS\n' },
          { TEXT: '  PROCEDURE sync_order(p_id IN NUMBER);\n' },
          { TEXT: 'END pkg_order;\n' },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [
          { TEXT: 'PACKAGE BODY pkg_order AS\n' },
          { TEXT: '  PROCEDURE sync_order(p_id IN NUMBER) IS\n' },
          { TEXT: '  BEGIN\n' },
          { TEXT: '    NULL;\n' },
          { TEXT: '  END;\n' },
          { TEXT: 'END pkg_order;\n' },
        ],
      });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(createTab({
        id: 'package-def-conn-1-H2-H2.PKG_ORDER',
        title: 'Package: H2.PKG_ORDER',
        type: 'package-def',
        packageName: 'H2.PKG_ORDER',
        viewName: undefined,
        viewKind: undefined,
      })));
      await flushPromises();
    });

    expect(String(backendApp.DBQuery.mock.calls[0][2] || '')).toContain("TYPE = 'PACKAGE'");
    expect(String(backendApp.DBQuery.mock.calls[1][2] || '')).toContain("TYPE = 'PACKAGE BODY'");
    const editorText = String(renderer.root.findAll((node: any) => node.props['data-editor'] === 'true')[0].children.join(''));
    expect(editorText).toContain('CREATE OR REPLACE PACKAGE pkg_order AS');
    expect(editorText).toContain('PROCEDURE sync_order(p_id IN NUMBER);');
    expect(editorText).toContain('CREATE OR REPLACE PACKAGE BODY pkg_order AS');
    expect(editorText).toContain('NULL;');

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];
    await act(async () => {
      await button.props.onClick();
      await flushPromises();
    });

    const editQuery = String(storeState.addTab.mock.calls[0][0].query || '');
    expect(editQuery).toContain('CREATE OR REPLACE PACKAGE pkg_order AS');
    expect(editQuery).toContain('/\nCREATE OR REPLACE PACKAGE BODY pkg_order AS');
    expect(editQuery).toContain('END pkg_order;');
  });

  it('keeps Oracle routine SQLPlus slash delimiters executable when opening object edit', async () => {
    storeState.connections[0].config.type = 'oracle';
    backendApp.DBQuery
      .mockResolvedValueOnce({
        success: true,
        data: [
          { TEXT: 'CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1 AS\n' },
          { TEXT: 'BEGIN\n' },
          { TEXT: '  NULL;\n' },
          { TEXT: 'END cproc_tzhssr_order2sale_A1;\n' },
          { TEXT: '/\n' },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [
          { TEXT: 'CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1 AS\n' },
          { TEXT: 'BEGIN\n' },
          { TEXT: '  NULL;\n' },
          { TEXT: 'END cproc_tzhssr_order2sale_A1;\n' },
          { TEXT: '/\n' },
        ],
      });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(createTab({
        id: 'routine-def-conn-1-H2-H2.CPROC_TZHSSR_ORDER2SALE_A1',
        title: 'Procedure: H2.CPROC_TZHSSR_ORDER2SALE_A1',
        type: 'routine-def',
        routineName: 'H2.CPROC_TZHSSR_ORDER2SALE_A1',
        routineType: 'PROCEDURE',
        viewName: undefined,
        viewKind: undefined,
      })));
      await flushPromises();
    });

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];
    await act(async () => {
      await button.props.onClick();
      await flushPromises();
    });

    const editQuery = String(storeState.addTab.mock.calls[0][0].query || '');
    expect(editQuery).toContain('END cproc_tzhssr_order2sale_A1;\n/');
    expect(editQuery).not.toContain('/;');
  });

  it('uses the currently displayed object definition before opening object edit', async () => {
    backendApp.DBQuery
      .mockResolvedValueOnce({
        success: true,
        data: [{ view_definition: 'SELECT id FROM users' }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ view_definition: 'SELECT id, name, updated_at FROM users' }],
      });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(createTab()));
      await flushPromises();
    });

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];

    await act(async () => {
      await button.props.onClick();
      await flushPromises();
    });

    expect(backendApp.DBQuery).toHaveBeenCalledTimes(1);
    const query = storeState.addTab.mock.calls[0][0].query;
    expect(query).toContain('SELECT id FROM users;');
    expect(query).not.toContain('SELECT id, name, updated_at FROM users;');

    const editor = renderer.root.findAll((node: any) => node.props['data-editor'] === 'true')[0];
    expect(String(editor.children.join(''))).toContain('SELECT id FROM users');
  });

  it('opens object edit from the current definition even if a later refresh would fail', async () => {
    backendApp.DBQuery
      .mockResolvedValueOnce({
        success: true,
        data: [{ view_definition: 'SELECT id, name FROM users' }],
      })
      .mockResolvedValueOnce({
        success: false,
        message: 'network down',
        data: [],
      });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(createTab()));
      await flushPromises();
    });

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];

    await act(async () => {
      await button.props.onClick();
      await flushPromises();
    });

    expect(storeState.addTab).toHaveBeenCalledWith(expect.objectContaining({
      id: 'view-def-conn-1-main-reporting.active_users',
      type: 'query',
      queryMode: 'object-edit',
      query: expect.stringContaining('SELECT id, name FROM users;'),
    }));
    expect(String(renderer.root.findAll((node: any) => node.props['data-editor'] === 'true')[0].children.join(''))).toContain('SELECT id, name FROM users');
    expect(findButtonText(renderer.root)).not.toContain('Failed to refresh the latest definition');
    expect(findButtonText(renderer.root)).not.toContain('network down');
  });

  it('does not keep the previous object definition when switching objects and the new load fails', async () => {
    backendApp.DBQuery
      .mockResolvedValueOnce({
        success: true,
        data: [{ view_definition: 'SELECT id, name FROM users' }],
      })
      .mockResolvedValueOnce({
        success: false,
        message: 'load failed',
        data: [],
      });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(createTab()));
      await flushPromises();
    });

    await act(async () => {
      renderer.update(renderWithI18n(createTab({
        id: 'view-def-conn-1-main-reporting.archived_users',
        title: '视图: reporting.archived_users',
        viewName: 'reporting.archived_users',
      })));
      await flushPromises();
    });

    expect(findButtonText(renderer.root)).toContain('Load failed');
    expect(findButtonText(renderer.root)).toContain('load failed');
    expect(renderer.root.findAll((node: any) => node.props['data-editor'] === 'true')).toHaveLength(0);
    expect(findButtonText(renderer.root)).not.toContain('SELECT id, name FROM users');
  });

  it('keeps comment-only fallback definitions editable without reintroducing locale-specific detection', async () => {
    backendApp.DBQuery.mockResolvedValue({
      success: true,
      data: [],
    });

    let renderer: any;
    await act(async () => {
      renderer = create(renderWithI18n(createTab()));
      await flushPromises();
    });

    const button = renderer.root.findAll((node: any) => node.type === 'button' && findButtonText(node).includes('Edit object'))[0];

    await act(async () => {
      await button.props.onClick();
      await flushPromises();
    });

    const query = String(storeState.addTab.mock.calls[0][0].query || '');
    expect(query).toContain('-- Edit View: reporting.active_users');
    expect(query).toContain('-- View definition not found');
    expect(query).not.toContain('CREATE OR REPLACE VIEW reporting.active_users AS');
  });
});
