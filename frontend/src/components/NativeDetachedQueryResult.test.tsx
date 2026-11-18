// @vitest-environment jsdom

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import NativeDetachedQueryResult from './NativeDetachedQueryResult';
import type { DetachedQueryResultWindow } from '../utils/detachedWindow';

const dataGridProps = vi.hoisted(() => ({ current: null as any }));

vi.mock('../store', () => ({
  useStore: (selector: (state: { theme: string }) => unknown) => selector({ theme: 'light' }),
}));

vi.mock('../i18n/provider', () => ({ useOptionalI18n: () => null }));

vi.mock('./DataGrid', () => ({
  default: (props: any) => {
    dataGridProps.current = props;
    return <div data-native-result-grid="true" />;
  },
}));

describe('NativeDetachedQueryResult', () => {
  it('restores and reports detached result view state', async () => {
    const onStateChange = vi.fn();
    const windowState: DetachedQueryResultWindow = {
      id: 'query-result:query-1:result-1',
      sourceQueryTabId: 'query-1',
      connectionId: 'conn-1',
      dbName: 'main',
      title: 'Result 1',
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      zIndex: 1201,
      result: {
        key: 'result-1',
        sql: 'select id from users',
        rows: [{ id: 1 }],
        columns: ['id'],
        pkColumns: ['id'],
        readOnly: false,
        selectedRowKeys: [1],
        selectedCellKeys: ['0\u0000id'],
        quickWhereCondition: 'id > 0',
        scrollSnapshot: { top: 80, left: 24 },
      },
    };

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <React.Suspense fallback={null}>
          <NativeDetachedQueryResult windowState={windowState} onStateChange={onStateChange} />
        </React.Suspense>,
      );
      await Promise.resolve();
    });

    expect(dataGridProps.current.quickWhereCondition).toBe('id > 0');
    expect(dataGridProps.current.scrollSnapshot).toEqual({ top: 80, left: 24 });
    expect(dataGridProps.current.sessionState.selectedRowKeys).toEqual([1]);
    expect(dataGridProps.current.sessionState.selectedCellKeys).toEqual(['0\u0000id']);

    act(() => {
      dataGridProps.current.onDataChange([{ id: 2 }]);
      dataGridProps.current.sessionState.onSelectedRowKeysChange([2]);
      dataGridProps.current.onApplyQuickWhereCondition('id > 1');
    });
    expect(onStateChange.mock.calls).toEqual([
      [{ rows: [{ id: 2 }] }],
      [{ selectedRowKeys: [2] }],
      [{ quickWhereCondition: 'id > 1' }],
    ]);
    renderer.unmount();
  });

  it('renders a structured statement summary instead of a plain textarea', async () => {
    vi.stubGlobal('ShadowRoot', class ShadowRoot {});
    const onStateChange = vi.fn();
    const windowState: DetachedQueryResultWindow = {
      id: 'query-result:query-1:result-1',
      sourceQueryTabId: 'query-1',
      connectionId: 'conn-1',
      dbName: 'main',
      title: 'Execution summary',
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      zIndex: 1201,
      result: {
        key: 'result-1',
        sql: 'update users set active = 1',
        rows: [],
        columns: [],
        resultType: 'message',
        summaryKind: 'statements',
        summaryStatementCount: 2,
        summaryEntries: [
          {
            statementIndex: 1,
            statement: 'update users set active = 1',
            status: 'success',
            affectedRows: 2,
            rowCountMeaningless: false,
          },
          {
            statementIndex: 2,
            statement: 'update users set active = 2',
            status: 'failed',
            rowCountMeaningless: false,
            error: 'permission denied',
          },
        ],
        pkColumns: [],
        readOnly: true,
      },
    };

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <React.Suspense fallback={null}>
          <NativeDetachedQueryResult windowState={windowState} onStateChange={onStateChange} />
        </React.Suspense>,
      );
      await Promise.resolve();
    });

    expect(renderer.root.findAll((node) =>
      String(node.props?.['data-query-result-statement-summary']) === 'true',
    )).toHaveLength(1);
    expect(renderer.root.findAll((node) => node.type === 'textarea')).toHaveLength(0);
    renderer.unmount();
    vi.unstubAllGlobals();
  });
});
