import { readFileSync } from 'node:fs';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readV2ThemeCss } from '../test/readV2ThemeCss';
import { saveQueryEditorResultSession } from '../utils/queryEditorResultSessionCache';
import QueryEditor, { shouldRefreshQueryEditorCompletionColumns } from './QueryEditor';
import QueryEditorResultsPanel, { shouldActivateResultTabDetachPointer } from './QueryEditorResultsPanel';
import QueryEditorToolbar from './QueryEditorToolbar';
import { storeState, backendApp, messageApi, dataGridState, editorState } from './queryEditorResultsAndDropTestState';
import { create, notifyStoreSubscribers, textContent, findButton, findByClassName, createTab } from './queryEditorResultsAndDropTestHelpers';
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

describe('query editor incomplete column metadata', () => {
  it('retries column metadata when the cached fields came from a partial summary', () => {
    expect(shouldRefreshQueryEditorCompletionColumns('column_name', true, true)).toBe(true);
    expect(shouldRefreshQueryEditorCompletionColumns('column_name', true, false)).toBe(false);
    expect(shouldRefreshQueryEditorCompletionColumns('table_name', false, true)).toBe(false);
  });
});

describe('QueryEditor external SQL save', () => {
  beforeEach(setUpQueryEditorResultsAndDropTest);

  afterEach(tearDownQueryEditorResultsAndDropTest);

  it('does not start result-tab detaching from close icons or portal menu items', () => {
    const tabContent = {
      closest: vi.fn(() => null),
    } as unknown as EventTarget;
    const closeIconSvg = {
      closest: vi.fn((selector: string) =>
        selector.includes('.query-result-tab-close') ? { className: 'query-result-tab-close' } : null),
    } as unknown as EventTarget;
    const contextMenuItem = {
      closest: vi.fn((selector: string) =>
        selector.includes('[role="menuitem"]') ? { role: 'menuitem' } : null),
    } as unknown as EventTarget;

    expect(shouldActivateResultTabDetachPointer({ button: 0, target: tabContent })).toBe(true);
    expect(shouldActivateResultTabDetachPointer({ button: 0, target: closeIconSvg })).toBe(false);
    expect(shouldActivateResultTabDetachPointer({ button: 0, target: contextMenuItem })).toBe(false);
    expect(shouldActivateResultTabDetachPointer({ button: 2, target: tabContent })).toBe(false);
  });

  it('closes the active result tab without capturing a close-icon pointer', async () => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const onCloseResult = vi.fn();
    let renderer!: ReactTestRenderer;

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
          sqlLogCount={1}
          darkMode={false}

          currentDb="main"
          currentConnectionId="conn-1"
          toggleShortcutLabel=""
          onActiveResultKeyChange={vi.fn()}
          onHide={vi.fn()}
          onCloseResult={onCloseResult}
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

    const resultTabLabel = renderer.root.findAll((node) =>
      typeof node.props?.onPointerDown === 'function'
      && String(node.props?.className || '').split(/\s+/).includes('query-result-tab-label'),
    )[0];
    const closeButton = findByClassName(renderer, 'query-result-tab-close');
    const closeIconSvg = {
      closest: vi.fn((selector: string) =>
        selector.includes('.query-result-tab-close') ? { className: 'query-result-tab-close' } : null),
    } as unknown as EventTarget;
    const setPointerCapture = vi.fn();

    resultTabLabel.props.onPointerDown({
      button: 0,
      isPrimary: true,
      target: closeIconSvg,
      currentTarget: { setPointerCapture },
    });
    expect(setPointerCapture).not.toHaveBeenCalled();

    const pointerStopPropagation = vi.fn();
    closeButton.props.onPointerDown({ stopPropagation: pointerStopPropagation });
    expect(pointerStopPropagation).toHaveBeenCalledOnce();

    closeButton.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(onCloseResult).toHaveBeenCalledWith('result-1');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('closes non-log result tabs with the middle mouse button and leaves the log tab unchanged', async () => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const onCloseResult = vi.fn();
    let renderer!: ReactTestRenderer;

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
          sqlLogCount={1}
          darkMode={false}

          currentDb="main"
          currentConnectionId="conn-1"
          toggleShortcutLabel=""
          onActiveResultKeyChange={vi.fn()}
          onHide={vi.fn()}
          onCloseResult={onCloseResult}
          onCloseOtherResultTabs={vi.fn()}
          onCloseResultTabsToLeft={vi.fn()}
          onCloseResultTabsToRight={vi.fn()}
          onCloseAllResultTabs={vi.fn()}
          onResultPinnedChange={vi.fn()}
          onReloadResult={vi.fn()}
          onResultPageChange={vi.fn()}
          onResultSort={vi.fn()}
          onDiagnoseExecutionError={vi.fn()}
        />,
      );
    });

    const resultTabLabel = renderer.root.findAll((node) =>
      typeof node.props?.onPointerDown === 'function'
      && String(node.props?.className || '').split(/\s+/).includes('query-result-tab-label'),
    )[0];
    const logTabLabel = renderer.root.findAll((node) =>
      typeof node.props?.onPointerDown !== 'function'
      && String(node.props?.className || '').split(/\s+/).includes('query-result-tab-label'),
    )[0];
    expect(resultTabLabel.props.onMouseDown).toEqual(expect.any(Function));
    expect(resultTabLabel.props.onAuxClick).toEqual(expect.any(Function));
    expect(logTabLabel.props.onMouseDown).toBeUndefined();
    expect(logTabLabel.props.onAuxClick).toBeUndefined();

    const mouseDownEvent = { button: 1, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    resultTabLabel.props.onMouseDown(mouseDownEvent);
    expect(mouseDownEvent.preventDefault).toHaveBeenCalledOnce();
    expect(mouseDownEvent.stopPropagation).toHaveBeenCalledOnce();
    expect(onCloseResult).not.toHaveBeenCalled();

    const auxClickEvent = { button: 1, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    resultTabLabel.props.onAuxClick(auxClickEvent);
    expect(auxClickEvent.preventDefault).toHaveBeenCalledOnce();
    expect(auxClickEvent.stopPropagation).toHaveBeenCalledOnce();
    expect(onCloseResult).toHaveBeenCalledWith('result-1');

    const rightAuxClickEvent = { button: 2, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    resultTabLabel.props.onAuxClick(rightAuxClickEvent);
    expect(rightAuxClickEvent.preventDefault).not.toHaveBeenCalled();
    expect(rightAuxClickEvent.stopPropagation).not.toHaveBeenCalled();
    expect(onCloseResult).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('passes the current keyword case to the format menu selection', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab()} />);
    });

    expect(renderer.root.findByType(QueryEditorToolbar).props.formatSettingsSelectedKeys).toEqual(['upper']);

    await act(async () => {
      storeState.sqlFormatOptions = { keywordCase: 'lower' };
      notifyStoreSubscribers();
    });
    expect(renderer.root.findByType(QueryEditorToolbar).props.formatSettingsSelectedKeys).toEqual(['lower']);
    renderer.unmount();
  });

  it('keeps Oracle anonymous PL/SQL blocks intact when running from the editor', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-oracle-block',
      transactionPending: true,
      data: [{ columns: ['affectedRows'], rows: [{ affectedRows: 1 }] }],
    });
    const plsql = [
      'BEGIN',
      "    INSERT INTO tmp_disable_trigger (table_name) VALUES ('t_memcard_reg');",
      "    UPDATE t_memcard_reg SET CARDLEVEL = 1 WHERE MEMCARDNO = '8032277312';",
      "    DELETE FROM tmp_disable_trigger WHERE table_name = 't_memcard_reg';",
      'END;',
    ].join('\n');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ORCLPDB1', query: plsql })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendApp.DBQueryMultiTransactional).toHaveBeenCalledWith(expect.anything(), 'ORCLPDB1', plsql, 'query-1');
    expect(backendApp.DBQueryMulti).not.toHaveBeenCalled();
    expect(storeState.sqlEditorPendingTransactions['tab-1']).toMatchObject({
      id: 'tx-oracle-block',
      dbType: 'oracle',
      statements: [plsql],
    });
    expect(storeState.addSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      sql: plsql,
      status: 'success',
    }));
    renderer?.unmount();
  });

  it('warns that a write executed without a managed transaction cannot be rolled back', async () => {
    // DDL 在后端 shouldUseManagedSQLTransaction 中不算可托管写操作，
    // 会以 autocommit 直接落地：必须显式告知不可撤销。
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['affectedRows'], rows: [{ affectedRows: 1 }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'DROP TABLE tmp_table;' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(messageApi.warning).toHaveBeenCalledWith(
      expect.stringContaining('无法通过回滚撤销'),
      expect.anything(),
    );
    expect(storeState.sqlEditorPendingTransactions['tab-1']).toBeUndefined();
    renderer?.unmount();
  });

  it('does not warn about rollback for a write inside a managed transaction', async () => {
    backendApp.DBQueryMultiTransactional.mockResolvedValueOnce({
      success: true,
      transactionId: 'tx-managed',
      transactionPending: true,
      data: [{ columns: ['affectedRows'], rows: [{ affectedRows: 1 }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'DELETE FROM users WHERE id = 1;' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(messageApi.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('无法通过回滚撤销'),
      expect.anything(),
    );
    expect(storeState.sqlEditorPendingTransactions['tab-1']).toMatchObject({ id: 'tx-managed' });
    renderer?.unmount();
  });

  it('does not warn about rollback for a pure read', async () => {
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['id'], rows: [{ id: 1 }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'SELECT * FROM users;' })} />);
    });

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(messageApi.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('无法通过回滚撤销'),
      expect.anything(),
    );
    renderer?.unmount();
  });

  it('runs a connection-scoped SQLite query without requiring a database name', async () => {
    storeState.connections[0].config.type = 'sqlite';
    storeState.connections[0].config.database = '';
    const sql = 'SELECT id FROM users';
    editorState.value = sql;
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['id'], rows: [{ id: 1 }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: '', query: sql })} />);
    });
    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sqlite' }),
      '',
      `${sql} LIMIT 5000`,
      'query-1',
    );
    renderer.unmount();
  });

  it('places the Dameng row limit before a trailing WITH UR clause', async () => {
    storeState.connections[0].config.type = 'dameng';
    storeState.connections[0].config.database = 'GXCM';
    storeState.queryOptions.maxRows = 500;
    const sql = [
      'SELECT DISTINCT v.emp_id, v.emp_name, s.stru_order',
      'FROM pub_stru s, pub_emp_view_all v',
      'WHERE s.organ_id = v.emp_id',
      '  AND v.emp_id IN (',
      '    SELECT b.organ_id',
      '    FROM pub_organ_view a, pub_organ_role b',
      "    WHERE locate(',' || a.organ_id || ',', ',' || b.range_ids || ',') > 0",
      '  )',
      'ORDER BY s.stru_order WITH ur;',
    ].join('\n');
    editorState.value = sql;
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['emp_id'], rows: [{ emp_id: '1' }] }],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'GXCM', query: sql })} />);
    });
    await act(async () => {
      await findButton(renderer, '运行').props.onClick();
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(backendApp.DBQueryMulti).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'dameng' }),
      'GXCM',
      sql.replace(' WITH ur;', ' LIMIT 500 OFFSET 0 WITH ur'),
      'query-1',
    );
    renderer.unmount();
  });

  it('executes a long commented Oracle anonymous block without blocking the UI thread', async () => {

    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    const columns = Array.from(
      { length: 42 },
      (_, index) => `                column_${index + 1} VARCHAR2(100) DEFAULT 'value_${index + 1}'`,
    ).join(',\n');
    const sql = [
      '-- ------------------------------------------------------------',
      '-- Long Oracle anonymous setup block',
      '-- ------------------------------------------------------------',
      'DECLARE',
      '    v_cnt NUMBER;',
      'BEGIN',
      '    SELECT COUNT(1) INTO v_cnt',
      '      FROM user_tables',
      "     WHERE table_name = 'GONAVI_REPRO_TABLE';",
      '    IF v_cnt = 0 THEN',
      "        EXECUTE IMMEDIATE '\n            CREATE TABLE gonavi_repro_table (\n" + columns + "\n            )\n        ';",
      '    END IF;',
      'END;',
      '/',
    ].join('\n');
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: Array.from({ length: 52 }, (_, index) => ({
        statementIndex: index + 1,
        columns: ['affectedRows'],
        rows: [{ affectedRows: 0 }],
      })),
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ORCLPDB1', query: sql })} />);
    });

    const runButton = findByClassName(renderer, 'gn-v2-query-toolbar-run-action');
    await act(async () => {
      await runButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    const resultTabs = renderer.root.findAll((node) =>
      node.type === 'button' && String(node.props?.['data-tab-key'] || '').startsWith('result-'),
    );

    expect(backendApp.DBQueryMulti).toHaveBeenCalledOnce();
    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(backendApp.DBGetIndexes).not.toHaveBeenCalled();
    // 52 statements produce more results than the history budget keeps: the
    // oldest unpinned sets are released instead of mounting 52 grids.
    expect(resultTabs).toHaveLength(20);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('bounds restored result sessions before mounting their DataGrids', async () => {
    saveQueryEditorResultSession('tab-1', {
      resultSets: Array.from({ length: 25 }, (_, index) => ({
        key: `result-${index + 1}`,
        sql: `select ${index + 1}`,
        columns: ['value'],
        rows: [{ value: index + 1 }],
        pkColumns: [],
        readOnly: true,
      })),
      activeResultKey: 'result-1',
      isResultPanelVisible: true,
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab()} />);
    });

    const panel = renderer.root.findByType(QueryEditorResultsPanel);
    expect(panel.props.resultSets).toHaveLength(20);
    expect(panel.props.resultSets.map((result: any) => result.key)).toContain('result-1');
    expect(panel.props.activeResultKey).toBe('result-1');
    expect(messageApi.info).toHaveBeenCalledWith(expect.stringContaining('20'));
    renderer.unmount();
  });

  it('runs the whole Oracle procedure when the cursor is in the exception tail', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['affectedRows'], rows: [{ affectedRows: 1 }] }],
    });
    const plsql = [
      '-- 修改函数/存储过程：H2.cproc_tzhssr_order2sale_A1',
      '-- 请确认语法兼容当前数据库后执行',
      'CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1(',
      '  p_sourceid IN VARCHAR2,',
      '  p_msg_out OUT NVARCHAR2',
      ') AS',
      '  v_ecnt NUMBER;',
      '  CURSOR cur_ware IS',
      '    SELECT d.goodsid',
      '    FROM t_order_d d',
      '    ORDER BY CASE',
      "      WHEN d.goodsqty > 0 THEN '1'",
      "      ELSE '2'",
      '    END, d.goodsid;',
      'BEGIN',
      '  FOR row_ware IN cur_ware LOOP',
      '    IF row_ware.goodsid IS NOT NULL THEN',
      '      BEGIN',
      '        SELECT COUNT(*) INTO v_ecnt FROM dual;',
      '      EXCEPTION',
      '        WHEN no_data_found THEN',
      '          v_ecnt := 0;',
      '      END;',
      '    END IF;',
      '  END LOOP;',
      "  p_msg_out := '';",
      'EXCEPTION',
      '  WHEN OTHERS THEN',
      "    p_msg_out := substr('订单核销失败，错误信息：' || SQLERRM || '，错误位置：' ||",
      '                        dbms_utility.format_error_backtrace, 1, 1000);',
      'END cproc_tzhssr_order2sale_A1;',
      '/;',
    ].join('\n');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ORCLPDB1', query: plsql, queryMode: 'object-edit' })} />);
    });

    const tailLine = plsql.split('\n').findIndex((line) => line.includes('p_msg_out := substr')) + 1;
    editorState.position = { lineNumber: tailLine, column: 5 };
    editorState.selection = {
      startLineNumber: tailLine,
      startColumn: 5,
      endLineNumber: tailLine,
      endColumn: 5,
      positionLineNumber: tailLine,
      positionColumn: 5,
    };

    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const executedSql = String(backendApp.DBQueryMulti.mock.calls[0][2]);
    expect(executedSql).toContain('CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1');
    expect(executedSql).toContain('p_msg_out OUT NVARCHAR2');
    expect(executedSql).toContain('p_msg_out := substr');
    expect(executedSql).not.toBe(plsql.split('\n').slice(tailLine - 1).join('\n'));
    expect(executedSql).not.toContain('/;');
    renderer?.unmount();
  });

  it('surfaces Oracle ALL_ERRORS after CREATE OR REPLACE instead of pretending execution succeeded', async () => {
    storeState.connections[0].config.type = 'oracle';
    storeState.connections[0].config.database = 'ORCLPDB1';
    backendApp.DBQueryMulti.mockResolvedValueOnce({
      success: true,
      data: [{ columns: ['affectedRows'], rows: [{ affectedRows: 1 }] }],
    });
    backendApp.DBQuery.mockImplementation(async (_config: unknown, _dbName: string, sql: string) => {
      if (/USER_ERRORS|ALL_ERRORS/i.test(String(sql))) {
        return {
          success: true,
          data: [{
            object_name: 'CPROC_TZHSSR_ORDER2SALE_A1',
            object_type: 'PROCEDURE',
            error_line: 12,
            error_position: 5,
            error_text: "PLS-00201: identifier 'MISSING_TABLE' must be declared",
          }],
        };
      }
      return { success: true, data: [] };
    });
    const plsql = [
      'CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1 AS',
      'BEGIN',
      '  SELECT * FROM missing_table;',
      'END;',
    ].join('\n');

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ dbName: 'ORCLPDB1', query: plsql, queryMode: 'object-edit' })} />);
    });
    await act(async () => {
      await findButton(renderer!, '运行').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const rendered = textContent(renderer!.toJSON());
    expect(backendApp.DBQuery.mock.calls.some((call: unknown[]) => /USER_ERRORS|ALL_ERRORS/i.test(String(call[2])))).toBe(true);
    expect(messageApi.success).not.toHaveBeenCalledWith('执行成功。');
    expect(messageApi.error).toHaveBeenCalled();
    expect(String(messageApi.error.mock.calls[0][0])).toContain('PLS-00201');
    expect(rendered).toContain('PLS-00201');
    expect(rendered).not.toContain('执行成功');
    renderer?.unmount();
  });

  it('uses the query-tab popup structure for result tab context menus', () => {
    const source = readFileSync(new URL('./QueryEditorResultsPanel.tsx', import.meta.url), 'utf8');
    const menuSource = source.slice(
      source.indexOf('function buildResultTabMenuItems'),
      source.indexOf('const resultTabItems'),
    );
    const popupSource = source.slice(
      source.indexOf('const resultTabItems'),
      source.indexOf('children: (() => {', source.indexOf('const resultTabItems')),
    );

    expect(menuSource).not.toContain("type: 'group'");
    expect(menuSource).toContain("type: 'divider'");
    expect(popupSource).toContain('showHeader: false');
  });

  it('keeps query result tabs and count badges compact in v2 UI', () => {
    const source = readFileSync(new URL('./QueryEditorResultsPanel.tsx', import.meta.url), 'utf8');
    const css = readV2ThemeCss();
    const resultNavCss = source.slice(
      source.indexOf('.query-result-tabs .ant-tabs-nav {'),
      source.indexOf('.query-result-tabs .ant-tabs-nav-wrap {'),
    );
    const resultTabCss = source.slice(
      source.indexOf('.query-result-tabs .ant-tabs-tab {'),
      source.indexOf('.query-result-tabs .ant-tabs-tab-btn {'),
    );
    const resultCountCss = source.slice(
      source.indexOf('.query-result-tab-count {'),
      source.indexOf('.query-result-tab-close {'),
    );

    expect(resultNavCss).toContain('min-height: 36px;');
    expect(resultTabCss).toContain('height: 30px !important;');
    expect(resultTabCss).toContain('min-height: 30px;');
    expect(resultCountCss).toContain('height: 17px;');
    expect(resultCountCss).toContain('padding: 0 5px;');
    expect(resultCountCss).toContain('border-radius: 3px;');
    expect(resultCountCss).toContain('font-family: var(--gn-font-mono);');
    expect(resultCountCss).toContain('font-size: 9.5px;');
    expect(resultCountCss).not.toContain('border-radius: 999px;');

    const workbenchResultCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-results .query-result-tabs > .ant-tabs-nav {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-results .query-result-tabs > .ant-tabs-nav .ant-tabs-extra-content {'),
    );
    const workbenchResultTabCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-results .query-result-tabs > .ant-tabs-nav .ant-tabs-tab {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-results .query-result-tabs > .ant-tabs-nav .ant-tabs-nav-wrap,'),
    );
    expect(workbenchResultCss).toContain('min-height: 36px;');
    expect(workbenchResultTabCss).toContain('height: 30px !important;');
    expect(workbenchResultTabCss).toContain('min-height: 30px;');
    expect(workbenchResultTabCss).toContain('margin: 0 !important;');
  });

  it('activates shortcuts only for the visible result grid in the active query editor', async () => {
    const resultSets = [
      {
        key: 'result-1',
        sql: 'select 1 as value',
        rows: [{ value: 1 }],
        columns: ['value'],
        pkColumns: [],
        readOnly: true,
      },
      {
        key: 'result-2',
        sql: 'select 2 as value',
        rows: [{ value: 2 }],
        columns: ['value'],
        pkColumns: [],
        readOnly: true,
      },
    ];
    const renderPanel = (activeResultKey: string, isActive: boolean) => (
      <QueryEditorResultsPanel
        resultSets={resultSets}
        activeResultKey={activeResultKey}
        isActive={isActive}
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
        onReloadResult={vi.fn()}
        onResultPageChange={vi.fn()}
        onResultSort={vi.fn()}
        onDiagnoseExecutionError={vi.fn()}
      />
    );
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(renderPanel('result-1', true));
    });
    expect(dataGridState.latestProps?.data).toEqual([{ value: 1 }]);
    expect(dataGridState.latestProps?.isActive).toBe(true);

    await act(async () => {
      renderer.update(renderPanel('result-1', false));
    });
    expect(dataGridState.latestProps?.isActive).toBe(false);

    await act(async () => {
      renderer.update(renderPanel('result-2', true));
    });
    expect(dataGridState.latestProps?.data).toEqual([{ value: 2 }]);
    expect(dataGridState.latestProps?.isActive).toBe(true);
    // The per-result grid renders in its own memoized module so a result switch
    // can skip untouched grids; the active flag must still be scoped per result.
    expect(readFileSync(new URL('./QueryEditorResultTabContent.tsx', import.meta.url), 'utf8'))
      .toContain('isActive={isResultActive}');
    expect(readFileSync(new URL('./QueryEditorResultsPanel.tsx', import.meta.url), 'utf8'))
      .toContain('isResultActive={isActive && resolvedActiveResultKey === rs.key}');

    renderer.unmount();
  });

  it('keeps the v2 query editor toolbar grouped and compact', () => {
    const source = readFileSync(new URL('./QueryEditor.tsx', import.meta.url), 'utf8');
    const css = readV2ThemeCss();

    expect(css).toContain('body[data-ui-version="v2"] .gn-v2-query-toolbar-selects');
    expect(css).toContain('body[data-ui-version="v2"] .gn-v2-query-toolbar-actions');
    expect(css).toContain('width: 48px !important;');
    expect(css).toContain('flex: 0 0 48px !important;');
    expect(css).toContain('flex: 0 0 auto !important;');
    expect(css).toContain('justify-content: flex-start;');
    expect(css).toContain('height: 32px !important;');
    expect(css).toContain('line-height: 30px !important;');
    expect(css).toContain('display: inline-flex !important;');
    expect(css).toContain('gap: 6px;');
    expect(css).toContain('overflow-x: auto;');
    expect(css).toContain('overflow-y: hidden;');
    expect(css).toContain('body[data-ui-version="v2"] .gn-v2-query-toolbar-action-pair');
    expect(css).toContain('gap: 8px;');
    expect(css).toContain('margin-left: 0 !important;');
    expect(css).toContain('max-width: 760px;');
    expect(css).toContain('width: 140px !important;');
    expect(css).toContain('width: 166px !important;');
    expect(css).toContain('width: 80px !important;');
    expect(css).toContain('width: 34px !important;');
    expect(css).toContain('@media (max-width: 900px)');
    expect(css).not.toContain('body[data-ui-version="v2"] .gn-v2-query-toolbar-transaction-row {');

    const queryToolbarMainCss = css.slice(css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar-main {'), css.indexOf('body[data-ui-version="v2"] .gn-v2-query-toolbar-selects {'));
    expect(queryToolbarMainCss).toContain('flex-wrap: nowrap;');
    expect(queryToolbarMainCss).toContain('width: max-content;');
    expect(queryToolbarMainCss).not.toContain('flex-wrap: wrap;');
    expect(queryToolbarMainCss).not.toContain('margin-left: auto;');
    expect(queryToolbarMainCss).not.toContain('justify-content: flex-end;');
  });
});
