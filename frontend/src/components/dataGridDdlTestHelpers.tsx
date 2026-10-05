// DataGrid.ddl.test.tsx 拆分前的共享测试辅助函数；只由测试文件导入。
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect } from 'vitest';
import { GONAVI_ROW_KEY } from './DataGrid';
import { ORACLE_ROWID_LOCATOR_COLUMN } from '../utils/rowLocator';
import { testRenderState } from './dataGridDdlTestState';

export const textContent = (node: any): string =>
  (node.children || [])
    .map((item: any) => (typeof item === 'string' ? item : textContent(item)))
    .join('');

export const findButton = (renderer: ReactTestRenderer, text: string) =>
  renderer.root.findAll((node) => (
    node.type === 'button'
    && (
      textContent(node).includes(text)
      || String(node.props['aria-label'] || '').includes(text)
    )
  ))[0];

export const renderHeaderText = (columnKey: string): string => {
  const column = testRenderState.latestColumns.find((item) => item.key === columnKey);
  expect(column).toBeTruthy();
  const headerRenderer = create(<>{column.title}</>);
  const content = textContent(headerRenderer.root);
  headerRenderer.unmount();
  return content;
};

export const waitForEffects = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

export const createRenderedCellTarget = (rowKey: string, columnName: string) => ({
  closest: (selector: string) => selector === '[data-row-key][data-col-name]'
    ? {
        getAttribute: (name: string) => {
          if (name === 'data-row-key') return rowKey;
          if (name === 'data-col-name') return columnName;
          return null;
        },
      }
    : null,
}) as unknown as HTMLElement;

export const normalizeValue = (_columnName: string, value: any) => value;

export const rowKeyToString = (key: any) => String(key);

export const commitColumnGuard = (columnName: string) => (
  columnName !== GONAVI_ROW_KEY && columnName !== ORACLE_ROWID_LOCATOR_COLUMN
);
