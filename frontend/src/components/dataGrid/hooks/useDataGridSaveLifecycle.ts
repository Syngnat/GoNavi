import { useEffect, useRef, type MutableRefObject } from 'react';
import { flushSync } from 'react-dom';
import { isShortcutMatch } from '../../../utils/shortcuts';
import { registerWorkbenchTabCloseGuard } from '../../../utils/workbenchTabCloseProtection';
import { ensureDataGridSaveSupported } from '../dataGridSaveGuard';
import { getDataGridSaveCapability } from '../dataGridSaveCapability';
import type { UseDataGridCommitInput } from './useDataGridCommit';

type DataGridSaveLifecycleInput = Pick<UseDataGridCommitInput,
    | 'isActive' | 'isTableSurfaceActive' | 'canModifyData' | 'hasChanges'
    | 'activeShortcutPlatform' | 'rootRef' | 'workbenchTabId' | 'currentConnConfig'
    | 'dataPanelDirtyRef' | 'handleDataPanelSave' | 'setDataPanelValue' | 'dataPanelOriginalRef'
    | 'clearAutoCommitTimer' | 'setAddedRows' | 'setModifiedRows' | 'setDeletedRowKeys'
    | 'setModifiedColumns' | 'translateDataGrid' | 'dataEditCommitMode' | 'dataEditAutoCommitDelayMs'
    | 'autoCommitFailedTokenRef' | 'autoCommitChangeTokenRef' | 'setAutoCommitRemainingSeconds'
    | 'autoCommitCountdownRef' | 'autoCommitTimerRef' | 'pendingChangeCount'
> & {
    pendingChangesRef: MutableRefObject<boolean>;
    handleCommit: (source?: 'manual' | 'auto') => Promise<boolean>;
};

const useDataGridSaveShortcut = ({
    isActive, isTableSurfaceActive, hasChanges, canModifyData, currentConnConfig,
    activeShortcutPlatform, rootRef, handleCommit,
}: DataGridSaveLifecycleInput) => {
    const handleCommitRef = useRef(handleCommit);
    handleCommitRef.current = handleCommit;
    useEffect(() => {
        if (!isActive || !isTableSurfaceActive || !hasChanges
            || (!canModifyData && getDataGridSaveCapability(currentConnConfig).supported)) return;
        const handleShortcut = (event: KeyboardEvent) => {
            if (!isShortcutMatch(event, activeShortcutPlatform === 'mac' ? 'Meta+S' : 'Ctrl+S')) return;
            const isInGrid = (target: EventTarget | null): boolean => {
                if (rootRef.current) {
                    return typeof Node !== 'undefined' && target instanceof Node && rootRef.current.contains(target);
                }
                return typeof (target as Element | null)?.closest === 'function'
                    && Boolean((target as Element).closest('.data-grid-root'));
            };
            if (!isInGrid(event.target) && !isInGrid(document.activeElement)) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            void handleCommitRef.current('manual');
        };
        window.addEventListener('keydown', handleShortcut, true);
        return () => window.removeEventListener('keydown', handleShortcut, true);
    }, [activeShortcutPlatform, canModifyData, currentConnConfig, hasChanges, isActive, isTableSurfaceActive, rootRef]);
};

export const useDataGridSaveLifecycle = (input: DataGridSaveLifecycleInput) => {
    const {
        currentConnConfig, translateDataGrid, workbenchTabId, pendingChangesRef, dataPanelDirtyRef,
        handleDataPanelSave, clearAutoCommitTimer, setAddedRows, setModifiedRows, setDeletedRowKeys,
        setModifiedColumns, setDataPanelValue, dataPanelOriginalRef, canModifyData, dataEditCommitMode,
        hasChanges, autoCommitFailedTokenRef, autoCommitChangeTokenRef, dataEditAutoCommitDelayMs,
        setAutoCommitRemainingSeconds, autoCommitCountdownRef, autoCommitTimerRef, pendingChangeCount, handleCommit,
    } = input;
    useDataGridSaveShortcut(input);
    const handleCommitRef = useRef(handleCommit);
    handleCommitRef.current = handleCommit;
    useEffect(() => {
        if (!workbenchTabId) return;
        return registerWorkbenchTabCloseGuard(workbenchTabId, {
            isDirty: () => pendingChangesRef.current || dataPanelDirtyRef.current,
            save: async () => {
                if (currentConnConfig && !ensureDataGridSaveSupported(currentConnConfig, translateDataGrid)) return false;
                if (dataPanelDirtyRef.current) {
                    const applied = flushSync(() => handleDataPanelSave());
                    if (!applied || dataPanelDirtyRef.current) return false;
                }
                return handleCommitRef.current('manual');
            },
            discard: () => {
                pendingChangesRef.current = false;
                clearAutoCommitTimer();
                setAddedRows([]);
                setModifiedRows({});
                setDeletedRowKeys(new Set());
                setModifiedColumns({});
                setDataPanelValue(dataPanelOriginalRef.current);
                dataPanelDirtyRef.current = false;
            },
        });
    }, [clearAutoCommitTimer, currentConnConfig, dataPanelDirtyRef, dataPanelOriginalRef, handleDataPanelSave,
        hasChanges, pendingChangesRef, setAddedRows, setDataPanelValue, setDeletedRowKeys, setModifiedColumns,
        setModifiedRows, translateDataGrid, workbenchTabId]);

    useEffect(() => {
        if (!canModifyData || dataEditCommitMode !== 'auto' || !hasChanges
            || autoCommitFailedTokenRef.current === autoCommitChangeTokenRef.current) {
            clearAutoCommitTimer();
            return;
        }
        const dueAt = Date.now() + dataEditAutoCommitDelayMs;
        const updateRemaining = () => setAutoCommitRemainingSeconds(Math.max(1, Math.ceil((dueAt - Date.now()) / 1000)));
        clearAutoCommitTimer();
        updateRemaining();
        autoCommitCountdownRef.current = setInterval(updateRemaining, 250);
        autoCommitTimerRef.current = setTimeout(() => {
            autoCommitTimerRef.current = null;
            if (autoCommitCountdownRef.current) {
                clearInterval(autoCommitCountdownRef.current);
                autoCommitCountdownRef.current = null;
            }
            setAutoCommitRemainingSeconds(null);
            void handleCommit('auto');
        }, dataEditAutoCommitDelayMs);
        return clearAutoCommitTimer;
    }, [autoCommitChangeTokenRef, autoCommitCountdownRef, autoCommitFailedTokenRef, autoCommitTimerRef,
        canModifyData, clearAutoCommitTimer, dataEditAutoCommitDelayMs, dataEditCommitMode, handleCommit,
        hasChanges, pendingChangeCount, setAutoCommitRemainingSeconds]);
    useEffect(() => clearAutoCommitTimer, [clearAutoCommitTimer]);
};
