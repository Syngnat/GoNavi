import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import QueryEditor from './QueryEditor';
import { backendApp, editorState, storeState } from './queryEditorResultsAndDropTestState';
import { create, createTab, findButton, findEditorAction } from './queryEditorResultsAndDropTestHelpers';
import { setUpQueryEditorResultsAndDropTest, tearDownQueryEditorResultsAndDropTest } from './queryEditorResultsAndDropTestHooks';
import { findSqlStatementRanges } from '../utils/sqlStatementSelection';

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

// Exact RPC payloads are also split by the real Go backend in
// internal/app/sql_split_control_end_test.go, without a database connection.
const procedure = 'CREATE PROCEDURE p()\nBEGIN\n  WHILE x > 0 DO\n    SET x = x - 1;\n  END WHILE;\nEND';
const script = `DROP PROCEDURE IF EXISTS p;\nDELIMITER $$\n${procedure}$$\nDELIMITER ;\nCALL p();`;
const batchRpcSql = `DROP PROCEDURE IF EXISTS p;\n${procedure};\nCALL p()`;

const wireWindowEvents = () => {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  Object.assign(window, {
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      const registered = listeners.get(type) || new Set<EventListenerOrEventListenerObject>();
      registered.add(listener);
      listeners.set(type, registered);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.get(type)?.delete(listener);
    }),
    dispatchEvent: vi.fn((event: Event) => {
      for (const listener of [...(listeners.get(event.type) || [])]) {
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      }
      return true;
    }),
  });
};

const selectSqlText = (text: string) => {
  const start = script.indexOf(text);
  const prefix = script.slice(0, start).split('\n');
  const throughEnd = script.slice(0, start + text.length).split('\n');
  editorState.selection = {
    startLineNumber: prefix.length,
    startColumn: prefix[prefix.length - 1].length + 1,
    endLineNumber: throughEnd.length,
    endColumn: throughEnd[throughEnd.length - 1].length + 1,
  };
};

const modes = ['all', 'cursor', 'script selection', 'body selection'] as const;

describe.each(['mysql', 'mariadb'])('QueryEditor %s DELIMITER execution', (dbType) => {
  beforeEach(() => {
    setUpQueryEditorResultsAndDropTest();
    wireWindowEvents();
    storeState.connections[0].config.type = dbType;
  });
  afterEach(tearDownQueryEditorResultsAndDropTest);

  it.each(modes)('sends complete WHILE statements to the budgeted RPC for %s', async (mode) => {
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: script })} />);
    });
    const isBatch = mode === 'all' || mode === 'script selection';
    const expectedSql = isBatch ? batchRpcSql : procedure;
    if (mode === 'script selection') selectSqlText(script);
    if (mode === 'body selection') selectSqlText(procedure);
    if (mode === 'cursor') editorState.position = { lineNumber: 6, column: 8 };

    await act(async () => {
      if (mode === 'cursor') {
        const run = findButton(renderer!, '运行');
        run.props.onMouseDown?.();
        await run.props.onClick();
      } else {
        const action = findEditorAction(mode === 'all' ? 'gonavi.runAllSql' : 'gonavi.runSelectedSql');
        expect(action).toBeDefined();
        action.run();
      }
      await vi.waitFor(() => expect(backendApp.DBQueryMultiWithOptions).toHaveBeenCalledTimes(1));
    });

    expect(backendApp.DBQueryMultiWithOptions).toHaveBeenCalledWith(
      expect.objectContaining({ type: dbType }), 'main', expectedSql, 'query-1',
      expect.objectContaining({ maxRowsPerResult: -1 }),
    );
    expect(backendApp.DBQueryMulti.mock.calls[0][2]).toBe(expectedSql);
    expect(backendApp.DBQueryMultiTransactionalWithOptions).not.toHaveBeenCalled();
    expect(expectedSql).not.toMatch(/DELIMITER|END WHILE;;/i);
    expect(findSqlStatementRanges(expectedSql, dbType).map((range) => range.text)).toEqual(isBatch
      ? ['DROP PROCEDURE IF EXISTS p', `${procedure};`, 'CALL p()']
      : [procedure]);
  });
});
