import React from 'react';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QueryEditor from './QueryEditor';
import {
  backendApp,
  dataGridState,
  editorState,
  storeState,
} from './queryEditorResultsAndDropTestState';
import {
  create,
  createTab,
  findButton,
  textContent,
} from './queryEditorResultsAndDropTestHelpers';
import {
  setUpQueryEditorResultsAndDropTest,
  tearDownQueryEditorResultsAndDropTest,
} from './queryEditorResultsAndDropTestHooks';

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

const FLUSH_PROMISES = async () => {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const resultTabLabels = (renderer: ReactTestRenderer) => (
  renderer.root.findAll((node) => node.props?.['data-query-result-tab'] === 'true')
);

const runAtLine = async (
  renderer: ReactTestRenderer,
  lineNumber: number,
  lineText: string,
) => {
  editorState.position = { lineNumber, column: lineText.length + 1 };
  editorState.selection = null;
  await act(async () => {
    const runButton = findButton(renderer, '运行');
    runButton.props.onMouseDown?.({ preventDefault: vi.fn() });
    await runButton.props.onClick();
  });
  await act(FLUSH_PROMISES);
};

describe('QueryEditor result tab retention', () => {
  beforeEach(setUpQueryEditorResultsAndDropTest);
  afterEach(tearDownQueryEditorResultsAndDropTest);

  it('replaces the previous result group by default', async () => {
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['a'], rows: [{ a: 1 }] }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['b'], rows: [{ b: 2 }] }],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        query: 'select 1 as a;\nselect 2 as b;',
      })} />);
    });

    await runAtLine(renderer, 1, 'select 1 as a;');
    expect(resultTabLabels(renderer)).toHaveLength(1);
    expect(textContent(renderer.toJSON())).toContain('结果 1');

    await runAtLine(renderer, 2, 'select 2 as b;');
    expect(resultTabLabels(renderer)).toHaveLength(1);
    expect(dataGridState.latestProps?.data).toEqual([
      expect.objectContaining({ b: 2 }),
    ]);
    expect(textContent(renderer.toJSON())).not.toContain('结果 2');
  });

  it('keeps different SQL result tabs in history mode', async () => {
    storeState.queryOptions = {
      ...storeState.queryOptions,
      resultTabRetention: 'history',
    };
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['a'], rows: [{ a: 1 }] }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['b'], rows: [{ b: 2 }] }],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({
        query: 'select 1 as a;\nselect 2 as b;',
      })} />);
    });

    await runAtLine(renderer, 1, 'select 1 as a;');
    await runAtLine(renderer, 2, 'select 2 as b;');

    expect(resultTabLabels(renderer)).toHaveLength(2);
    expect(textContent(renderer.toJSON())).toContain('结果 1');
    expect(textContent(renderer.toJSON())).toContain('结果 2');
    expect(dataGridState.latestProps?.data).toEqual([
      expect.objectContaining({ b: 2 }),
    ]);
  });

  it('refreshes the same SQL tab instead of duplicating it in history mode', async () => {
    storeState.queryOptions = {
      ...storeState.queryOptions,
      resultTabRetention: 'history',
    };
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['a'], rows: [{ a: 1 }] }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['a'], rows: [{ a: 2 }] }],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'select 1 as a;' })} />);
    });

    await runAtLine(renderer, 1, 'select 1 as a;');
    await runAtLine(renderer, 1, 'select 1 as a;');

    expect(resultTabLabels(renderer)).toHaveLength(1);
    expect(dataGridState.latestProps?.data).toEqual([
      expect.objectContaining({ a: 2 }),
    ]);
  });

  it('keeps a result tab with pending grid changes when replacing by default', async () => {
    backendApp.DBQueryMulti
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['a'], rows: [{ a: 1 }] }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ columns: ['b'], rows: [{ b: 2 }] }],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryEditor tab={createTab({ query: 'select 1 as a;' })} />);
    });

    await runAtLine(renderer, 1, 'select 1 as a;');
    await act(async () => {
      dataGridState.latestProps?.sessionState?.onPendingChangesChange?.(true);
    });

    editorState.value = 'select 2 as b;';
    await runAtLine(renderer, 1, 'select 2 as b;');

    expect(resultTabLabels(renderer)).toHaveLength(2);
    expect(dataGridState.latestProps?.data).toEqual([
      expect.objectContaining({ b: 2 }),
    ]);
  });

});
