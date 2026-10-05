import { message } from 'antd';
import { useEffect } from 'react';
import {
    isLocalizedUntitledQueryTitle,
    QUERY_TAB_RENAME_REQUEST_EVENT,
} from '../../../utils/queryTabTitle';
import { t as translate } from '../../../i18n';
import { useStore } from '../../../store';
import {
    clearQueryTabDraft,
    persistQueryTabDraftSnapshot,
    flushQueryTabDraftSnapshots,
} from '../../../utils/sqlFileTabDrafts';
import { WriteSQLFile, ExportSQLFile } from '../../../../wailsjs/go/app/App';
import { isWebRuntime, downloadBrowserTextFile } from '../../../utils/browserFileTransfer';
import { normalizeBrowserSQLExportFileName } from '../queryEditorRunHelpers';
import type { QueryEditorDraftSyncApi } from './useQueryEditorDraftSync';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorQueryContextApi } from './useQueryEditorQueryContext';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorSaveActionsInput {
    tab: QueryEditorProps['tab'];
    getCurrentQuery: QueryEditorDraftSyncApi['getCurrentQuery'];
    lastLocalQueryRef: QueryEditorCoreStateApi['lastLocalQueryRef'];
    savedQueries: QueryEditorConnectionContextApi['savedQueries'];
    currentConnectionId: QueryEditorCoreStateApi['currentConnectionId'];
    currentDb: QueryEditorCoreStateApi['currentDb'];
    runQueuedSaveOperation: QueryEditorDraftSyncApi['runQueuedSaveOperation'];
    saveQuery: QueryEditorConnectionContextApi['saveQuery'];
    queryEditorMountedRef: QueryEditorCoreStateApi['queryEditorMountedRef'];
    currentConnectionIdRef: QueryEditorConnectionContextApi['currentConnectionIdRef'];
    currentDbRef: QueryEditorConnectionContextApi['currentDbRef'];
    addTab: QueryEditorConnectionContextApi['addTab'];
    setQuery: QueryEditorCoreStateApi['setQuery'];
    currentSavedQuery: QueryEditorQueryContextApi['currentSavedQuery'];
    setSaveModalMode: QueryEditorCoreStateApi['setSaveModalMode'];
    saveForm: QueryEditorCoreStateApi['saveForm'];
    setIsSaveModalOpen: QueryEditorCoreStateApi['setIsSaveModalOpen'];
}

export const useQueryEditorSaveActions = ({
    tab, getCurrentQuery, lastLocalQueryRef, savedQueries, currentConnectionId, currentDb,
    runQueuedSaveOperation, saveQuery, queryEditorMountedRef, currentConnectionIdRef, currentDbRef,
    addTab, setQuery, currentSavedQuery, setSaveModalMode, saveForm, setIsSaveModalOpen,
}: UseQueryEditorSaveActionsInput) => {
    const resolveDefaultQueryName = () => {
        const rawTitle = String(tab.title || '').trim();
        if (isLocalizedUntitledQueryTitle(rawTitle)) {
            return translate('query_editor.save_modal.unnamed');
        }
        return rawTitle;
    };

    const persistQuery = async (payload: {
        id: string;
        name: string;
        createdAt?: number;
        openCopyInNewTab?: boolean;
    }): Promise<boolean> => {
        const sql = getCurrentQuery();
        lastLocalQueryRef.current = sql;
        // 重存已存查询时保留其已持久化的参数声明（当前 UI 无默认值编辑入口，
        // payload 不含 parameters——缺省即不覆盖，防止保存动作清空声明）。
        const existingParameters = savedQueries.find((item) => item.id === payload.id)?.parameters;
        const saved = {
            id: payload.id,
            name: payload.name,
            sql,
            connectionId: currentConnectionId,
            dbName: currentDb ?? tab.dbName ?? '',
            createdAt: payload.createdAt ?? Date.now(),
            parameters: existingParameters,
        };
        const persisted = await runQueuedSaveOperation(() => saveQuery(saved));
        if (!queryEditorMountedRef.current) {
            return false;
        }

        const latestSql = getCurrentQuery();
        const latestConnectionId = currentConnectionIdRef.current;
        const latestDbName = currentDbRef.current;
        const latestTab = useStore.getState().tabs?.find((item) => item.id === tab.id) || tab;
        const nextTab = {
            ...latestTab,
            id: payload.openCopyInNewTab ? persisted.id : latestTab.id,
            title: persisted.name,
            query: latestSql,
            connectionId: latestConnectionId,
            dbName: latestDbName,
            savedQueryId: persisted.id,
        };
        addTab(nextTab);
        lastLocalQueryRef.current = latestSql;
        setQuery(latestSql);

        const savedSnapshotStillCurrent = latestSql === String(persisted.sql ?? '')
            && String(latestConnectionId || '').trim() === String(persisted.connectionId || '').trim()
            && String(latestDbName || '').trim() === String(persisted.dbName || '').trim();
        if (payload.openCopyInNewTab) {
            const sourceSnapshotStillCurrent = latestSql === String(currentSavedQuery?.sql ?? '')
                && String(latestConnectionId || '').trim() === String(currentSavedQuery?.connectionId || '').trim()
                && String(latestDbName || '').trim() === String(currentSavedQuery?.dbName || '').trim();
            if (sourceSnapshotStillCurrent) {
                clearQueryTabDraft(latestTab.id);
            } else {
                persistQueryTabDraftSnapshot(latestTab, latestSql, {
                    connectionId: latestConnectionId,
                    dbName: latestDbName,
                });
            }
            if (savedSnapshotStillCurrent) {
                clearQueryTabDraft(nextTab.id);
            } else {
                persistQueryTabDraftSnapshot(nextTab, latestSql, {
                    connectionId: latestConnectionId,
                    dbName: latestDbName,
                });
            }
        } else if (savedSnapshotStillCurrent) {
            clearQueryTabDraft(tab.id);
        } else {
            persistQueryTabDraftSnapshot(nextTab, latestSql, {
                connectionId: latestConnectionId,
                dbName: latestDbName,
            });
        }
        flushQueryTabDraftSnapshots();
        return true;
    };

    const openSaveQueryModal = (mode: 'save' | 'saveAs' | 'rename') => {
        setSaveModalMode(mode);
        saveForm.setFieldsValue({ name: currentSavedQuery?.name || resolveDefaultQueryName() });
        setIsSaveModalOpen(true);
    };

    const handleQuickSave = async () => {
        const filePath = String(tab.filePath || '').trim();
        if (filePath) {
            const sql = getCurrentQuery();
            try {
                const res = await runQueuedSaveOperation(() => WriteSQLFile(filePath, sql));
                if (!queryEditorMountedRef.current) {
                    return;
                }
                if (!res.success) {
                    message.error(translate('query_editor.message.save_sql_file_failed', {
                        error: res.message || translate('common.unknown'),
                    }));
                    return;
                }
                const latestSql = getCurrentQuery();
                const latestConnectionId = currentConnectionIdRef.current;
                const latestDbName = currentDbRef.current;
                const latestTab = useStore.getState().tabs?.find((item) => item.id === tab.id) || tab;
                const nextTab = {
                    ...latestTab,
                    query: latestSql,
                    connectionId: latestConnectionId,
                    dbName: latestDbName,
                    filePath,
                    savedQueryId: undefined,
                };
                addTab(nextTab);
                lastLocalQueryRef.current = latestSql;
                setQuery(latestSql);
                if (latestSql === sql) {
                    clearQueryTabDraft(tab.id);
                } else {
                    persistQueryTabDraftSnapshot(nextTab, latestSql, {
                        connectionId: latestConnectionId,
                        dbName: latestDbName,
                    });
                }
                flushQueryTabDraftSnapshots();
                message.success(translate('query_editor.message.sql_file_saved'));
            } catch (error) {
                message.error(translate('query_editor.message.save_sql_file_failed', {
                    error: error instanceof Error ? error.message : String(error),
                }));
            }
            return;
        }

        const existed = currentSavedQuery || null;
        const fallbackSavedId = String(tab.savedQueryId || '').trim();
        const saveId = existed?.id || fallbackSavedId || '';
        if (!saveId) {
            openSaveQueryModal('save');
            return;
        }
        const saveName = existed?.name || resolveDefaultQueryName();
        if (await persistQuery({ id: saveId, name: saveName, createdAt: existed?.createdAt })) {
            message.success(translate('query_editor.message.saved'));
        }
    };

    const handleRenameQuery = () => {
        const existed = currentSavedQuery || null;
        const fallbackSavedId = String(tab.savedQueryId || '').trim();
        if (!existed && !fallbackSavedId) {
            message.warning(translate('query_editor.message.save_first_before_rename'));
            openSaveQueryModal('save');
            return;
        }
        openSaveQueryModal('rename');
    };

    const handleSaveQueryAs = () => {
        if (!currentSavedQuery || tab.filePath) {
            return;
        }
        openSaveQueryModal('saveAs');
    };

    useEffect(() => {
        const handleRenameQueryRequest = (event: Event) => {
            if (!(event instanceof CustomEvent) || event.detail?.tabId !== tab.id) {
                return;
            }
            handleRenameQuery();
        };

        window.addEventListener(QUERY_TAB_RENAME_REQUEST_EVENT, handleRenameQueryRequest as EventListener);
        return () => {
            window.removeEventListener(QUERY_TAB_RENAME_REQUEST_EVENT, handleRenameQueryRequest as EventListener);
        };
    }, [handleRenameQuery, tab.id]);

    const handleExportSQLFile = async () => {
        try {
            const defaultName = currentSavedQuery?.name || resolveDefaultQueryName();
            const content = getCurrentQuery();
            if (isWebRuntime()) {
                if (!downloadBrowserTextFile(
                    content,
                    normalizeBrowserSQLExportFileName(defaultName),
                    'text/sql;charset=utf-8',
                )) {
                    throw new Error('Browser download is unavailable');
                }
                message.success(translate('query_editor.message.export_sql_file_success'));
                return;
            }
            const res = await ExportSQLFile(defaultName, content);
            if (!res.success) {
                if ((res.message || '') !== '已取消') {
                    message.error(translate('query_editor.message.export_sql_file_failed', {
                        error: res.message || translate('common.unknown'),
                    }));
                }
                return;
            }
            message.success(translate('query_editor.message.export_sql_file_success'));
        } catch (error) {
            const errorDetail = error instanceof Error
                ? error.message || translate('common.unknown')
                : (typeof (error as any)?.message === 'string' && (error as any).message)
                    || (typeof error === 'string' && error)
                    || translate('common.unknown');
            message.error(translate('query_editor.message.export_sql_file_failed', {
                error: errorDetail,
            }));
        }
    };
    return {
        persistQuery, handleQuickSave, handleRenameQuery, handleSaveQueryAs, handleExportSQLFile,
    };
};

export type QueryEditorSaveActionsApi = ReturnType<typeof useQueryEditorSaveActions>;
