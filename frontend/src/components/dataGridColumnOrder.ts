import { arrayMove } from '@dnd-kit/sortable';

export const DATA_GRID_COLUMN_ORDER_DRAG_MIME = 'application/x-gonavi-data-grid-column-order';

export type DataGridColumnOrderDragPayload = {
  scope: string;
  columnName: string;
};

export const encodeDataGridColumnOrderDragPayload = (
  payload: DataGridColumnOrderDragPayload,
): string => JSON.stringify(payload);

export const decodeDataGridColumnOrderDragPayload = (
  rawPayload: string,
): DataGridColumnOrderDragPayload | null => {
  try {
    const parsed = JSON.parse(String(rawPayload || ''));
    const scope = String(parsed?.scope || '').trim();
    const columnName = String(parsed?.columnName || '').trim();
    return scope && columnName ? { scope, columnName } : null;
  } catch {
    return null;
  }
};

export const hasDataGridColumnOrderDragPayload = (
  dataTransfer: Pick<DataTransfer, 'types'> | null | undefined,
): boolean => Array.from(dataTransfer?.types || [])
  .some((type) => String(type || '').toLowerCase() === DATA_GRID_COLUMN_ORDER_DRAG_MIME);

// Native HTML drag handles mouse reliably; touch and pen need dnd-kit's PointerSensor.
export const shouldBypassDndKitForNativeColumnHeaderDrag = (pointerType: string): boolean => (
  pointerType === 'mouse'
);

export const moveDataGridColumnInVisibleOrder = (
  allColumnNames: string[],
  hiddenColumnNames: ReadonlySet<string>,
  sourceColumnName: string,
  targetColumnName: string,
): string[] => {
  const source = String(sourceColumnName || '').trim();
  const target = String(targetColumnName || '').trim();
  if (!source || !target || source === target) return allColumnNames;

  const visibleColumnNames = allColumnNames.filter((columnName) => !hiddenColumnNames.has(columnName));
  const sourceIndex = visibleColumnNames.indexOf(source);
  const targetIndex = visibleColumnNames.indexOf(target);
  if (sourceIndex < 0 || targetIndex < 0) return allColumnNames;

  const nextVisibleColumnNames = arrayMove(visibleColumnNames, sourceIndex, targetIndex);
  let visibleIndex = 0;
  return allColumnNames.map((columnName) => (
    hiddenColumnNames.has(columnName) ? columnName : nextVisibleColumnNames[visibleIndex++]
  ));
};
