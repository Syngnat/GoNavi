import { expect, it } from 'vitest';

import { syncDataGridCellSelectionVisuals } from './dataGridCellHighlight';

const CELL_KEY_SEPARATOR = '\u0001';
const makeCellKey = (rowKey: string, colName: string) => `${rowKey}${CELL_KEY_SEPARATOR}${colName}`;

class TestElement {
  private attributes = new Map<string, string>();
  row: TestElement | null = null;

  constructor(attributes: Record<string, string> = {}) {
    Object.entries(attributes).forEach(([name, value]) => this.attributes.set(name, value));
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  closest(selector: string) {
    return selector === '.ant-table-row' ? this.row : null;
  }
}

it('syncs the active row, column, header and cell without changing the selection set', () => {
  const idHeader = new TestElement({ 'data-col-name': 'id' });
  const nameHeader = new TestElement({ 'data-col-name': 'name' });
  const firstRow = new TestElement();
  const secondRow = new TestElement();
  const firstIdCell = new TestElement({ 'data-row-key': 'row-1', 'data-col-name': 'id' });
  const firstNameCell = new TestElement({ 'data-row-key': 'row-1', 'data-col-name': 'name' });
  const secondIdCell = new TestElement({ 'data-row-key': 'row-2', 'data-col-name': 'id' });
  const secondNameCell = new TestElement({ 'data-row-key': 'row-2', 'data-col-name': 'name' });
  firstIdCell.row = firstRow;
  firstNameCell.row = firstRow;
  secondIdCell.row = secondRow;
  secondNameCell.row = secondRow;

  const bodyCells = [firstIdCell, firstNameCell, secondIdCell, secondNameCell];
  const rows = [firstRow, secondRow];
  const headers = [idHeader, nameHeader];
  const container = {
    querySelectorAll: (selector: string) => {
      if (selector === '.ant-table-row[data-active-cell-row="true"]') {
        return rows.filter((row) => row.getAttribute('data-active-cell-row') === 'true');
      }
      if (selector === '.ant-table-thead .ant-table-cell[data-col-name]') return headers;
      if (selector === '.ant-table-cell[data-row-key][data-col-name]') return bodyCells;
      return [];
    },
  } as unknown as HTMLElement;
  const selection = new Set([makeCellKey('row-2', 'id')]);

  syncDataGridCellSelectionVisuals({
    container,
    selectedCells: selection,
    activeCell: { rowKey: 'row-2', colName: 'id' },
    makeCellKey,
  });

  expect(selection).toEqual(new Set([makeCellKey('row-2', 'id')]));
  expect(secondRow.getAttribute('data-active-cell-row')).toBe('true');
  expect(firstRow.getAttribute('data-active-cell-row')).toBeNull();
  expect(idHeader.getAttribute('data-active-cell-column')).toBe('true');
  expect(nameHeader.getAttribute('data-active-cell-column')).toBeNull();
  expect(firstIdCell.getAttribute('data-active-cell-column')).toBe('true');
  expect(secondIdCell.getAttribute('data-active-cell')).toBe('true');
  expect(secondIdCell.getAttribute('data-cell-selected')).toBe('true');
  expect(secondNameCell.getAttribute('data-active-cell-column')).toBeNull();

  syncDataGridCellSelectionVisuals({
    container,
    selectedCells: new Set(),
    activeCell: null,
    makeCellKey,
  });

  expect(secondRow.getAttribute('data-active-cell-row')).toBeNull();
  expect(idHeader.getAttribute('data-active-cell-column')).toBeNull();
  expect(firstIdCell.getAttribute('data-active-cell-column')).toBeNull();
  expect(secondIdCell.getAttribute('data-active-cell')).toBeNull();
  expect(secondIdCell.getAttribute('data-cell-selected')).toBeNull();
});
