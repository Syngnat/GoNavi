import { useCallback } from 'react';
import { GONAVI_ROW_KEY } from '../../DataGridCore';
import type { UseDataGridRowActionsInput } from './useDataGridRowActions';

type AddRowInput = Pick<UseDataGridRowActionsInput,
    'canModifyData' | 'visibleColumnNames' | 'pendingScrollToBottomRef' | 'setAddedRows'
>;

export const useDataGridAddRow = ({
    canModifyData, visibleColumnNames, pendingScrollToBottomRef, setAddedRows,
}: AddRowInput) => useCallback(() => {
    if (!canModifyData) return;
    const newRow: Record<string, unknown> = { [GONAVI_ROW_KEY]: `new-${Date.now()}` };
    visibleColumnNames.forEach(column => { newRow[column] = ''; });
    pendingScrollToBottomRef.current = true;
    setAddedRows(prev => [...prev, newRow]);
}, [canModifyData, pendingScrollToBottomRef, setAddedRows, visibleColumnNames]);
