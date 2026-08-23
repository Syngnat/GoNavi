export interface DataGridActiveCell {
  rowKey: string;
  colName: string;
}

interface SyncDataGridCellSelectionVisualsParams {
  container: HTMLElement;
  selectedCells: Set<string>;
  activeCell: DataGridActiveCell | null;
  makeCellKey: (rowKey: string, colName: string) => string;
}

const syncBooleanDataAttribute = (
  element: HTMLElement,
  name: string,
  enabled: boolean,
) => {
  if (enabled) {
    if (element.getAttribute(name) !== 'true') element.setAttribute(name, 'true');
    return;
  }
  if (element.hasAttribute(name)) element.removeAttribute(name);
};

export const syncDataGridCellSelectionVisuals = ({
  container,
  selectedCells,
  activeCell,
  makeCellKey,
}: SyncDataGridCellSelectionVisualsParams) => {
  const activeCellKey = activeCell
    ? makeCellKey(activeCell.rowKey, activeCell.colName)
    : null;
  const hasActiveCell = !!activeCellKey && selectedCells.has(activeCellKey);

  container
    .querySelectorAll<HTMLElement>('.ant-table-row[data-active-cell-row="true"]')
    .forEach((row) => row.removeAttribute('data-active-cell-row'));

  container
    .querySelectorAll<HTMLElement>('.ant-table-thead .ant-table-cell[data-col-name]')
    .forEach((headerCell) => {
      syncBooleanDataAttribute(
        headerCell,
        'data-active-cell-column',
        hasActiveCell && headerCell.getAttribute('data-col-name') === activeCell?.colName,
      );
    });

  container
    .querySelectorAll<HTMLElement>('.ant-table-cell[data-row-key][data-col-name]')
    .forEach((cell) => {
      const rowKey = cell.getAttribute('data-row-key');
      const colName = cell.getAttribute('data-col-name');
      if (!rowKey || !colName) return;

      const cellKey = makeCellKey(rowKey, colName);
      const isActiveRow = hasActiveCell && rowKey === activeCell?.rowKey;
      const isActiveColumn = hasActiveCell && colName === activeCell?.colName;
      const isActiveCell = isActiveRow && isActiveColumn;

      syncBooleanDataAttribute(cell, 'data-cell-selected', selectedCells.has(cellKey));
      syncBooleanDataAttribute(cell, 'data-active-cell-column', isActiveColumn);
      syncBooleanDataAttribute(cell, 'data-active-cell', isActiveCell);

      if (isActiveRow) {
        const row = cell.closest<HTMLElement>('.ant-table-row');
        if (row) syncBooleanDataAttribute(row, 'data-active-cell-row', true);
      }
    });
};
