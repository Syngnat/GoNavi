import React, { useEffect, useCallback, useMemo } from 'react';
import { Input, AutoComplete, Checkbox, Tooltip, Button, message } from 'antd';
import { EditOutlined, DeleteOutlined } from '@ant-design/icons';
import {
    supportsMySQLUnsignedDialect,
    normalizeMySQLUnsignedColumnType,
    setMySQLUnsignedColumnType,
    supportsMySQLUnsignedColumnType,
    resolveColumnDefaultOptions,
    normalizeColumnDefinition,
    getColumnDefinitionExtra,
} from '../../../utils/columnDefinition';
import { resolveColumnTypeOptions } from '../../../utils/sqlDialect';
import {
    renderDesignerHeaderTitle,
    renderDesignerCellField,
    renderDesignerCellCheck,
} from '../TableDesignerTableParts';
import { t } from '../../../i18n';
import type { EditableColumn } from '../tableDesignerTypes';
import { noAutoCapInputProps } from '../../../utils/inputAutoCap';
import { TableDesignerCommentField } from '../../tableDesignerCommentField';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import {
    supportsTableDesignerSchemaSelection as supportsRequestedTableDesignerSchemaSelection,
} from '../../tableDesignerSchemaContext';
import {
    DBGetColumns,
    DBGetIndexes,
    DBGetForeignKeys,
    DBGetTriggers,
    DBShowCreateTable,
} from '../../../../wailsjs/go/app/App';
import { ColumnDefinition, IndexDefinition } from '../../../types';
import { resolveIndexMetadataResponse } from '../../tableDesignerIndexUtils';
import { parseTableCommentFromDDL } from '../../tableDesignerExecutionSql';
import type { TableDesignerStateApi } from './useTableDesignerState';
import type { TableDesignerProps } from '../../TableDesigner';

export interface UseTableDesignerDataLoadInput {
    tab: TableDesignerProps['tab'];
    getDbType: TableDesignerStateApi['getDbType'];
    i18nLanguage: TableDesignerStateApi['i18nLanguage'];
    readOnly: TableDesignerStateApi['readOnly'];
    handleColumnChange: (key: string, field: keyof EditableColumn, value: any) => void;
    isTDengineNewTable: TableDesignerStateApi['isTDengineNewTable'];
    openCommentEditor: TableDesignerStateApi['openCommentEditor'];
    handleDeleteColumn: (key: string) => void;
    setTableColumns: TableDesignerStateApi['setTableColumns'];
    connections: TableDesignerStateApi['connections'];
    resizeRafRef: TableDesignerStateApi['resizeRafRef'];
    resizeDragRef: TableDesignerStateApi['resizeDragRef'];
    ghostRef: TableDesignerStateApi['ghostRef'];
    latestResizeXRef: TableDesignerStateApi['latestResizeXRef'];
    resizeListenerRef: TableDesignerStateApi['resizeListenerRef'];
    resizeBodyStyleRef: TableDesignerStateApi['resizeBodyStyleRef'];
    shellRef: TableDesignerStateApi['shellRef'];
    tableColumns: TableDesignerStateApi['tableColumns'];
    indexColumns: TableDesignerStateApi['indexColumns'];
    setIndexColumns: TableDesignerStateApi['setIndexColumns'];
    setColumnsLoading: TableDesignerStateApi['setColumnsLoading'];
    setIndexesLoading: TableDesignerStateApi['setIndexesLoading'];
    setForeignKeysLoading: TableDesignerStateApi['setForeignKeysLoading'];
    setTriggersLoading: TableDesignerStateApi['setTriggersLoading'];
    setDdlLoading: TableDesignerStateApi['setDdlLoading'];
    metadataLoadSeqRef: TableDesignerStateApi['metadataLoadSeqRef'];
    isNewTable: TableDesignerStateApi['isNewTable'];
    resolveTableInfo: TableDesignerStateApi['resolveTableInfo'];
    setColumns: TableDesignerStateApi['setColumns'];
    setOriginalColumns: TableDesignerStateApi['setOriginalColumns'];
    setSelectedColumnRowKeys: TableDesignerStateApi['setSelectedColumnRowKeys'];
    setIndexes: TableDesignerStateApi['setIndexes'];
    setFks: TableDesignerStateApi['setFks'];
    setTriggers: TableDesignerStateApi['setTriggers'];
    setDdl: TableDesignerStateApi['setDdl'];
    setTableComment: TableDesignerStateApi['setTableComment'];
    isTableCommentModalOpen: TableDesignerStateApi['isTableCommentModalOpen'];
    setTableCommentDraft: TableDesignerStateApi['setTableCommentDraft'];
    selectedSchema: TableDesignerStateApi['selectedSchema'];
}

export const useTableDesignerDataLoad = ({
    tab, getDbType, i18nLanguage, readOnly, handleColumnChange, isTDengineNewTable,
    openCommentEditor, handleDeleteColumn, setTableColumns, connections, resizeRafRef,
    resizeDragRef, ghostRef, latestResizeXRef, resizeListenerRef, resizeBodyStyleRef, shellRef,
    tableColumns, indexColumns, setIndexColumns, setColumnsLoading, setIndexesLoading,
    setForeignKeysLoading, setTriggersLoading, setDdlLoading, metadataLoadSeqRef, isNewTable,
    resolveTableInfo, setColumns, setOriginalColumns, setSelectedColumnRowKeys, setIndexes, setFks,
    setTriggers, setDdl, setTableComment, isTableCommentModalOpen, setTableCommentDraft,
    selectedSchema,
}: UseTableDesignerDataLoadInput) => {
    useEffect(() => {
        const dbType = getDbType();
        const supportsUnsigned = supportsMySQLUnsignedDialect(dbType);
        const columnTypeOptions = resolveColumnTypeOptions(dbType);
        const initialCols = [
            {
                title: renderDesignerHeaderTitle(t('table_designer.column.name', undefined, i18nLanguage)),
                dataIndex: 'name',
                key: 'name',
                width: 180,
                render: (text: string, record: EditableColumn) => readOnly ? text : (
                    renderDesignerCellField(
                        <Input {...noAutoCapInputProps} value={text} onChange={e => handleColumnChange(record._key, 'name', e.target.value)} variant="borderless" />
                    )
                )
            },
            {
                title: renderDesignerHeaderTitle(t('table_designer.column.type', undefined, i18nLanguage)),
                dataIndex: 'type',
                key: 'type',
                width: 150,
                render: (text: string, record: EditableColumn) => readOnly ? text : (
                    renderDesignerCellField(
                        <AutoComplete options={columnTypeOptions}
                            value={supportsUnsigned ? normalizeMySQLUnsignedColumnType(text).type : text}
                            onChange={val => handleColumnChange(record._key, 'type', supportsUnsigned
                                ? setMySQLUnsignedColumnType(val, normalizeMySQLUnsignedColumnType(text).unsigned || normalizeMySQLUnsignedColumnType(val).unsigned) : val)}
                            style={{ width: '100%' }} variant="borderless" />,
                        'is-compact'
                    )
                )
            },
            ...(supportsUnsigned ? [{
                title: renderDesignerHeaderTitle(t('table_designer.column.unsigned', undefined, i18nLanguage)), dataIndex: 'type', key: 'unsigned', width: 70, align: 'center',
                render: (type: string, record: EditableColumn) => renderDesignerCellCheck(<Checkbox checked={normalizeMySQLUnsignedColumnType(type).unsigned}
                    disabled={readOnly || !supportsMySQLUnsignedColumnType(dbType, type)}
                    onChange={e => handleColumnChange(record._key, 'type', setMySQLUnsignedColumnType(type, e.target.checked))}
                />, 'is-left-aligned'),
            }] : []),
            {
                title: renderDesignerHeaderTitle(t('table_designer.column.primary_key', undefined, i18nLanguage)),
                dataIndex: 'key',
                key: 'key',
                width: 60,
                align: 'center',
                render: (text: string, record: EditableColumn) => (
                    renderDesignerCellCheck(
                        <Checkbox checked={text === 'PRI'} disabled={readOnly || isTDengineNewTable} onChange={e => handleColumnChange(record._key, 'key', e.target.checked ? 'PRI' : '')} />,
                        'is-left-aligned'
                    )
                )
            },
            {
                title: renderDesignerHeaderTitle(t('table_designer.column.auto_increment', undefined, i18nLanguage)),
                dataIndex: 'isAutoIncrement',
                key: 'isAutoIncrement',
                width: 60,
                align: 'center',
                render: (val: boolean, record: EditableColumn) => (
                    renderDesignerCellCheck(
                        <Checkbox checked={val} disabled={readOnly || isTDengineNewTable} onChange={e => handleColumnChange(record._key, 'isAutoIncrement', e.target.checked)} />,
                        'is-left-aligned'
                    )
                )
            },
            {
                title: renderDesignerHeaderTitle(t('table_designer.column.not_null', undefined, i18nLanguage)),
                dataIndex: 'nullable',
                key: 'nullable',
                width: 80,
                align: 'center',
                render: (text: string, record: EditableColumn) => (
                    renderDesignerCellCheck(
                        <Checkbox checked={text === 'NO'} disabled={readOnly || record.key === 'PRI'} onChange={e => handleColumnChange(record._key, 'nullable', e.target.checked ? 'NO' : 'YES')} />,
                        'is-left-aligned'
                    )
                )
            },
            {
                title: renderDesignerHeaderTitle(t('table_designer.column.default', undefined, i18nLanguage)),
                dataIndex: 'default',
                key: 'default',
                width: 180, // Increased default width
                render: (text: string | undefined, record: EditableColumn) => {
                    const value = record.hasDefault
                        ? (text === '' ? "''" : (text ?? ''))
                        : undefined;
                    if (readOnly) return value;
                    return renderDesignerCellField(
                        <AutoComplete
                            options={resolveColumnDefaultOptions(dbType, record.type)}
                            value={value}
                            onChange={val => {
                                const hasDefault = val.length > 0;
                                handleColumnChange(record._key, 'default', hasDefault ? (val === "''" ? '' : val) : undefined);
                                handleColumnChange(record._key, 'hasDefault', hasDefault);
                            }}
                            style={{ width: '100%' }}
                            variant="borderless"
                        />
                    );
                }
            },
            {
                title: renderDesignerHeaderTitle(t('table_designer.column.comment', undefined, i18nLanguage)),
                dataIndex: 'comment',
                key: 'comment',
                width: 200,
                render: (text: string, record: EditableColumn) => (
                    <TableDesignerCommentField
                        text={text}
                        readOnly={readOnly}
                        onChange={(value) => handleColumnChange(record._key, 'comment', value)}
                    />
                )
            },
            ...(readOnly ? [] : [{
                title: renderDesignerHeaderTitle(t('table_designer.column.actions', undefined, i18nLanguage)),
                key: 'action',
                width: 92,
                className: 'table-designer-action-column',
                onHeaderCell: () => ({ className: 'table-designer-action-column' }),
                render: (_: any, record: EditableColumn) => (
                    <div className="table-designer-action-cell">
                        <Tooltip title={t('table_designer.tooltip.edit_column_options', undefined, i18nLanguage)}>
                            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openCommentEditor(record)} />
                        </Tooltip>
                        <Tooltip title={t('table_designer.action.delete', undefined, i18nLanguage)}>
                            <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => handleDeleteColumn(record._key)} />
                        </Tooltip>
                    </div>
                )
            }])
        ];
        setTableColumns(initialCols);
    }, [connections, i18nLanguage, openCommentEditor, readOnly, tab.connectionId]);

    const flushResizeGhost = useCallback(() => {
      resizeRafRef.current = null;
      if (!resizeDragRef.current || !ghostRef.current) return;
      if (latestResizeXRef.current === null) return;
      const relativeLeft = latestResizeXRef.current - resizeDragRef.current.containerLeft;
      ghostRef.current.style.transform = `translateX(${relativeLeft}px)`;
    }, []);

    const detachResizeListeners = useCallback(() => {
      if (resizeListenerRef.current.move) {
        document.removeEventListener('mousemove', resizeListenerRef.current.move);
        resizeListenerRef.current.move = null;
      }
      if (resizeListenerRef.current.up) {
        document.removeEventListener('mouseup', resizeListenerRef.current.up);
        resizeListenerRef.current.up = null;
      }
      if (resizeListenerRef.current.blur) {
        window.removeEventListener('blur', resizeListenerRef.current.blur);
        resizeListenerRef.current.blur = null;
      }
    }, []);

    const cleanupResizeState = useCallback(() => {
      if (resizeRafRef.current !== null) {
        cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
      latestResizeXRef.current = null;
      resizeDragRef.current = null;
      if (ghostRef.current) {
        ghostRef.current.style.display = 'none';
      }
      const previousBodyStyle = resizeBodyStyleRef.current;
      resizeBodyStyleRef.current = null;
      if (previousBodyStyle) {
        document.body.style.cursor = previousBodyStyle.cursor;
        document.body.style.userSelect = previousBodyStyle.userSelect;
      }
    }, []);

    const finishResize = useCallback((clientX?: number, commit = true) => {
      const dragState = resizeDragRef.current;
      const latestResizeX = latestResizeXRef.current;
      detachResizeListeners();
      cleanupResizeState();

      if (commit && dragState) {
        const finalClientX = Number.isFinite(clientX) ? clientX as number : latestResizeX ?? dragState.startX;
        const newWidth = Math.max(50, dragState.startWidth + finalClientX - dragState.startX);
        dragState.setter((prevColumns) => {
          if (!prevColumns[dragState.index]) return prevColumns;
          const nextColumns = [...prevColumns];
          nextColumns[dragState.index] = {
            ...nextColumns[dragState.index],
            width: newWidth,
          };
          return nextColumns;
        });
      }
    }, [cleanupResizeState, detachResizeListeners]);

    const createResizeStartHandler = useCallback((columns: any[], setter: React.Dispatch<React.SetStateAction<any[]>>) => (index: number) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      finishResize(undefined, false);

      const startX = e.clientX;
      const currentWidth = Number(columns[index]?.width || 200);
      const containerLeft = shellRef.current?.getBoundingClientRect().left ?? 0;
      resizeDragRef.current = { startX, startWidth: currentWidth, index, containerLeft, setter };
      latestResizeXRef.current = startX;

      if (ghostRef.current && shellRef.current) {
        const relativeLeft = startX - containerLeft;
        ghostRef.current.style.transform = `translateX(${relativeLeft}px)`;
        ghostRef.current.style.display = 'block';
      }

      const onMove = (event: MouseEvent) => {
        if (!resizeDragRef.current) return;
        latestResizeXRef.current = event.clientX;
        if (event.buttons === 0) {
          finishResize(event.clientX);
          return;
        }
        if (resizeRafRef.current !== null) return;
        resizeRafRef.current = requestAnimationFrame(flushResizeGhost);
      };
      const onUp = (event: MouseEvent) => finishResize(event.clientX);
      const onBlur = () => finishResize();

      resizeListenerRef.current = { blur: onBlur, move: onMove, up: onUp };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      window.addEventListener('blur', onBlur);
      resizeBodyStyleRef.current = {
        cursor: document.body.style.cursor,
        userSelect: document.body.style.userSelect,
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }, [finishResize, flushResizeGhost]);

    const handleResizeStart = useMemo(() => createResizeStartHandler(tableColumns, setTableColumns), [createResizeStartHandler, tableColumns]);
    const handleIndexResizeStart = useMemo(() => createResizeStartHandler(indexColumns, setIndexColumns), [createResizeStartHandler, indexColumns]);

    useEffect(() => {
      return () => {
        finishResize(undefined, false);
      };
    }, [finishResize]);

    const clearMetadataLoading = () => {
      setColumnsLoading(false);
      setIndexesLoading(false);
      setForeignKeysLoading(false);
      setTriggersLoading(false);
      setDdlLoading(false);
    };

    const formatLoadError = (error: unknown): string => {
      if (error instanceof Error) return error.message;
      return String(error || '');
    };

    const fetchData = async () => {
      const requestSeq = metadataLoadSeqRef.current + 1;
      metadataLoadSeqRef.current = requestSeq;
      const isCurrentRequest = () => metadataLoadSeqRef.current === requestSeq;

      if (isNewTable) {
          clearMetadataLoading();
          return;
      }

      const conn = connections.find(c => c.id === tab.connectionId);
      if (!conn) {
          message.error(t('table_designer.message.connection_not_found', undefined, i18nLanguage));
          clearMetadataLoading();
          return;
      }

      const config = {
          ...conn.config,
          port: Number(conn.config.port),
          password: conn.config.password || "",
          database: conn.config.database || "",
          useSSH: conn.config.useSSH || false,
          ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
      };

      const rpcConfig = buildRpcConnectionConfig(config) as any;
        const dbName = tab.dbName || '';
        const tableInfo = resolveTableInfo();
        const resolvedTableName = supportsRequestedTableDesignerSchemaSelection(tableInfo.dbType)
            ? tableInfo.qualifiedName
            : (tab.tableName || '');
        const tableName = resolvedTableName || tab.tableName || '';

        setColumnsLoading(true);
      setIndexesLoading(true);
      setForeignKeysLoading(true);
      setTriggersLoading(true);
      setDdlLoading(true);

      const loadColumns = DBGetColumns(rpcConfig, dbName, tableName)
          .then((colsRes) => {
              if (!isCurrentRequest()) return;
              if (colsRes.success) {
                  const colsWithKey = (colsRes.data as ColumnDefinition[]).map((c, index) => ({
                      ...normalizeColumnDefinition(c),
                      _key: `col-${index}-${Date.now()}`,
                      isAutoIncrement: getColumnDefinitionExtra(c).toLowerCase().includes('auto_increment')
                  }));
                  setColumns(JSON.parse(JSON.stringify(colsWithKey)));
                  setOriginalColumns(JSON.parse(JSON.stringify(colsWithKey)));
                  setSelectedColumnRowKeys([]);
              } else {
                  message.error(t('table_designer.message.load_columns_failed', { detail: colsRes.message }, i18nLanguage));
              }
          })
          .catch((error: unknown) => {
              if (!isCurrentRequest()) return;
              message.error(t('table_designer.message.load_columns_failed', { detail: formatLoadError(error) }, i18nLanguage));
          })
          .finally(() => {
              if (isCurrentRequest()) setColumnsLoading(false);
          });

      await loadColumns;
      if (!isCurrentRequest()) return;

      const loadIndexes = DBGetIndexes(rpcConfig, dbName, tableName)
          .then((idxRes) => {
              if (!isCurrentRequest()) return;
              const result = resolveIndexMetadataResponse<IndexDefinition>(idxRes);
              setIndexes(result.indexes);
              if (result.errorDetail !== null) {
                  message.error(t('table_designer.message.load_indexes_failed', {
                      detail: result.errorDetail || t('table_designer.fallback.unknown_error', undefined, i18nLanguage),
                  }, i18nLanguage));
              }
          })
          .catch((error: unknown) => {
              if (!isCurrentRequest()) return;
              setIndexes([]);
              message.error(t('table_designer.message.load_indexes_failed', {
                  detail: formatLoadError(error) || t('table_designer.fallback.unknown_error', undefined, i18nLanguage),
              }, i18nLanguage));
          })
          .finally(() => {
              if (isCurrentRequest()) setIndexesLoading(false);
          });

      const loadForeignKeys = DBGetForeignKeys(rpcConfig, dbName, tableName)
          .then((fkRes) => {
              if (!isCurrentRequest()) return;
              setFks(fkRes.success && Array.isArray(fkRes.data) ? fkRes.data : []);
          })
          .catch(() => {
              if (isCurrentRequest()) setFks([]);
          })
          .finally(() => {
              if (isCurrentRequest()) setForeignKeysLoading(false);
          });

      const loadTriggers = DBGetTriggers(rpcConfig, dbName, tableName)
          .then((trigRes) => {
              if (!isCurrentRequest()) return;
              setTriggers(trigRes.success && Array.isArray(trigRes.data) ? trigRes.data : []);
          })
          .catch(() => {
              if (isCurrentRequest()) setTriggers([]);
          })
          .finally(() => {
              if (isCurrentRequest()) setTriggersLoading(false);
          });

      const loadDdl = DBShowCreateTable(rpcConfig, dbName, tableName)
          .then((ddlRes) => {
              if (!isCurrentRequest() || !ddlRes.success) return;
              const ddlText = String(ddlRes.data || '');
              setDdl(ddlText);
              const parsedTableComment = parseTableCommentFromDDL(ddlText);
              setTableComment(parsedTableComment);
              if (!isTableCommentModalOpen) {
                  setTableCommentDraft(parsedTableComment);
              }
          })
          .catch(() => undefined)
          .finally(() => {
              if (isCurrentRequest()) setDdlLoading(false);
          });

      await Promise.allSettled([loadIndexes, loadForeignKeys, loadTriggers, loadDdl]);
    };

    useEffect(() => {
      fetchData();
      // Depend on the identity fields fetchData actually reads instead of the whole
      // `tab` object: hosts such as DataGridShell pass an inline literal, so a new
      // object identity on every parent render would otherwise re-run all five
      // metadata RPCs continuously.
    }, [tab.connectionId, tab.dbName, tab.tableName, selectedSchema]);

    // --- Trigger Handlers ---

    const normalizeDbType = (rawType: string): string => {
        const normalized = String(rawType || '').trim().toLowerCase();
        if (normalized === 'postgresql' || normalized === 'pg') return 'postgres';
        if (normalized === 'mssql' || normalized === 'sql_server' || normalized === 'sql-server') return 'sqlserver';
        if (normalized === 'doris') return 'diros';
        if (normalized === 'open_gauss' || normalized === 'open-gauss') return 'opengauss';
        if (normalized === 'gauss_db' || normalized === 'gauss-db') return 'gaussdb';
        return normalized;
    };
    return { handleResizeStart, handleIndexResizeStart, fetchData, normalizeDbType };
};

export type TableDesignerDataLoadApi = ReturnType<typeof useTableDesignerDataLoad>;
