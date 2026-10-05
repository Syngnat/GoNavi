import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useSensors, useSensor, PointerSensor, KeyboardSensor } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type {
    EditableColumn,
    TDengineTagDraft,
    IndexFormState,
    ForeignKeyDisplayRow,
    ForeignKeyFormState,
} from '../tableDesignerTypes';
import { IndexDefinition, ForeignKeyDefinition, TriggerDefinition } from '../../../types';
import { stripIdentifierQuotes, splitQualifiedNameLast } from '../../../utils/qualifiedName';
import {
    type StarRocksTableKind,
    type StarRocksKeyModel,
    type StarRocksDistributionType,
    type TDengineTableKind,
    hasAlterTableDraftChanges,
} from '../../tableDesignerSchemaSql';
import { useStore } from '../../../store';
import { useTableDesignerI18nLanguage } from '../TableDesignerTableParts';
import { resolveDataTableVerticalBorderRule } from '../../../utils/dataGridDisplay';
import {
    isPgLikeDialect as isPgLikeSqlDialect,
    isOracleLikeDialect as isOracleLikeSqlDialect,
    isSqlServerDialect as isSqlServerSqlDialect,
    isMysqlFamilyDialect as isMysqlFamilySqlDialect,
    quoteSqlIdentifierPart,
    quoteSqlIdentifierPath,
    resolveSqlDialect,
} from '../../../utils/sqlDialect';
import {
    resolveTableDesignerEditTarget,
    qualifyTableDesignerCreateName,
    resolveTableDesignerTableInfo,
} from '../../tableDesignerSchemaContext';
import { t } from '../../../i18n';
import { getCharsetOptions, getCollationOptions } from '../tableDesignerTypeOptions';
import { useTableDesignerHeight } from '../../useTableDesignerHeight';
import {
    tableDesignerRowSelector,
    findDesignerColumnNameInput,
} from '../../tableDesignerColumnFocus';
import type { TableDesignerProps } from '../../TableDesigner';
import { isElasticsearchFamilyType } from '../../../utils/elasticsearchFamily';

export interface UseTableDesignerStateInput {
    tab: TableDesignerProps['tab'];
}

export const useTableDesignerState = ({ tab }: UseTableDesignerStateInput) => {
    const isNewTable = !tab.tableName;

    const [columns, setColumns] = useState<EditableColumn[]>([]);
    const [originalColumns, setOriginalColumns] = useState<EditableColumn[]>([]);
    const [indexes, setIndexes] = useState<IndexDefinition[]>([]);
    const [fks, setFks] = useState<ForeignKeyDefinition[]>([]);
    const [triggers, setTriggers] = useState<TriggerDefinition[]>([]);
    const [ddl, setDdl] = useState<string>('');

    // New Table State
    const [newTableName, setNewTableName] = useState('');
    const [schemaOptions, setSchemaOptions] = useState<{ label: string; value: string }[]>([]);
    const [selectedSchema, setSelectedSchema] = useState(() => stripIdentifierQuotes(
        splitQualifiedNameLast(tab.tableName || '').parentPath || tab.schemaName || '',
    ));
    const [schemaSelectionOverride, setSchemaSelectionOverride] = useState(false);
    const [schemaReady, setSchemaReady] = useState(false);
    const [schemaLoading, setSchemaLoading] = useState(false);
    const [charset, setCharset] = useState('utf8mb4');
    const [collation, setCollation] = useState('utf8mb4_unicode_ci');
    const [starRocksTableKind, setStarRocksTableKind] = useState<StarRocksTableKind>('olap');
    const [starRocksKeyModel, setStarRocksKeyModel] = useState<StarRocksKeyModel>('DUPLICATE');
    const [starRocksKeyColumns, setStarRocksKeyColumns] = useState<string[]>([]);
    const [starRocksPartitionClause, setStarRocksPartitionClause] = useState('');
    const [starRocksDistributionType, setStarRocksDistributionType] = useState<StarRocksDistributionType>('HASH');
    const [starRocksDistributionColumns, setStarRocksDistributionColumns] = useState<string[]>([]);
    const [starRocksBucketMode, setStarRocksBucketMode] = useState<'AUTO' | 'NUMBER'>('AUTO');
    const [starRocksBucketCount, setStarRocksBucketCount] = useState('');
    const [starRocksProperties, setStarRocksProperties] = useState('');
    const [starRocksRollups, setStarRocksRollups] = useState('');
    const [starRocksExternalEngine, setStarRocksExternalEngine] = useState('hive');
    const [starRocksExternalProperties, setStarRocksExternalProperties] = useState('"resource" = "hive0"\n"database" = "raw_db"\n"table" = "raw_table"');
    const [tdengineTableKind, setTdengineTableKind] = useState<TDengineTableKind>('normal');
    const [tdengineStableName, setTdengineStableName] = useState('');
    const [tdengineTagDefinitions, setTdengineTagDefinitions] = useState<TDengineTagDraft[]>([
        { _key: 'tag-1', name: 'location', type: 'BINARY(64)' },
    ]);
    const [tdengineTagValues, setTdengineTagValues] = useState('');
    const [tdengineStableOptions, setTdengineStableOptions] = useState<{ label: string; value: string }[]>([]);
    const [tdengineStableOptionsLoading, setTdengineStableOptionsLoading] = useState(false);
    const [tdengineChildTagDefs, setTdengineChildTagDefs] = useState<TDengineTagDraft[]>([]);
    const [tdengineChildTagValues, setTdengineChildTagValues] = useState<Record<string, string>>({});
    const [tdengineChildTagDefsLoading, setTdengineChildTagDefsLoading] = useState(false);

    const [columnsLoading, setColumnsLoading] = useState(false);
    const [indexesLoading, setIndexesLoading] = useState(false);
    const [foreignKeysLoading, setForeignKeysLoading] = useState(false);
    const [triggersLoading, setTriggersLoading] = useState(false);
    const [ddlLoading, setDdlLoading] = useState(false);
    const [previewSql, setPreviewSql] = useState<string>('');
    const [isPreviewOpen, setIsPreviewOpen] = useState(false);
    const [activeKey, setActiveKey] = useState(tab.initialTab || "columns");
    const [selectedColumnRowKeys, setSelectedColumnRowKeys] = useState<string[]>([]);
    const [isCopyColumnsModalOpen, setIsCopyColumnsModalOpen] = useState(false);
    const [tableComment, setTableComment] = useState('');
    const [tableCommentDraft, setTableCommentDraft] = useState('');
    const [isTableCommentModalOpen, setIsTableCommentModalOpen] = useState(false);
    const [tableCommentSaving, setTableCommentSaving] = useState(false);
    const [selectedIndexKeys, setSelectedIndexKeys] = useState<string[]>([]);
    const [isIndexModalOpen, setIsIndexModalOpen] = useState(false);
    const [indexModalMode, setIndexModalMode] = useState<'create' | 'edit'>('create');
    const [indexSaving, setIndexSaving] = useState(false);
    const [indexForm, setIndexForm] = useState<IndexFormState>({
        name: '',
        columnNames: [],
        kind: 'NORMAL',
        indexType: 'DEFAULT',
    });
    const [selectedForeignKey, setSelectedForeignKey] = useState<ForeignKeyDisplayRow | null>(null);
    const [isForeignKeyModalOpen, setIsForeignKeyModalOpen] = useState(false);
    const [foreignKeyModalMode, setForeignKeyModalMode] = useState<'create' | 'edit'>('create');
    const [foreignKeySaving, setForeignKeySaving] = useState(false);
    const [foreignKeyForm, setForeignKeyForm] = useState<ForeignKeyFormState>({
        constraintName: '',
        columnNames: [],
        refTableName: '',
        refColumnNames: [],
    });
    const [selectedTrigger, setSelectedTrigger] = useState<TriggerDefinition | null>(null);
    const [isTriggerModalOpen, setIsTriggerModalOpen] = useState(false);
    const [isTriggerEditModalOpen, setIsTriggerEditModalOpen] = useState(false);
    const [triggerEditMode, setTriggerEditMode] = useState<'create' | 'edit'>('create');
    const [triggerEditSql, setTriggerEditSql] = useState<string>('');
    const [triggerExecuting, setTriggerExecuting] = useState(false);
    const [isCommentModalOpen, setIsCommentModalOpen] = useState(false);
    const [commentEditorColumnKey, setCommentEditorColumnKey] = useState('');
    const [commentEditorColumnName, setCommentEditorColumnName] = useState('');
    const [commentEditorColumnType, setCommentEditorColumnType] = useState('');
    const [commentEditorValue, setCommentEditorValue] = useState('');
    const [columnDefaultEnabled, setColumnDefaultEnabled] = useState(false);
    const [columnDefaultValue, setColumnDefaultValue] = useState('');
    const [columnCharset, setColumnCharset] = useState<string | undefined>();
    const [columnCollation, setColumnCollation] = useState<string | undefined>();

    const connections = useStore(state => state.connections);
    const addTab = useStore(state => state.addTab);
    const setActiveContext = useStore(state => state.setActiveContext);
    const tableDesignerSchemaByConnection = useStore(state => state.tableDesignerSchemaByConnection || {});
    const setTableDesignerSchema = useStore(state => state.setTableDesignerSchema);
    const theme = useStore(state => state.theme);
    const appearance = useStore(state => state.appearance);
    const i18nLanguage = useTableDesignerI18nLanguage();
    const darkMode = theme === 'dark';
    const dataTableVerticalBorderRule = resolveDataTableVerticalBorderRule({
        darkMode,
        visible: appearance.showDataTableVerticalBorders === true,
    });

    const resizeGuideColor = darkMode ? '#f6c453' : '#1890ff';
    const readOnly = !!tab.readOnly;

    const escapeBacktickIdentifier = (name: string) => String(name || '').replace(/`/g, '``');

    const escapeBracketIdentifier = (name: string) => String(name || '').replace(/]/g, ']]');

    const escapeDoubleQuoteIdentifier = (name: string) => String(name || '').replace(/"/g, '""');

    const isPgLikeDialect = (dbType: string): boolean => isPgLikeSqlDialect(dbType);

    const isOracleLikeDialect = (dbType: string): boolean => isOracleLikeSqlDialect(dbType);

    const isSqlServerDialect = (dbType: string): boolean => isSqlServerSqlDialect(dbType);

    const isMysqlLikeDialect = (dbType: string): boolean => isMysqlFamilySqlDialect(dbType);

    const isNonRelationalDialect = (dbType: string): boolean => dbType === 'redis' || dbType === 'mongodb' || isElasticsearchFamilyType(dbType);

    const lacksAlterForeignKeySupport = (dbType: string): boolean => dbType === 'sqlite' || dbType === 'duckdb' || dbType === 'tdengine';

    const quoteIdentifierPartByDialect = (part: string, dbType: string): string => {
        return quoteSqlIdentifierPart(dbType, part);
    };

    const quoteIdentifierPathByDialect = (path: string, dbType: string): string => {
        return quoteSqlIdentifierPath(dbType, path);
    };

    const getDbType = (): string => {
      const conn = connections.find(c => c.id === tab.connectionId);
      const rawType = String(conn?.config?.type || '').trim();
      if (!rawType) return '';
      return resolveSqlDialect(rawType, String(conn?.config?.driver || ''), {
        oceanBaseProtocol: conn?.config?.oceanBaseProtocol,
      });
    };

    const isTDengineNewTable = isNewTable && getDbType() === 'tdengine';

    const resolveTableInfo = () => {
        const dbType = getDbType();
        const resolved = resolveTableDesignerEditTarget({
            dbType,
            dbName: String(tab.dbName || ''),
            tableName: String(tab.tableName || ''),
            selectedSchema,
            schemaSelectionOverride,
        });
        return {
            dbType,
            ...resolved,
            tableRef: quoteIdentifierPathByDialect(resolved.qualifiedName, dbType),
        };
    };

    const resolvePreviewTableInfo = () => {
        if (!isNewTable) return resolveTableInfo();
        const dbType = getDbType();
        const tableName = qualifyTableDesignerCreateName(
            String(newTableName || '').trim() || 'new_table',
            selectedSchema,
            dbType,
        );
        const resolved = resolveTableDesignerTableInfo({
            dbType,
            dbName: String(tab.dbName || ''),
            tableName,
            selectedSchema,
        });
        return {
            dbType,
            ...resolved,
            tableRef: quoteIdentifierPathByDialect(resolved.qualifiedName, dbType),
        };
    };

    const hasUnsavedDraftChanges = useMemo(() => {
        if (isNewTable || readOnly) {
            return false;
        }
        const tableInfo = resolveTableInfo();
        return hasAlterTableDraftChanges({
            dbType: tableInfo.dbType,
            tableName: tableInfo.qualifiedName,
            originalColumns,
            columns,
        });
    }, [columns, connections, isNewTable, originalColumns, readOnly, schemaSelectionOverride, selectedSchema, tab.connectionId, tab.dbName, tab.tableName]);
    const designerTableTitle = isNewTable
        ? (newTableName || t('table_designer.title.untitled_table', undefined, i18nLanguage))
        : (splitQualifiedNameLast(tab.tableName || '').objectName || tab.tableName || t('table_designer.title.untitled_table', undefined, i18nLanguage));
    const designerDbTitle = tab.dbName || t('table_designer.title.default_database', undefined, i18nLanguage);
    const designerSchemaTitle = (
        isNewTable ? stripIdentifierQuotes(splitQualifiedNameLast(newTableName).parentPath) : ''
    ) || selectedSchema || tab.schemaName || '';
    const designerColumnSummary = t('table_designer.summary.columns', { count: columns.length }, i18nLanguage);
    const metadataLoading = columnsLoading || indexesLoading || foreignKeysLoading || triggersLoading || ddlLoading;
    const charsetOptions = useMemo(() => getCharsetOptions(i18nLanguage), [i18nLanguage]);
    const collationOptions = useMemo(() => getCollationOptions(i18nLanguage), [i18nLanguage]);
    const panelRadius = 10;
    const panelFrameColor = 'var(--gn-br-1)';
    const panelToolbarBorder = 'var(--gn-br-1)';
    const panelToolbarBg = 'var(--gn-bg-panel-2)';
    const panelBodyBg = 'var(--gn-bg-panel-2)';
    const focusRowBg = 'var(--gn-bg-selected)';

    const containerRef = useRef<HTMLDivElement>(null);
    const tableHeight = useTableDesignerHeight(containerRef, activeKey);
    const shellRef = useRef<HTMLDivElement>(null);
    const pendingFocusColumnKeyRef = useRef<string | null>(null);
    const focusHighlightTimerRef = useRef<number | null>(null);
    const metadataLoadSeqRef = useRef(0);
    const schemaLoadSeqRef = useRef(0);
    const latestSelectedSchemaRef = useRef(selectedSchema);
    const schemaContextKeyRef = useRef('');
    const [focusColumnKey, setFocusColumnKey] = useState('');

    useEffect(() => {
        latestSelectedSchemaRef.current = selectedSchema;
    }, [selectedSchema]);

    const openCommentEditor = useCallback((record: EditableColumn) => {
        if (!record?._key) return;
        setCommentEditorColumnKey(record._key);
        setCommentEditorColumnName(record.name || '');
        setCommentEditorColumnType(record.type || '');
        setCommentEditorValue(record.comment || '');
        setColumnDefaultEnabled(record.hasDefault === true);
        setColumnDefaultValue(record.default ?? '');
        setColumnCharset(record.charset);
        setColumnCollation(record.collation);
        setIsCommentModalOpen(true);
    }, []);

    const closeCommentEditor = useCallback(() => {
        setIsCommentModalOpen(false);
        setCommentEditorColumnKey('');
        setCommentEditorColumnName('');
        setCommentEditorColumnType('');
        setCommentEditorValue('');
        setColumnDefaultEnabled(false);
        setColumnDefaultValue('');
        setColumnCharset(undefined);
        setColumnCollation(undefined);
    }, []);

    // 透明 Monaco Editor 主题由 MonacoEditor 包装组件按需注册（含 stickyScroll 不透明背景）

    // --- Resizable Columns State ---
    const [tableColumns, setTableColumns] = useState<any[]>([]);
    const [indexColumns, setIndexColumns] = useState<any[]>([]);
    const resizeDragRef = useRef<{ startX: number; startWidth: number; index: number; containerLeft: number; setter: React.Dispatch<React.SetStateAction<any[]>> } | null>(null);
    const resizeRafRef = useRef<number | null>(null);
    const latestResizeXRef = useRef<number | null>(null);
    const ghostRef = useRef<HTMLDivElement>(null);
    const resizeBodyStyleRef = useRef<{ cursor: string; userSelect: string } | null>(null);
    const resizeListenerRef = useRef<{
      blur: (() => void) | null;
      move: ((e: MouseEvent) => void) | null;
      up: ((e: MouseEvent) => void) | null;
    }>({
      blur: null,
      move: null,
      up: null,
    });

    const sensors = useSensors(
      useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
      useSensor(KeyboardSensor, {
        coordinateGetter: sortableKeyboardCoordinates,
      })
    );

    useEffect(() => {
        if (tab.initialTab) {
            setActiveKey(tab.initialTab);
        }
    }, [tab.initialTab]);

    useEffect(() => {
        setSelectedColumnRowKeys(prev => prev.filter(key => columns.some(c => c._key === key)));
    }, [columns]);

    useEffect(() => {
        return () => {
            if (focusHighlightTimerRef.current !== null) {
                window.clearTimeout(focusHighlightTimerRef.current);
            }
        };
    }, []);

    const focusColumnRow = useCallback((targetKey: string): boolean => {
        // TDengine's new-table view embeds the columns table in its tdengine tab.
        if (activeKey !== 'columns' && activeKey !== 'tdengine') return false;
        const tableBody = containerRef.current?.querySelector('.ant-table-body') as HTMLElement | null;
        if (!tableBody) return false;
        const row = tableBody.querySelector(tableDesignerRowSelector(targetKey)) as HTMLTableRowElement | null;
        if (!row) return false;

        const active = document.activeElement;
        if (
            active instanceof HTMLInputElement
            && active.type !== 'checkbox'
            && active.type !== 'radio'
            && row.contains(active)
        ) {
            return true;
        }

        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        setFocusColumnKey(targetKey);
        if (focusHighlightTimerRef.current !== null) {
            window.clearTimeout(focusHighlightTimerRef.current);
        }
        focusHighlightTimerRef.current = window.setTimeout(() => {
            setFocusColumnKey(prev => (prev === targetKey ? '' : prev));
        }, 1600);

        if (!readOnly) {
            const nameInput = findDesignerColumnNameInput(row);
            if (nameInput) {
                nameInput.focus();
                nameInput.select();
            }
        }
        return true;
    }, [activeKey, readOnly]);

    useEffect(() => {
        const pendingKey = pendingFocusColumnKeyRef.current;
        // TDengine's new-table view embeds the columns table in its tdengine tab.
        if (!pendingKey || (activeKey !== 'columns' && activeKey !== 'tdengine')) return;

        let cancelled = false;
        const tryFocus = () => {
            if (cancelled) return;
            if (focusColumnRow(pendingKey)) {
                pendingFocusColumnKeyRef.current = null;
            }
        };

        const timerA = window.setTimeout(tryFocus, 0);
        const timerB = window.setTimeout(tryFocus, 96);
        return () => {
            cancelled = true;
            window.clearTimeout(timerA);
            window.clearTimeout(timerB);
        };
    }, [activeKey, columns, focusColumnRow]);
    return {
        isNewTable, columns, setColumns, originalColumns, setOriginalColumns, indexes, setIndexes,
        fks, setFks, triggers, setTriggers, ddl, setDdl, newTableName, setNewTableName,
        schemaOptions, setSchemaOptions, selectedSchema, setSelectedSchema, schemaSelectionOverride,
        setSchemaSelectionOverride, schemaReady, setSchemaReady, schemaLoading, setSchemaLoading,
        charset, setCharset, collation, setCollation, starRocksTableKind, setStarRocksTableKind,
        starRocksKeyModel, setStarRocksKeyModel, starRocksKeyColumns, setStarRocksKeyColumns,
        starRocksPartitionClause, setStarRocksPartitionClause, starRocksDistributionType,
        setStarRocksDistributionType, starRocksDistributionColumns, setStarRocksDistributionColumns,
        starRocksBucketMode, setStarRocksBucketMode, starRocksBucketCount, setStarRocksBucketCount,
        starRocksProperties, setStarRocksProperties, starRocksRollups, setStarRocksRollups,
        starRocksExternalEngine, setStarRocksExternalEngine, starRocksExternalProperties,
        setStarRocksExternalProperties, tdengineTableKind, setTdengineTableKind, tdengineStableName,
        setTdengineStableName, tdengineTagDefinitions, setTdengineTagDefinitions, tdengineTagValues,
        setTdengineTagValues, tdengineStableOptions, setTdengineStableOptions,
        tdengineStableOptionsLoading, setTdengineStableOptionsLoading, tdengineChildTagDefs,
        setTdengineChildTagDefs, tdengineChildTagValues, setTdengineChildTagValues,
        tdengineChildTagDefsLoading, setTdengineChildTagDefsLoading, columnsLoading,
        setColumnsLoading, indexesLoading, setIndexesLoading, foreignKeysLoading,
        setForeignKeysLoading, triggersLoading, setTriggersLoading, setDdlLoading, previewSql,
        setPreviewSql, isPreviewOpen, setIsPreviewOpen, activeKey, setActiveKey,
        selectedColumnRowKeys, setSelectedColumnRowKeys, isCopyColumnsModalOpen,
        setIsCopyColumnsModalOpen, tableComment, setTableComment, tableCommentDraft,
        setTableCommentDraft, isTableCommentModalOpen, setIsTableCommentModalOpen,
        tableCommentSaving, setTableCommentSaving, selectedIndexKeys, setSelectedIndexKeys,
        isIndexModalOpen, setIsIndexModalOpen, indexModalMode, setIndexModalMode, indexSaving,
        setIndexSaving, indexForm, setIndexForm, selectedForeignKey, setSelectedForeignKey,
        isForeignKeyModalOpen, setIsForeignKeyModalOpen, foreignKeyModalMode,
        setForeignKeyModalMode, foreignKeySaving, setForeignKeySaving, foreignKeyForm,
        setForeignKeyForm, selectedTrigger, setSelectedTrigger, isTriggerModalOpen,
        setIsTriggerModalOpen, isTriggerEditModalOpen, setIsTriggerEditModalOpen, triggerEditMode,
        setTriggerEditMode, triggerEditSql, setTriggerEditSql, triggerExecuting,
        setTriggerExecuting, isCommentModalOpen, commentEditorColumnKey, commentEditorColumnName,
        commentEditorColumnType, commentEditorValue, setCommentEditorValue, columnDefaultEnabled,
        setColumnDefaultEnabled, columnDefaultValue, setColumnDefaultValue, columnCharset,
        setColumnCharset, columnCollation, setColumnCollation, connections, addTab,
        setActiveContext, tableDesignerSchemaByConnection, setTableDesignerSchema, i18nLanguage,
        darkMode, dataTableVerticalBorderRule, resizeGuideColor, readOnly, isPgLikeDialect,
        isOracleLikeDialect, isSqlServerDialect, isMysqlLikeDialect, isNonRelationalDialect,
        lacksAlterForeignKeySupport, quoteIdentifierPartByDialect, quoteIdentifierPathByDialect,
        getDbType, isTDengineNewTable, resolveTableInfo, resolvePreviewTableInfo,
        hasUnsavedDraftChanges, designerTableTitle, designerDbTitle, designerSchemaTitle,
        designerColumnSummary, metadataLoading, charsetOptions, collationOptions, panelRadius,
        panelFrameColor, panelToolbarBorder, panelToolbarBg, panelBodyBg, focusRowBg, containerRef,
        tableHeight, shellRef, pendingFocusColumnKeyRef, metadataLoadSeqRef, schemaLoadSeqRef,
        latestSelectedSchemaRef, schemaContextKeyRef, focusColumnKey, openCommentEditor,
        closeCommentEditor, tableColumns, setTableColumns, indexColumns, setIndexColumns,
        resizeDragRef, resizeRafRef, latestResizeXRef, ghostRef, resizeBodyStyleRef,
        resizeListenerRef, sensors,
    };
};

export type TableDesignerStateApi = ReturnType<typeof useTableDesignerState>;
