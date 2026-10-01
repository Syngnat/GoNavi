// @vitest-environment jsdom
import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let columnFixture: Array<Record<string, unknown>> = [];

beforeEach(() => {
  columnFixture = [];
});

beforeAll(() => {
  (window as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (window as any).matchMedia = (window as any).matchMedia || (() => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }));
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

vi.mock('../../wailsjs/go/app/App', () => ({
  DBGetColumns: vi.fn(() => Promise.resolve({ success: true, data: columnFixture })),
  DBGetIndexes: vi.fn(() => Promise.resolve({ success: true, data: [] })),
  DBGetForeignKeys: vi.fn(() => Promise.resolve({ success: true, data: [] })),
  DBGetTriggers: vi.fn(() => Promise.resolve({ success: true, data: [] })),
  DBShowCreateTable: vi.fn(() => Promise.resolve({ success: true, data: '' })),
  DBQuery: vi.fn(() => Promise.resolve({ success: true, data: [] })),
  DBQueryAudited: vi.fn(() => Promise.resolve({ success: true, data: [] })),
}));

vi.mock('./MonacoEditor', () => ({ default: () => null }));

vi.mock('../store', async () => {
  const actual = await vi.importActual<any>('../store');
  const state = {
    connections: [{
      id: 'oracle-1',
      name: 'Oracle',
      config: { type: 'oracle', host: 'oracle.local', port: 1521, user: 'system', database: 'ORCL' },
    }],
    addTab: () => undefined,
    setActiveContext: () => undefined,
    tableDesignerSchemaByConnection: {},
    setTableDesignerSchema: () => undefined,
    theme: 'light',
    appearance: {},
  };
  return { ...actual, useStore: (selector: any) => selector(state) };
});

const flush = async () => {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
};

describe('TableDesigner Oracle comment editing', () => {
  it('keeps filled Oracle comments inline-editable instead of trapping double-click on a tooltip display', async () => {
    const { default: TableDesigner } = await import('./TableDesigner');
    const { Simulate } = await import('react-dom/test-utils');
    columnFixture = [{
      name: 'ID',
      type: 'NUMBER(19)',
      nullable: 'NO',
      key: 'PRI',
      extra: '',
      comment: '明细ID，主键自增',
    }];
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(
        <TableDesigner
          embedded
          tab={{
            id: 'embedded-design-oracle-1-ORCL-EDC_LOG',
            title: 'EDC_LOG',
            type: 'design',
            connectionId: 'oracle-1',
            dbName: 'ORCL',
            tableName: 'EDC_LOG',
            initialTab: 'columns',
            readOnly: false,
            objectType: 'table',
          }}
        />,
      ));
      await flush();

      const commentInput = host.querySelector<HTMLInputElement>('.table-designer-comment-field input');
      expect(commentInput).not.toBeNull();
      expect(commentInput?.value).toBe('明细ID，主键自增');
      expect(host.querySelector('.table-designer-comment-display')).toBeNull();
      expect(host.querySelector('.table-designer-action-cell [aria-label="edit"]')).not.toBeNull();

      await act(async () => {
        commentInput!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      });
      expect(host.querySelector('.table-designer-comment-field input')).not.toBeNull();

      await act(async () => {
        Simulate.change(commentInput!, { target: { value: '订单主键' } } as never);
      });
      expect(host.querySelector<HTMLInputElement>('.table-designer-comment-field input')?.value).toBe('订单主键');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  }, 60000);
});
