import Modal from './common/ResizableDraggableModal';
import { showCountdownDangerConfirm } from './common/countdownDangerConfirm';
import React, { useState, useEffect, useMemo, useCallback, useDeferredValue, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Input, Spin, Empty, Dropdown, message, Tooltip, Button } from 'antd';
import type { MenuProps } from 'antd';
import { TableOutlined, SearchOutlined, ReloadOutlined, SortAscendingOutlined, DatabaseOutlined, ConsoleSqlOutlined, EditOutlined, CopyOutlined, SaveOutlined, DeleteOutlined, ExportOutlined, AppstoreOutlined, UnorderedListOutlined, WarningOutlined, CaretUpFilled, CaretDownFilled } from '@ant-design/icons';
import { buildSidebarTablePinKey, useStore, type TableOverviewViewMode } from '../store';
import { DBGetTables, DBQuery, DBShowCreateTable, DropTable, RenameTable } from '../../wailsjs/go/app/App';
import type { TabData } from '../types';
import { useAutoFetchVisibility } from '../utils/autoFetchVisibility';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { noAutoCapInputProps } from '../utils/inputAutoCap';
import { supportsTableTruncateAction, type TableDataDangerActionKind } from './tableDataDangerActions';
import { resolveTableSelectQuery } from '../utils/objectQueryTemplates';
import {
    TABLE_OVERVIEW_RENDER_BATCH_SIZE,
    buildTableOverviewSearchIndex,
    filterAndSortTableOverviewRows,
    prioritizePinnedTableOverviewRows,
    resolveTableOverviewVisibleRows,
    type TableOverviewSortField,
    type TableOverviewSortOrder,
} from '../utils/tableOverviewFilter';
import { normalizeOceanBaseProtocol } from '../utils/oceanBaseProtocol';
import { isMacLikePlatform } from '../utils/appearance';
import { getShortcutPlatform } from '../utils/shortcuts';
import { t } from '../i18n';
import { buildBatchTableExportWorkbenchTab, buildTableExportTab } from '../utils/tableExportTab';
import { getDataSourceCapabilities } from '../utils/dataSourceCapabilities';
import { extractTableNameFromMetadataRow } from '../utils/tableMetadataRows';
import { V2TableContextMenuView, type V2TableContextMenuActionKey } from './V2TableContextMenu';
import { confirmCopyTable } from './tableCopyAction';
import { APP_POPUP_Z_INDEX } from '../utils/overlayZIndex';
import { formatSidebarTableTimestamp } from './sidebar/sidebarHelpers';
import { confirmProductionMutation } from '../utils/productionRiskConfirm';

interface TableOverviewProps {
    tab: TabData;
}

interface TableStatRow {
    name: string;
    comment: string;
    rows: number;
    dataSize: number;
    indexSize: number;
    engine: string;
    createTime: string;
    updateTime: string;
}

type SortField = TableOverviewSortField;
type SortOrder = TableOverviewSortOrder;
type ViewMode = TableOverviewViewMode;
type OverviewContextMenuState = {
    tableName: string;
    x: number;
    y: number;
    sourceX: number;
    sourceY: number;
    maxHeight: number;
};
type OverviewTableSection = {
    key: string;
    kind: 'pinned' | 'all';
    rows: TableStatRow[];
};

const OVERVIEW_CONTEXT_MENU_SAFE_GAP = 8;
const OVERVIEW_CONTEXT_MENU_WIDTH = 264;
const OVERVIEW_CONTEXT_MENU_FALLBACK_HEIGHT = 420;

const resolveOverviewContextMenuPosition = (
    x: number,
    y: number,
    options?: {
        width?: number;
        height?: number;
        viewportWidth?: number;
        viewportHeight?: number;
        safeGap?: number;
    },
): { x: number; y: number; maxHeight: number } => {
    const safeGap = options?.safeGap ?? OVERVIEW_CONTEXT_MENU_SAFE_GAP;
    const viewportWidth = options?.viewportWidth ?? (typeof window === 'undefined' ? 1024 : window.innerWidth);
    const viewportHeight = options?.viewportHeight ?? (typeof window === 'undefined' ? 768 : window.innerHeight);
    const width = Math.max(0, options?.width ?? OVERVIEW_CONTEXT_MENU_WIDTH);
    const height = Math.max(0, options?.height ?? OVERVIEW_CONTEXT_MENU_FALLBACK_HEIGHT);
    const maxX = Math.max(safeGap, viewportWidth - width - safeGap);
    const maxY = Math.max(safeGap, viewportHeight - height - safeGap);
    const nextX = Math.max(safeGap, Math.min(x, maxX));
    const nextY = Math.max(safeGap, Math.min(y, maxY));
    return {
        x: nextX,
        y: nextY,
        maxHeight: Math.max(120, viewportHeight - nextY - safeGap),
    };
};

const formatSize = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const formatRows = (count: number): string => {
    if (count === undefined || count === null || !Number.isFinite(count) || count < 0) return '—';
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
    return String(count);
};

const isOverviewTablePinned = (
    pinnedKeys: string[],
    connectionId: string | undefined,
    dbName: string | undefined,
    schemaName: string | undefined,
    tableName: string,
): boolean => {
    const key = buildSidebarTablePinKey(connectionId || '', dbName || '', tableName, schemaName || '');
    return !!key && pinnedKeys.includes(key);
};

const getMetadataDialect = (connType: string, driver?: string, oceanBaseProtocol?: string): string => {
    const type = (connType || '').trim().toLowerCase();
    if (type === 'custom') {
        const d = (driver || '').trim().toLowerCase();
        if (d === 'diros' || d === 'doris') return 'mysql';
        if (d === 'goldendb' || d === 'greatdb' || d === 'gdb') return 'mysql';
        if (d === 'oceanbase') return normalizeOceanBaseProtocol(oceanBaseProtocol) === 'oracle' ? 'oracle' : 'mysql';
        if (d === 'opengauss' || d === 'open_gauss' || d === 'open-gauss') return 'opengauss';
        if (d === 'gaussdb' || d === 'gauss_db' || d === 'gauss-db') return 'gaussdb';
        return d;
    }
    if (type === 'oceanbase' && normalizeOceanBaseProtocol(oceanBaseProtocol) === 'oracle') return 'oracle';
    if (type === 'goldendb' || type === 'mariadb' || type === 'oceanbase' || type === 'diros' || type === 'sphinx') return 'mysql';
    if (type === 'dameng') return 'dm';
    return type;
};

const buildTableStatusSQL = (dialect: string, dbName: string, schemaName?: string): string => {
        const escapeLiteral = (s: string) => s.replace(/'/g, "''");
        const iotdbDevicePattern = (name: string) => {
            const normalized = String(name || '').trim().replace(/[`"]/g, '');
            if (!normalized) return '';
            return normalized.endsWith('.**') ? normalized : `${normalized}.**`;
        };
        switch (dialect) {
        case 'mysql':
        case 'starrocks':
            return `
SELECT
    TABLE_NAME AS table_name,
    TABLE_COMMENT AS table_comment,
    TABLE_ROWS AS table_rows,
    DATA_LENGTH AS data_length,
    INDEX_LENGTH AS index_length,
    ENGINE AS engine,
    CREATE_TIME AS create_time,
    UPDATE_TIME AS update_time
FROM information_schema.tables
WHERE table_schema = '${escapeLiteral(dbName)}'
  AND table_type = 'BASE TABLE'
ORDER BY table_name`;
        case 'postgres':
        case 'kingbase':
        case 'vastbase':
        case 'highgo':
        case 'opengauss':
        case 'gaussdb': {
            const schema = schemaName || 'public';
            return `
SELECT
    n.nspname || '.' || c.relname AS table_name,
    obj_description(c.oid, 'pg_class') AS table_comment,
    c.reltuples::bigint AS table_rows,
    pg_total_relation_size(c.oid) AS data_length,
    pg_indexes_size(c.oid) AS index_length
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname = '${escapeLiteral(schema)}'
ORDER BY c.relname`;
        }
        case 'sqlserver': {
            const safeDB = `[${dbName.replace(/]/g, ']]')}]`;
            return `
SELECT
    s.name + '.' + t.name AS table_name,
    ep.value AS table_comment,
    SUM(p.rows) AS table_rows,
    SUM(a.total_pages) * 8 * 1024 AS data_length,
    SUM(a.used_pages) * 8 * 1024 AS index_length
FROM ${safeDB}.sys.tables t
JOIN ${safeDB}.sys.schemas s ON t.schema_id = s.schema_id
LEFT JOIN ${safeDB}.sys.extended_properties ep ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
LEFT JOIN ${safeDB}.sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)
LEFT JOIN ${safeDB}.sys.allocation_units a ON p.partition_id = a.container_id
WHERE t.type = 'U'
GROUP BY s.name, t.name, ep.value
ORDER BY s.name, t.name`;
        }
        case 'clickhouse':
            return `SELECT name AS table_name, comment AS table_comment, total_rows AS table_rows, total_bytes AS data_length, 0 AS index_length FROM system.tables WHERE database = '${escapeLiteral(dbName)}' AND engine NOT IN ('View', 'MaterializedView') ORDER BY name`;
        case 'tdengine':
            return `SHOW TABLES FROM \`${dbName.replace(/`/g, '``')}\``;
        case 'iotdb': {
            const pattern = iotdbDevicePattern(dbName);
            return pattern ? `SHOW DEVICES ${pattern}` : 'SHOW DEVICES';
        }
        case 'dm':
        case 'oracle': {
            const owner = (schemaName || dbName).toUpperCase();
            return `SELECT table_name, comments AS table_comment, num_rows AS table_rows, NULL AS data_length, NULL AS index_length FROM all_tab_comments JOIN all_tables USING (table_name, owner) WHERE owner = '${escapeLiteral(owner)}' ORDER BY table_name`;
        }
        default:
            return `SELECT table_name, '' AS table_comment, 0 AS table_rows, NULL AS data_length, NULL AS index_length FROM information_schema.tables WHERE table_schema = '${escapeLiteral(dbName)}' AND table_type = 'BASE TABLE' ORDER BY table_name`;
    }
};

const parseTableStats = (dialect: string, rows: Record<string, any>[]): TableStatRow[] => {
    return rows.map((row) => {
        const get = (keys: string[]): any => {
            for (const k of keys) {
                for (const rk of Object.keys(row)) {
                    if (rk.toLowerCase() === k.toLowerCase() && row[rk] !== null && row[rk] !== undefined) return row[rk];
                }
            }
            return undefined;
        };
        const strVal = (keys: string[]) => String(get(keys) ?? '').trim();
        const numVal = (keys: string[], missingValue = 0) => {
            const v = get(keys);
            if (v === null || v === undefined || v === '') return missingValue;
            const n = Number(v);
            return isNaN(n) ? missingValue : Math.max(0, Math.round(n));
        };

        return {
            name: extractTableNameFromMetadataRow(row) || strVal(['Device', 'device']),
            comment: strVal(['Comment', 'table_comment', 'TABLE_COMMENT', 'comments']),
            rows: numVal(['Rows', 'table_rows', 'TABLE_ROWS', 'num_rows', 'reltuples', 'total_rows'], -1),
            dataSize: numVal(['Data_length', 'data_length', 'DATA_LENGTH', 'total_bytes'], -1),
            indexSize: numVal(['Index_length', 'index_length', 'INDEX_LENGTH'], -1),
            engine: strVal(['Engine', 'engine']),
            createTime: strVal(['Create_time', 'create_time']),
            updateTime: strVal(['Update_time', 'update_time']),
        };
    }).filter(t => t.name);
};

const TableOverview: React.FC<TableOverviewProps> = ({ tab }) => {
    const connections = useStore(state => state.connections);
    const theme = useStore(state => state.theme);
    const appearance = useStore(state => state.appearance);
    const addTab = useStore(state => state.addTab);
    const setActiveContext = useStore(state => state.setActiveContext);
    const setAIPanelVisible = useStore(state => state.setAIPanelVisible);
    const addAIContext = useStore(state => state.addAIContext);
    const pinnedSidebarTables = useStore(state => state.pinnedSidebarTables);
    const setSidebarTablePinned = useStore(state => state.setSidebarTablePinned);
    const queryOptions = useStore(state => state.queryOptions);
    const setQueryOptions = useStore(state => state.setQueryOptions);
    const darkMode = theme === 'dark';
    const isV2Ui = appearance.uiVersion === 'v2';
    const tableDoubleClickAction = appearance.tableDoubleClickAction === 'open-design' ? 'open-design' : 'open-data';
    const activeShortcutPlatform = getShortcutPlatform(isMacLikePlatform());

    const [tables, setTables] = useState<TableStatRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchText, setSearchText] = useState('');
    const [sortField, setSortField] = useState<SortField>('name');
    const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
    const viewMode: ViewMode = queryOptions.tableOverviewViewMode || (isV2Ui ? 'card' : 'list');
    const setViewMode = useCallback((nextViewMode: ViewMode) => {
        setQueryOptions({ tableOverviewViewMode: nextViewMode });
    }, [setQueryOptions]);
    const [v2ContextMenu, setV2ContextMenu] = useState<OverviewContextMenuState | null>(null);
    const v2ContextMenuPortalRef = useRef<HTMLDivElement | null>(null);
    const [visibleTableLimit, setVisibleTableLimit] = useState(TABLE_OVERVIEW_RENDER_BATCH_SIZE);
    const deferredSearchText = useDeferredValue(searchText);
    const isSearchPending = searchText !== deferredSearchText;

    const connection = useMemo(() => connections.find(c => c.id === tab.connectionId), [connections, tab.connectionId]);
    const metadataDialect = useMemo(
        () => getMetadataDialect(connection?.config?.type || '', connection?.config?.driver, connection?.config?.oceanBaseProtocol),
        [connection?.config?.driver, connection?.config?.oceanBaseProtocol, connection?.config?.type]
    );
    const schemaName = String((tab as any).schemaName || '').trim();
    const supportsDesignWrite = !getDataSourceCapabilities(connection?.config).forceReadOnlyStructureDesigner;
    const supportsCopyTable = getDataSourceCapabilities(connection?.config).supportsCopyTable;
    const autoFetchVisible = useAutoFetchVisibility();
    const loadDataRequestIdRef = useRef(0);

    const loadData = useCallback(async () => {
        const requestId = loadDataRequestIdRef.current + 1;
        loadDataRequestIdRef.current = requestId;
        const isLatestRequest = () => loadDataRequestIdRef.current === requestId;
        if (!connection) {
            setLoading(false);
            return;
        }
        setLoading(true);
        try {
            const config = {
                ...connection.config,
                port: Number(connection.config.port),
                password: connection.config.password || '',
                database: connection.config.database || '',
                useSSH: connection.config.useSSH || false,
                ssh: connection.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
            };
            if (
                metadataDialect === 'tdengine' ||
                metadataDialect === 'sqlite' ||
                metadataDialect === 'sqlite3' ||
                metadataDialect === 'milvus' ||
                metadataDialect === 'milvusdb' ||
                metadataDialect === 'milvus-db'
            ) {
                const res = await DBGetTables(buildRpcConnectionConfig(config) as any, tab.dbName || '');
                if (!isLatestRequest()) return;
                if (res.success && Array.isArray(res.data)) {
                    setTables(parseTableStats(metadataDialect, res.data));
                } else {
                    message.error(t('table_overview.message.load_tables_failed', {
                        detail: res.message || t('table_overview.message.unknown_error'),
                    }));
                }
                return;
            }
            const sql = buildTableStatusSQL(metadataDialect, tab.dbName || '', schemaName);
            const res = await DBQuery(buildRpcConnectionConfig(config) as any, tab.dbName || '', sql);
            if (!isLatestRequest()) return;
            if (res.success && Array.isArray(res.data)) {
                setTables(parseTableStats(metadataDialect, res.data));
            } else {
                message.error(t('table_overview.message.load_tables_failed', {
                    detail: res.message || t('table_overview.message.unknown_error'),
                }));
            }
        } catch (e: any) {
            if (!isLatestRequest()) return;
            message.error(t('table_overview.message.load_tables_failed', {
                detail: e?.message || String(e),
            }));
        } finally {
            if (isLatestRequest()) {
                setLoading(false);
            }
        }
    }, [connection, metadataDialect, schemaName, t, tab.dbName]);

    useEffect(() => {
        if (!autoFetchVisible) {
            return;
        }
        void loadData();
    }, [autoFetchVisible, loadData]);

    const tableSearchIndex = useMemo(() => buildTableOverviewSearchIndex(tables), [tables]);

    const sortedFiltered = useMemo(() => (
        filterAndSortTableOverviewRows(tableSearchIndex, deferredSearchText, sortField, sortOrder)
    ), [deferredSearchText, sortField, sortOrder, tableSearchIndex]);

    const pinnedOverview = useMemo(() => (
        prioritizePinnedTableOverviewRows(
            sortedFiltered,
            (table) => isOverviewTablePinned(pinnedSidebarTables, connection?.id, tab.dbName, schemaName, table.name),
        )
    ), [connection?.id, pinnedSidebarTables, schemaName, sortedFiltered, tab.dbName]);

    useEffect(() => {
        setVisibleTableLimit(TABLE_OVERVIEW_RENDER_BATCH_SIZE);
    }, [deferredSearchText, sortField, sortOrder, viewMode, tables, pinnedSidebarTables]);

    const visibleOverview = useMemo(() => (
        resolveTableOverviewVisibleRows(pinnedOverview.orderedRows, visibleTableLimit)
    ), [pinnedOverview.orderedRows, visibleTableLimit]);

    const visibleTables = visibleOverview.visibleRows;

    const visibleTableSections = useMemo<OverviewTableSection[]>(() => {
        if (pinnedOverview.pinnedRows.length === 0) {
            return [{ key: 'all', kind: 'all', rows: visibleTables }];
        }
        const visiblePinnedNames = new Set(
            visibleTables
                .filter((table) => isOverviewTablePinned(pinnedSidebarTables, connection?.id, tab.dbName, schemaName, table.name))
                .map((table) => table.name),
        );
        const pinnedRows = pinnedOverview.pinnedRows.filter((table) => visiblePinnedNames.has(table.name));
        const regularRows = visibleTables.filter((table) => !visiblePinnedNames.has(table.name));
        return [
            ...(pinnedRows.length > 0 ? [{ key: 'pinned', kind: 'pinned' as const, rows: pinnedRows }] : []),
            ...(regularRows.length > 0 ? [{ key: 'all', kind: 'all' as const, rows: regularRows }] : []),
        ];
    }, [connection?.id, pinnedOverview.pinnedRows, pinnedSidebarTables, schemaName, tab.dbName, visibleTables]);

    const v2ContextMenuTable = useMemo(
        () => (v2ContextMenu ? tables.find(table => table.name === v2ContextMenu.tableName) || null : null),
        [tables, v2ContextMenu],
    );

    const openV2OverviewContextMenu = useCallback((event: React.MouseEvent, table: TableStatRow) => {
        if (!isV2Ui) return;
        event.preventDefault();
        event.stopPropagation();
        const position = resolveOverviewContextMenuPosition(event.clientX, event.clientY);
        setV2ContextMenu({
            tableName: table.name,
            x: position.x,
            y: position.y,
            sourceX: event.clientX,
            sourceY: event.clientY,
            maxHeight: position.maxHeight,
        });
    }, [isV2Ui]);

    useEffect(() => {
        if (!v2ContextMenu) return;
        const onPointerDown = (event: MouseEvent) => {
            const target = event.target instanceof Node ? event.target : null;
            if (target && v2ContextMenuPortalRef.current?.contains(target)) return;
            setV2ContextMenu(null);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            setV2ContextMenu(null);
        };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [v2ContextMenu]);

    useEffect(() => {
        if (!v2ContextMenu) return;
        const frame = requestAnimationFrame(() => {
            const portal = v2ContextMenuPortalRef.current;
            if (!portal) return;
            const rect = portal.getBoundingClientRect();
            const content = portal.querySelector('.gn-v2-table-context-menu') as HTMLElement | null;
            const measuredHeight = Math.max(rect.height, content?.scrollHeight || 0);
            const position = resolveOverviewContextMenuPosition(v2ContextMenu.sourceX, v2ContextMenu.sourceY, {
                width: rect.width || OVERVIEW_CONTEXT_MENU_WIDTH,
                height: measuredHeight || OVERVIEW_CONTEXT_MENU_FALLBACK_HEIGHT,
            });
            setV2ContextMenu(prev => {
                if (!prev) return prev;
                if (prev.x === position.x && prev.y === position.y && prev.maxHeight === position.maxHeight) return prev;
                return { ...prev, x: position.x, y: position.y, maxHeight: position.maxHeight };
            });
        });
        return () => cancelAnimationFrame(frame);
    }, [v2ContextMenu]);

    const openTable = useCallback((tableName: string) => {
        if (!connection) return;
        setActiveContext({ connectionId: connection.id, dbName: tab.dbName || '' });
        addTab({
            id: `${connection.id}-${tab.dbName}-${tableName}`,
            title: tableName,
            type: 'table',
            connectionId: connection.id,
            dbName: tab.dbName,
            tableName,
            objectType: 'table',
        });
    }, [connection, tab.dbName, addTab, setActiveContext]);

    const openDesign = useCallback((tableName: string) => {
        if (!connection) return;
        setActiveContext({ connectionId: connection.id, dbName: tab.dbName || '' });
        const structureOnly = !supportsDesignWrite;
        addTab({
            id: `design-${connection.id}-${tab.dbName}-${tableName}`,
            title: t(
                structureOnly ? 'table_overview.tab.table_structure_title' : 'table_overview.tab.design_table_title',
                { table: tableName },
            ),
            type: 'design',
            connectionId: connection.id,
            dbName: tab.dbName,
            tableName,
            initialTab: 'columns',
            readOnly: structureOnly,
        });
    }, [connection, tab.dbName, addTab, setActiveContext, supportsDesignWrite, t]);

    const openTableObjectDesigner = useCallback((tableName: string) => {
        if (!connection) return;
        setActiveContext({ connectionId: connection.id, dbName: tab.dbName || '' });
        addTab({
            id: `${connection.id}-${tab.dbName}-${tableName}`,
            title: tableName,
            type: 'table',
            connectionId: connection.id,
            dbName: tab.dbName,
            tableName,
            initialViewMode: 'fields',
            initialViewModeRequestId: String(Date.now()),
            objectType: 'table',
        });
    }, [connection, tab.dbName, addTab, setActiveContext]);

    const openTableByDefaultAction = useCallback((tableName: string) => {
        if (tableDoubleClickAction === 'open-design') {
            openTableObjectDesigner(tableName);
            return;
        }
        openTable(tableName);
    }, [openTable, openTableObjectDesigner, tableDoubleClickAction]);

    const openTableDdl = useCallback((tableName: string) => {
        if (!connection) return;
        setActiveContext({ connectionId: connection.id, dbName: tab.dbName || '' });
        addTab({
            id: `design-${connection.id}-${tab.dbName}-${tableName}`,
            title: t('table_overview.tab.table_structure_title', { table: tableName }),
            type: 'design',
            connectionId: connection.id,
            dbName: tab.dbName,
            tableName,
            initialTab: 'ddl',
            readOnly: true,
        });
    }, [connection, tab.dbName, addTab, setActiveContext, t]);

    const openQueryForTable = useCallback((tableName: string) => {
        if (!connection) return;
        void (async () => {
            setActiveContext({ connectionId: connection.id, dbName: tab.dbName || '' });
            const queryTemplate = await resolveTableSelectQuery({
                dbType: metadataDialect,
                tableName,
                dbName: String(tab.dbName || ''),
                connectionConfig: connection.config,
            });
            addTab({
                id: `query-${Date.now()}`,
                title: t('table_overview.menu.new_query'),
                type: 'query',
                connectionId: connection.id,
                dbName: tab.dbName,
                query: queryTemplate,
            });
        })();
    }, [addTab, connection, metadataDialect, setActiveContext, t, tab.dbName]);

    const openTableInER = useCallback((tableName: string) => {
        if (!connection) return;
        openTable(tableName);
        setTimeout(() => {
            window.dispatchEvent(new CustomEvent('gonavi:data-grid:set-view-mode', {
                detail: {
                    connectionId: connection.id,
                    dbName: tab.dbName,
                    tableName,
                    viewMode: 'er',
                },
            }));
        }, 0);
    }, [connection, openTable, tab.dbName]);

    const buildConfig = useCallback(() => {
        if (!connection) return null;
        return {
            ...connection.config,
            port: Number(connection.config.port),
            password: connection.config.password || '',
            database: connection.config.database || '',
            useSSH: connection.config.useSSH || false,
            ssh: connection.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
        };
    }, [connection]);

    const handleCopyStructure = useCallback(async (tableName: string) => {
        const config = buildConfig();
        if (!config) return;
        const res = await DBShowCreateTable(buildRpcConnectionConfig(config) as any, tab.dbName || '', tableName);
        if (res.success) {
            navigator.clipboard.writeText(res.data as string);
            message.success(t('table_overview.message.copy_structure_success'));
        } else {
            message.error(t('table_overview.message.copy_structure_failed', {
                detail: res.message || t('table_overview.message.unknown_error'),
            }));
        }
    }, [buildConfig, t, tab.dbName]);

    const handleCopyTableName = useCallback(async (tableName: string) => {
        const name = String(tableName || '').trim();
        if (!name) {
            message.warning(t('table_overview.message.copy_table_name_empty'));
            return;
        }
        try {
            await navigator.clipboard.writeText(name);
            message.success(t('table_overview.message.copy_table_name_success'));
        } catch (e: any) {
            message.error(t('table_overview.message.copy_table_name_failed', {
                detail: e?.message || String(e),
            }));
        }
    }, [t]);

    const handleCopyTable = useCallback(async (tableName: string) => {
        if (!supportsCopyTable) {
            message.warning(t('table_copy.message.unsupported'));
            return;
        }
        const config = buildConfig();
        if (!config) return;
        if (!await confirmProductionMutation(
            connection,
            t('connection.production_risk.action.execute_sql'),
            [tab.dbName, tableName].filter(Boolean).join(' / '),
            t,
        )) return;
        confirmCopyTable({
            config: buildRpcConnectionConfig(config) as any,
            dbName: tab.dbName || '',
            sourceSchemaName: schemaName,
            sourceTableName: tableName,
            onSuccess: async () => {
                await loadData();
            },
        });
    }, [buildConfig, connection, loadData, schemaName, supportsCopyTable, t, tab.dbName]);

    const openTableSQLExportWorkbench = useCallback(async (tableName: string, mode: 'backup' | 'dataOnly') => {
        const normalizedTableName = String(tableName || '').trim();
        if (!normalizedTableName) return;
        const launchKey = `table-overview-${mode}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        addTab(buildBatchTableExportWorkbenchTab({
            connectionId: tab.connectionId,
            dbName: tab.dbName,
            initialObjectNames: [normalizedTableName],
            contentMode: mode,
            includeDropIfExists: false,
            ...(mode === 'backup' ? { launchKey } : { requestKey: launchKey }),
            title: t('file.backend.dialog.export_table', { table: normalizedTableName }),
        }));
    }, [addTab, tab.connectionId, tab.dbName]);

    const openExportDialog = useCallback(async (tableName: string, totalRows?: number) => {
        addTab(buildTableExportTab({
            connectionId: tab.connectionId,
            dbName: tab.dbName,
            tableName,
            title: t('file.backend.dialog.export_table', { table: tableName }),
            objectType: 'table',
            rowCountByScope: Number.isFinite(Number(totalRows)) && Number(totalRows) > 0
                ? { all: Math.trunc(Number(totalRows)) }
                : undefined,
        }));
    }, [addTab, tab.connectionId, tab.dbName]);

    const handleCopyTableAsInsert = useCallback(async (tableName: string) => {
        await openTableSQLExportWorkbench(tableName, 'dataOnly');
    }, [openTableSQLExportWorkbench]);

    const handleDeleteTable = useCallback((tableName: string) => {
        const config = buildConfig();
        if (!config) return;
        showCountdownDangerConfirm({
            title: t('table_overview.modal.delete_table.title'),
            content: t('table_overview.modal.delete_table.content', { table: tableName }),
            onOk: async () => {
                if (!await confirmProductionMutation(
                    connection,
                    t('connection.production_risk.action.execute_sql'),
                    [tab.dbName, tableName].filter(Boolean).join(' / '),
                    t,
                )) return;
                const res = await DropTable(buildRpcConnectionConfig(config) as any, tab.dbName || '', tableName);
                if (res.success) {
                    await loadData();
                    message.success(t('table_overview.message.delete_table_success'));
                } else {
                    message.error(t('table_overview.message.delete_table_failed', { detail: res.message }));
                }
            },
        });
    }, [buildConfig, connection, loadData, t, tab.dbName]);

    const handleTableDataDangerAction = useCallback((tableName: string, action: TableDataDangerActionKind) => {
        const config = buildConfig();
        if (!config) return;

        const actionLabel = t(`table_overview.table_data_action.${action}.label`);
        Modal.confirm({
            title: t('table_overview.modal.table_data_action.title', { action: actionLabel }),
            content: t('table_overview.modal.table_data_action.content', {
                action: actionLabel,
                table: tableName,
            }),
            okText: t('common.continue'),
            cancelText: t('common.cancel'),
            okButtonProps: { danger: true },
            onOk: async () => {
                if (!await confirmProductionMutation(
                    connection,
                    t('connection.production_risk.action.execute_sql'),
                    [tab.dbName, tableName].filter(Boolean).join(' / '),
                    t,
                )) return;
                const app = (window as any).go.app.App;
                const methodName = action === 'truncate' ? 'TruncateTables' : 'ClearTables';
                const hide = message.loading(t('table_overview.message.table_data_action_loading', {
                    action: actionLabel,
                    table: tableName,
                }), 0);
                try {
                    const res = await app[methodName](buildRpcConnectionConfig(config) as any, tab.dbName || '', [tableName]);
                    hide();
                    if (res.success) {
                        await loadData();
                        message.success(t('table_overview.message.table_data_action_success', { action: actionLabel }));
                    } else {
                        message.error(t('table_overview.message.table_data_action_failed', { action: actionLabel, detail: res.message }));
                        return Promise.reject();
                    }
                } catch (e: any) {
                    hide();
                    message.error(t('table_overview.message.table_data_action_failed', {
                        action: actionLabel,
                        detail: e?.message || String(e),
                    }));
                    return Promise.reject();
                }
            },
        });
    }, [buildConfig, connection, loadData, t, tab.dbName]);

    const toggleOverviewTablePinned = useCallback((tableName: string, pinned?: boolean) => {
        if (!connection?.id || !tab.dbName || !tableName) return;
        const currentlyPinned = isOverviewTablePinned(
            pinnedSidebarTables,
            connection.id,
            tab.dbName,
            schemaName,
            tableName,
        );
        const shouldPin = pinned ?? !currentlyPinned;
        setSidebarTablePinned(connection.id, tab.dbName, tableName, schemaName, shouldPin);
        window.dispatchEvent(new CustomEvent('gonavi:sidebar-table-pin-changed', {
            detail: {
                connectionId: connection.id,
                dbName: tab.dbName,
            },
        }));
        message.success(shouldPin ? t('table_overview.message.pinned') : t('table_overview.message.unpinned'));
    }, [connection?.id, pinnedSidebarTables, schemaName, setSidebarTablePinned, t, tab.dbName]);

    const handleRenameTable = useCallback((tableName: string) => {
        const config = buildConfig();
        if (!config) return;
        let newName = tableName;
        Modal.confirm({
            title: t('table_overview.modal.rename_table.title'),
            content: (
                <Input
                    {...noAutoCapInputProps}
                    defaultValue={tableName}
                    onChange={e => { newName = e.target.value; }}
                    placeholder={t('table_overview.modal.rename_table.placeholder')}
                    autoFocus
                    style={{ marginTop: 8 }}
                />
            ),
            onOk: async () => {
                const trimmed = newName.trim();
                if (!trimmed) { message.error(t('table_overview.validation.table_name_required')); return Promise.reject(); }
                if (trimmed === tableName) { message.warning(t('table_overview.validation.table_name_unchanged')); return; }
                if (!await confirmProductionMutation(
                    connection,
                    t('connection.production_risk.action.execute_sql'),
                    [tab.dbName, `${tableName} -> ${trimmed}`].filter(Boolean).join(' / '),
                    t,
                )) return;
                const res = await RenameTable(buildRpcConnectionConfig(config) as any, tab.dbName || '', tableName, trimmed);
                if (res.success) {
                    await loadData();
                    message.success(t('table_overview.message.rename_table_success'));
                } else {
                    message.error(t('table_overview.message.rename_table_failed', { detail: res.message }));
                }
            },
        });
    }, [buildConfig, connection, loadData, t, tab.dbName]);

    const openCreateStarRocksRollup = useCallback((tableName: string) => {
        if (!connection) return;
        const safeTable = String(tableName || 'table_name').trim();
        const quotedTable = safeTable.includes('`') ? safeTable : safeTable.split('.').map(part => `\`${part.replace(/`/g, '``')}\``).join('.');
        addTab({
            id: `query-create-starrocks-rollup-${Date.now()}`,
            title: t('sidebar.v2_table_menu.new_rollup', { keyword: 'Rollup' }),
            type: 'query',
            connectionId: connection.id,
            dbName: tab.dbName,
            query: `ALTER TABLE ${quotedTable}\nADD ROLLUP rollup_name (column1, column2);`,
        });
    }, [addTab, connection, t, tab.dbName]);

    const injectTablePromptToAI = useCallback(async (tableName: string, promptKind: 'explain' | 'query') => {
        const dbName = tab.dbName || '';
        if (!connection?.id || !dbName || !tableName) {
            message.warning(t('sidebar.message.ai_table_context_missing'));
            return;
        }
        const tableRef = `${dbName}.${tableName}`;

        let ddl = '';
        const config = buildConfig();
        if (config) {
            try {
                const res = await DBShowCreateTable(buildRpcConnectionConfig(config) as any, dbName, tableName);
                if (res.success) {
                    ddl = String(res.data || '').trim();
                    addAIContext(connection.id, { dbName, tableName, ddl });
                }
            } catch {
                // AI 入口仍可基于表名工作，DDL 获取失败不阻断打开面板。
            }
        }

        const prompt = promptKind === 'explain'
            ? [
                t('sidebar.ai_prompt.explain.intro', { table: tableRef }),
                t('sidebar.ai_prompt.explain.detail'),
                ddl ? `\n\`\`\`sql\n${ddl}\n\`\`\`` : '',
            ].filter(Boolean).join('\n')
            : [
                t('sidebar.ai_prompt.query.intro', { table: tableRef }),
                t('sidebar.ai_prompt.query.detail'),
                ddl ? `\n\`\`\`sql\n${ddl}\n\`\`\`` : '',
            ].filter(Boolean).join('\n');

        const wasClosed = !useStore.getState().aiPanelVisible;
        if (wasClosed) setAIPanelVisible(true);
        setTimeout(() => {
            window.dispatchEvent(new CustomEvent('gonavi:ai:inject-prompt', { detail: { prompt } }));
        }, wasClosed ? 350 : 0);
    }, [addAIContext, buildConfig, connection?.id, setAIPanelVisible, tab.dbName]);

    // --- Theme ---
    // v2 背景/边框/强调色交给 CSS token（跟自定义主题）；legacy 仍用 darkMode 近似色。
    const cardBg = isV2Ui ? undefined : (darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)');
    const cardHoverBg = darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)';
    const cardBorder = isV2Ui ? undefined : (darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)');
    const textPrimary = isV2Ui ? 'var(--gn-fg-1)' : (darkMode ? 'rgba(255,255,255,0.88)' : 'rgba(0,0,0,0.88)');
    const textSecondary = isV2Ui ? 'var(--gn-fg-3)' : (darkMode ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)');
    const textMuted = isV2Ui ? 'var(--gn-fg-4)' : (darkMode ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)');
    const accentColor = isV2Ui ? 'var(--gn-accent)' : '#1677ff';
    const containerBg = isV2Ui ? undefined : (darkMode ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.01)');

    const toggleSort = (field: SortField) => {
        if (sortField === field) {
            setSortOrder(o => o === 'asc' ? 'desc' : 'asc');
        } else {
            setSortField(field);
            setSortOrder(field === 'name' || field === 'comment' || field === 'engine' ? 'asc' : 'desc');
        }
    };

    const getSortMenuLabel = (field: SortField, labelKey: string) => {
        const suffix = sortField === field ? (sortOrder === 'asc' ? ' ↑' : ' ↓') : '';
        return `${t(labelKey)}${suffix}`;
    };

    const sortMenuItems = [
        { key: 'name', label: getSortMenuLabel('name', 'table_overview.sort.name'), onClick: () => toggleSort('name') },
        { key: 'comment', label: getSortMenuLabel('comment', 'table_overview.metric.comment'), onClick: () => toggleSort('comment') },
        { key: 'rows', label: getSortMenuLabel('rows', 'table_overview.sort.rows'), onClick: () => toggleSort('rows') },
        { key: 'dataSize', label: getSortMenuLabel('dataSize', 'table_overview.sort.size'), onClick: () => toggleSort('dataSize') },
        { key: 'indexSize', label: getSortMenuLabel('indexSize', 'table_overview.metric.index_size'), onClick: () => toggleSort('indexSize') },
        { key: 'engine', label: getSortMenuLabel('engine', 'table_overview.metric.engine'), onClick: () => toggleSort('engine') },
        { key: 'updateTime', label: getSortMenuLabel('updateTime', 'table_overview.metric.updated_at'), onClick: () => toggleSort('updateTime') },
        { key: 'createTime', label: getSortMenuLabel('createTime', 'table_overview.metric.created_at'), onClick: () => toggleSort('createTime') },
    ];

    const hasKnownTableSize = useCallback((table: TableStatRow) => table.dataSize >= 0 || table.indexSize >= 0, []);
    const getCombinedTableSize = useCallback((table: TableStatRow) => (
        Math.max(0, table.dataSize) + Math.max(0, table.indexSize)
    ), []);
    const totalRows = useMemo(() => {
        const knownRows = tables.filter(table => table.rows >= 0);
        return knownRows.length > 0 ? knownRows.reduce((sum, table) => sum + table.rows, 0) : -1;
    }, [tables]);
    const totalSize = useMemo(() => {
        const knownSizes = tables.filter(hasKnownTableSize);
        return knownSizes.length > 0 ? knownSizes.reduce((sum, table) => sum + getCombinedTableSize(table), 0) : -1;
    }, [getCombinedTableSize, hasKnownTableSize, tables]);
    const maxCombinedSize = useMemo(() => sortedFiltered.reduce((max, table) => {
        return Math.max(max, getCombinedTableSize(table));
    }, 0), [getCombinedTableSize, sortedFiltered]);
    const allowTruncate = supportsTableTruncateAction(connection?.config?.type || '', connection?.config?.driver);

    const renderToolbarSummary = () => {
        const countToken = '__COUNT__';
        const rowsToken = '__ROWS__';
        const sizeToken = '__SIZE__';
        const template = t('table_overview.toolbar.summary', {
            count: countToken,
            rows: rowsToken,
            size: sizeToken,
        });
        const parts = template.split(/(__COUNT__|__ROWS__|__SIZE__)/g);

        return parts.map((part, index) => {
            if (part === countToken) {
                return <strong key={`count-${index}`}>{tables.length}</strong>;
            }
            if (part === rowsToken) {
                return <strong key={`rows-${index}`}>{formatRows(totalRows)}</strong>;
            }
            if (part === sizeToken) {
                return <strong key={`size-${index}`}>{formatSize(totalSize)}</strong>;
            }
            return <React.Fragment key={`text-${index}`}>{part}</React.Fragment>;
        });
    };

    const handleV2TableContextMenuAction = useCallback((table: TableStatRow, action: V2TableContextMenuActionKey) => {
        const tableName = table.name;
        switch (action) {
            case 'open-data':
            case 'open-new-tab':
                openTable(tableName);
                return;
            case 'pin-table':
                toggleOverviewTablePinned(tableName, true);
                return;
            case 'unpin-table':
                toggleOverviewTablePinned(tableName, false);
                return;
            case 'design-table':
                openDesign(tableName);
                return;
            case 'new-query':
                openQueryForTable(tableName);
                return;
            case 'view-ddl':
                openTableDdl(tableName);
                return;
            case 'view-er':
                openTableInER(tableName);
                return;
            case 'copy-table-name':
                void handleCopyTableName(tableName);
                return;
            case 'copy-structure':
                void handleCopyStructure(tableName);
                return;
            case 'copy-table':
                handleCopyTable(tableName);
                return;
            case 'copy-insert':
                void handleCopyTableAsInsert(tableName);
                return;
            case 'rename-table':
                handleRenameTable(tableName);
                return;
            case 'new-rollup':
                openCreateStarRocksRollup(tableName);
                return;
            case 'backup-table':
                void openTableSQLExportWorkbench(tableName, 'backup');
                return;
            case 'refresh-stats':
                void loadData();
                return;
            case 'export-data':
                void openExportDialog(tableName, tables.find((item) => item.name === tableName)?.rows);
                return;
            case 'ai-explain':
                void injectTablePromptToAI(tableName, 'explain');
                return;
            case 'ai-generate-query':
                void injectTablePromptToAI(tableName, 'query');
                return;
            case 'truncate-table':
                void handleTableDataDangerAction(tableName, 'truncate');
                return;
            case 'drop-table':
                handleDeleteTable(tableName);
                return;
            default:
                return;
        }
    }, [
        handleCopyStructure,
        handleCopyTable,
        handleCopyTableAsInsert,
        handleCopyTableName,
        handleDeleteTable,
        handleRenameTable,
        handleTableDataDangerAction,
        openExportDialog,
        injectTablePromptToAI,
        loadData,
        openCreateStarRocksRollup,
        openDesign,
        openQueryForTable,
        openTableSQLExportWorkbench,
        openTable,
        openTableDdl,
        openTableInER,
        tables,
        toggleOverviewTablePinned,
    ]);

    const renderV2OverviewTableContextMenu = useCallback((table: TableStatRow) => (
        <V2TableContextMenuView
            tableName={table.name}
            shortcutPlatform={activeShortcutPlatform}
            stats={{
                rowCount: table.rows,
                dataLength: table.dataSize,
                indexLength: table.indexSize,
                engine: table.engine,
            }}
            isPinned={isOverviewTablePinned(pinnedSidebarTables, connection?.id, tab.dbName, schemaName, table.name)}
            supportsTruncate={allowTruncate}
            supportsCopyTable={supportsCopyTable}
            supportsStarRocksRollup={metadataDialect === 'starrocks'}
            onAction={(action) => {
                setV2ContextMenu(null);
                handleV2TableContextMenuAction(table, action);
            }}
        />
    ), [activeShortcutPlatform, allowTruncate, connection?.id, handleV2TableContextMenuAction, metadataDialect, pinnedSidebarTables, schemaName, supportsCopyTable, tab.dbName]);

    const buildLegacyTableContextMenuItems = useCallback((table: TableStatRow): MenuProps['items'] => [
        { key: 'new-query', label: t('table_overview.menu.new_query'), icon: <ConsoleSqlOutlined />, onClick: () => openQueryForTable(table.name) },
        { type: 'divider' },
        {
            key: 'design-table',
            label: supportsDesignWrite ? t('table_overview.menu.design_table') : t('table_overview.menu.table_structure'),
            icon: <EditOutlined />,
            onClick: () => openDesign(table.name),
        },
        { key: 'copy-table-name', label: t('table_overview.menu.copy_table_name'), icon: <CopyOutlined />, onClick: () => handleCopyTableName(table.name) },
        { key: 'copy-structure', label: t('table_overview.menu.copy_structure'), icon: <CopyOutlined />, onClick: () => handleCopyStructure(table.name) },
        ...(supportsCopyTable ? [{ key: 'copy-table', label: t('table_copy.action.label'), icon: <CopyOutlined />, onClick: () => handleCopyTable(table.name) }] : []),
        { key: 'backup-table', label: t('table_overview.menu.backup_table_sql'), icon: <SaveOutlined />, onClick: () => openTableSQLExportWorkbench(table.name, 'backup') },
        { key: 'rename-table', label: t('table_overview.menu.rename_table'), icon: <EditOutlined />, onClick: () => handleRenameTable(table.name) },
        { key: 'danger-zone', label: t('table_overview.menu.danger_operations'), icon: <WarningOutlined />, children: [
            ...(allowTruncate ? [{ key: 'truncate-table', label: t('table_overview.menu.truncate_table'), danger: true, onClick: () => handleTableDataDangerAction(table.name, 'truncate') }] : []),
            { key: 'clear-table', label: t('table_overview.menu.clear_table'), danger: true, onClick: () => handleTableDataDangerAction(table.name, 'clear') },
            { key: 'drop-table', label: t('table_overview.menu.delete_table'), icon: <DeleteOutlined />, danger: true, onClick: () => handleDeleteTable(table.name) },
        ]},
        { type: 'divider' },
        { key: 'export', label: t('table_overview.menu.export_table_data'), icon: <ExportOutlined />, onClick: () => openExportDialog(table.name, table.rows) },
    ], [
        allowTruncate,
        handleCopyStructure,
        handleCopyTable,
        handleCopyTableName,
        handleDeleteTable,
        handleRenameTable,
        handleTableDataDangerAction,
        openExportDialog,
        openDesign,
        openQueryForTable,
        openTableSQLExportWorkbench,
        supportsDesignWrite,
        supportsCopyTable,
        t,
    ]);

    const renderOverviewSectionTitle = (section: OverviewTableSection) => {
        const sectionTitle = section.kind === 'pinned'
            ? t('table_overview.section.pinned')
            : t('table_overview.section.all');

        return (
            <div
                className={isV2Ui ? 'gn-v2-table-overview-section-title' : undefined}
                data-overview-table-section={section.kind}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    margin: section.kind === 'pinned' ? '0 0 8px' : '14px 0 8px',
                    color: textMuted,
                    fontSize: 12,
                    fontWeight: 600,
                }}
            >
                <span>{sectionTitle}</span>
                <span>{section.rows.length}</span>
            </div>
        );
    };

    const formatOverviewTimestamp = useCallback((value?: string): string => {
        if (!value) return '';
        return formatSidebarTableTimestamp(value) || value;
    }, []);

    const renderTableOverviewMetaBadges = useCallback((table: TableStatRow, compact = false) => {
        const items = [
            ...(table.updateTime ? [{
                key: 'updated',
                label: t('table_overview.metric.updated_at'),
                raw: table.updateTime,
                value: formatOverviewTimestamp(table.updateTime),
            }] : []),
            ...(table.createTime ? [{
                key: 'created',
                label: t('table_overview.metric.created_at'),
                raw: table.createTime,
                value: formatOverviewTimestamp(table.createTime),
            }] : []),
        ];
        if (items.length === 0) return null;
        return (
            <div
                style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 8,
                    marginTop: compact ? 8 : 0,
                    marginBottom: compact ? 0 : 10,
                }}
            >
                {items.map((item) => (
                    <Tooltip key={item.key} title={`${item.label}: ${item.raw}`} mouseEnterDelay={0.4}>
                        <span
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                                maxWidth: '100%',
                                padding: compact ? '1px 7px' : '2px 8px',
                                borderRadius: 999,
                                background: isV2Ui
                                    ? 'var(--gn-bg-active)'
                                    : (darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'),
                                color: textSecondary,
                                fontSize: compact ? 10 : 11,
                                lineHeight: compact ? '16px' : '18px',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                            }}
                        >
                            <span style={{ opacity: 0.72 }}>{item.label}</span>
                            <span style={{ color: textPrimary, fontVariantNumeric: 'tabular-nums' }}>{item.value}</span>
                        </span>
                    </Tooltip>
                ))}
            </div>
        );
    }, [darkMode, formatOverviewTimestamp, isV2Ui, t, textPrimary, textSecondary]);

    const renderCardTableContent = (table: TableStatRow) => (
        <div
            className={isV2Ui ? 'gn-v2-table-card' : undefined}
            onDoubleClick={() => openTableByDefaultAction(table.name)}
            onContextMenu={isV2Ui ? (event) => openV2OverviewContextMenu(event, table) : undefined}
            style={{
                ...(isV2Ui ? {} : {
                    background: cardBg,
                    border: `1px solid ${cardBorder}`,
                }),
                borderRadius: 10,
                padding: '14px 16px',
                cursor: 'pointer',
                transition: isV2Ui ? undefined : 'all 0.15s ease',
                userSelect: 'none',
            }}
            onMouseEnter={isV2Ui ? undefined : e => { (e.currentTarget as HTMLDivElement).style.background = cardHoverBg; (e.currentTarget as HTMLDivElement).style.borderColor = accentColor; }}
            onMouseLeave={isV2Ui ? undefined : e => { (e.currentTarget as HTMLDivElement).style.background = cardBg || ''; (e.currentTarget as HTMLDivElement).style.borderColor = cardBorder || ''; }}
        >
            <div className={isV2Ui ? 'gn-v2-table-card-name' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <TableOutlined style={{ fontSize: 14, color: accentColor }} />
                <Tooltip title={table.name} mouseEnterDelay={0.4}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, display: 'block' }}>
                        {table.name}
                    </span>
                </Tooltip>
            </div>
            {table.comment && (
                <Tooltip title={table.comment} mouseEnterDelay={0.4}>
                    <div style={{ fontSize: 12, color: textSecondary, marginBottom: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {table.comment}
                    </div>
                </Tooltip>
            )}
            {renderTableOverviewMetaBadges(table)}
            <div className={isV2Ui ? 'gn-v2-table-card-meta' : undefined} style={{ display: 'flex', gap: 16, fontSize: 12, color: textMuted }}>
                <span title={t('table_overview.sort.rows')} style={{ minWidth: 52 }}>📊 {formatRows(table.rows)}</span>
                <span title={t('table_overview.metric.data_size')} style={{ minWidth: 72 }}>💾 {formatSize(table.dataSize)}</span>
                {table.engine && <span title={t('table_overview.metric.engine')} style={{ marginLeft: 'auto', opacity: 0.7 }}>{table.engine}</span>}
            </div>
            {isV2Ui && (
                <div className="gn-v2-table-size-bar">
                    <span style={{ width: `${Math.min(100, Math.max(4, maxCombinedSize > 0 && hasKnownTableSize(table) ? Math.round((getCombinedTableSize(table) / maxCombinedSize) * 100) : 4))}%` }} />
                </div>
            )}
        </div>
    );

    const renderCardTable = (table: TableStatRow) => {
        if (isV2Ui) {
            return <React.Fragment key={table.name}>{renderCardTableContent(table)}</React.Fragment>;
        }
        return (
            <Dropdown
                key={table.name}
                trigger={['contextMenu']}
                menu={{ items: buildLegacyTableContextMenuItems(table) }}
            >
                {renderCardTableContent(table)}
            </Dropdown>
        );
    };

    const renderListTable = (table: TableStatRow) => {
        const combinedSize = getCombinedTableSize(table);
        const sizeRatio = maxCombinedSize > 0 && hasKnownTableSize(table) ? combinedSize / maxCombinedSize : 0;
        const fillWidth = maxCombinedSize > 0 && hasKnownTableSize(table) ? `${Math.max(10, Math.round(sizeRatio * 100))}%` : '0%';
        const fillColor = isV2Ui
            ? 'var(--gn-accent-soft, rgba(34, 197, 94, 0.16))'
            : (darkMode ? 'rgba(22,119,255,0.18)' : 'rgba(22,119,255,0.12)');
        const rowSecondary = table.comment || (table.engine
            ? t('table_overview.row.engine_table', { engine: table.engine })
            : t('table_overview.row.open_hint'));

        const content = (
                <div
                    className={isV2Ui ? 'gn-v2-table-row' : undefined}
                    onDoubleClick={() => openTableByDefaultAction(table.name)}
                    onContextMenu={isV2Ui ? (event) => openV2OverviewContextMenu(event, table) : undefined}
                    style={{
                        position: 'relative',
                        overflow: 'hidden',
                        borderRadius: isV2Ui ? undefined : 10,
                        ...(isV2Ui ? {} : {
                            border: `1px solid ${cardBorder}`,
                            background: cardBg,
                        }),
                        cursor: 'pointer',
                        transition: isV2Ui ? undefined : 'all 0.15s ease',
                        userSelect: 'none',
                    }}
                    onMouseEnter={isV2Ui ? undefined : e => { (e.currentTarget as HTMLDivElement).style.background = cardHoverBg; (e.currentTarget as HTMLDivElement).style.borderColor = accentColor; }}
                    onMouseLeave={isV2Ui ? undefined : e => { (e.currentTarget as HTMLDivElement).style.background = cardBg || ''; (e.currentTarget as HTMLDivElement).style.borderColor = cardBorder || ''; }}
                >
                    <div
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            bottom: 0,
                            width: fillWidth,
                            background: fillColor,
                            pointerEvents: 'none',
                            transition: 'width 0.2s ease',
                        }}
                    />
                    <div
                        style={{
                            position: 'relative',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 16,
                            padding: '14px 16px',
                            flexWrap: 'wrap',
                        }}
                    >
                        <div style={{ minWidth: 0, flex: '1 1 320px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                                <TableOutlined style={{ fontSize: 13, color: accentColor, flexShrink: 0 }} />
                                <Tooltip title={table.name} mouseEnterDelay={0.4}>
                                    <span style={{ color: textPrimary, fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {table.name}
                                    </span>
                                </Tooltip>
                                {table.engine && (
                                    <span
                                        style={{
                                            flexShrink: 0,
                                            padding: '1px 6px',
                                            borderRadius: 999,
                                            fontSize: 11,
                                            color: textMuted,
                                            background: isV2Ui
                                                ? 'var(--gn-bg-active)'
                                                : (darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)'),
                                        }}
                                    >
                                        {table.engine}
                                    </span>
                                )}
                            </div>
                            <Tooltip title={rowSecondary} mouseEnterDelay={0.4}>
                                <div style={{ marginTop: 6, color: textSecondary, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {rowSecondary}
                                </div>
                            </Tooltip>
                            {renderTableOverviewMetaBadges(table, true)}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, flexWrap: 'wrap', fontSize: 12 }}>
                            <div style={{ minWidth: 96, textAlign: 'right' }}>
                                <div style={{ color: textMuted }}>{t('table_overview.sort.rows')}</div>
                                <div style={{ color: textPrimary, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatRows(table.rows)}</div>
                            </div>
                            <div style={{ minWidth: 110, textAlign: 'right' }}>
                                <div style={{ color: textMuted }}>{t('table_overview.metric.data_size')}</div>
                                <div style={{ color: textPrimary, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatSize(table.dataSize)}</div>
                            </div>
                            <div style={{ minWidth: 110, textAlign: 'right' }}>
                                <div style={{ color: textMuted }}>{t('table_overview.metric.index_size')}</div>
                                <div style={{ color: textPrimary, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatSize(table.indexSize)}</div>
                            </div>
                            <div style={{ minWidth: 96, textAlign: 'right' }}>
                                <div style={{ color: textMuted }}>{t('table_overview.metric.relative_size')}</div>
                                <div style={{ color: textPrimary, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                                    {maxCombinedSize > 0 && hasKnownTableSize(table) ? `${Math.round(sizeRatio * 100)}%` : '—'}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
        );

        if (isV2Ui) {
            return <React.Fragment key={table.name}>{content}</React.Fragment>;
        }

        return (
            <Dropdown
                key={table.name}
                trigger={['contextMenu']}
                menu={{ items: buildLegacyTableContextMenuItems(table) }}
            >
                {content}
            </Dropdown>
        );
    };

    const renderCompactSortHeader = (
        field: SortField,
        labelKey: string,
        align: 'left' | 'right' = 'left',
    ) => {
        const active = sortField === field;
        return (
            <button
                type="button"
                className="gn-table-overview-compact-sort-button"
                data-table-overview-sort={field}
                aria-pressed={active}
                onClick={() => toggleSort(field)}
                style={{
                    width: '100%',
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
                    gap: 5,
                    padding: '0 10px',
                    border: 0,
                    background: 'transparent',
                    color: active ? accentColor : textSecondary,
                    cursor: 'pointer',
                    font: 'inherit',
                    fontWeight: active ? 700 : 600,
                    textAlign: align,
                }}
            >
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t(labelKey)}
                </span>
                {active && (sortOrder === 'asc'
                    ? <CaretUpFilled aria-hidden="true" />
                    : <CaretDownFilled aria-hidden="true" />)}
            </button>
        );
    };

    const renderCompactTableHeader = () => (
        <div className="gn-table-overview-compact-header" role="row">
            <div role="columnheader" aria-sort={sortField === 'name' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}>
                {renderCompactSortHeader('name', 'table_overview.sort.name')}
            </div>
            <div role="columnheader" aria-sort={sortField === 'comment' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}>
                {renderCompactSortHeader('comment', 'table_overview.metric.comment')}
            </div>
            <div role="columnheader" aria-sort={sortField === 'rows' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}>
                {renderCompactSortHeader('rows', 'table_overview.sort.rows', 'right')}
            </div>
            <div role="columnheader" aria-sort={sortField === 'dataSize' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}>
                {renderCompactSortHeader('dataSize', 'table_overview.metric.data_size', 'right')}
            </div>
            <div role="columnheader" aria-sort={sortField === 'indexSize' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}>
                {renderCompactSortHeader('indexSize', 'table_overview.metric.index_size', 'right')}
            </div>
            <div role="columnheader" aria-sort={sortField === 'engine' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}>
                {renderCompactSortHeader('engine', 'table_overview.metric.engine')}
            </div>
            <div role="columnheader" aria-sort={sortField === 'updateTime' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}>
                {renderCompactSortHeader('updateTime', 'table_overview.metric.updated_at')}
            </div>
            <div role="columnheader" aria-sort={sortField === 'createTime' ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}>
                {renderCompactSortHeader('createTime', 'table_overview.metric.created_at')}
            </div>
        </div>
    );

    const renderCompactTableRow = (table: TableStatRow) => {
        const content = (
            <div
                className="gn-table-overview-compact-row"
                role="row"
                data-table-overview-row={table.name}
                onDoubleClick={() => openTableByDefaultAction(table.name)}
                onContextMenu={isV2Ui ? (event) => openV2OverviewContextMenu(event, table) : undefined}
                style={{
                    display: 'grid',
                    alignItems: 'center',
                    minWidth: 1120,
                    minHeight: 32,
                    ...(isV2Ui ? {
                        cursor: 'pointer',
                        userSelect: 'none',
                    } : {
                        borderBottom: `1px solid ${cardBorder}`,
                        background: cardBg,
                        color: textPrimary,
                        cursor: 'pointer',
                        userSelect: 'none',
                    }),
                }}
            >
                <div className="gn-table-overview-compact-name" role="cell" title={table.name}>
                    <TableOutlined aria-hidden="true" />
                    <span>{table.name}</span>
                </div>
                <div className="gn-table-overview-compact-cell" role="cell" title={table.comment || undefined}>{table.comment || '—'}</div>
                <div className="gn-table-overview-compact-cell gn-table-overview-compact-number" role="cell" title={table.rows >= 0 ? String(table.rows) : undefined}>{formatRows(table.rows)}</div>
                <div className="gn-table-overview-compact-cell gn-table-overview-compact-number" role="cell" title={table.dataSize >= 0 ? String(table.dataSize) : undefined}>{formatSize(table.dataSize)}</div>
                <div className="gn-table-overview-compact-cell gn-table-overview-compact-number" role="cell" title={table.indexSize >= 0 ? String(table.indexSize) : undefined}>{formatSize(table.indexSize)}</div>
                <div className="gn-table-overview-compact-cell" role="cell" title={table.engine || undefined}>{table.engine || '—'}</div>
                <div
                    className="gn-table-overview-compact-cell"
                    role="cell"
                    title={table.updateTime || undefined}
                >
                    {table.updateTime ? formatOverviewTimestamp(table.updateTime) : '—'}
                </div>
                <div
                    className="gn-table-overview-compact-cell"
                    role="cell"
                    title={table.createTime || undefined}
                >
                    {table.createTime ? formatOverviewTimestamp(table.createTime) : '—'}
                </div>
            </div>
        );

        if (isV2Ui) {
            return <React.Fragment key={table.name}>{content}</React.Fragment>;
        }
        return (
            <Dropdown
                key={table.name}
                trigger={['contextMenu']}
                menu={{ items: buildLegacyTableContextMenuItems(table) }}
            >
                {content}
            </Dropdown>
        );
    };

    if (loading) {
        return (
            <div className={isV2Ui ? 'gn-table-overview gn-v2-table-overview gn-v2-table-overview-loading' : 'gn-table-overview'} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: containerBg }}>
                <Spin size="large" tip={t('table_overview.status.loading_tables')} />
            </div>
        );
    }

    const viewSwitchBtnClass = (mode: ViewMode) => (
        isV2Ui
            ? `gn-v2-table-overview-view-switch-btn${viewMode === mode ? ' is-active' : ''}`
            : undefined
    );

    return (
        <div className={isV2Ui ? 'gn-table-overview gn-v2-table-overview' : 'gn-table-overview'} style={{ display: 'flex', flexDirection: 'column', height: '100%', background: containerBg, overflow: 'hidden' }}>
            {/* Toolbar */}
            <div className={isV2Ui ? 'gn-table-overview-header gn-v2-table-overview-header' : 'gn-table-overview-header'} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', flexShrink: 0 }}>
                <span className={isV2Ui ? 'gn-v2-table-overview-icon' : undefined}>
                    <DatabaseOutlined style={{ fontSize: 16, color: isV2Ui ? undefined : accentColor }} />
                </span>
                <span className={isV2Ui ? 'gn-v2-table-overview-title' : undefined} style={{ fontSize: 14, fontWeight: 600, color: textPrimary }}>{tab.dbName}</span>
                <span className={isV2Ui ? 'gn-table-overview-summary gn-v2-table-overview-summary' : 'gn-table-overview-summary'} style={{ fontSize: 12, color: textMuted }}>
                    {renderToolbarSummary()}
                </span>
                <div style={{ flex: 1 }} />
                <Input
                    {...noAutoCapInputProps}
                    placeholder={t('table_overview.placeholder.search')}
                    prefix={<SearchOutlined style={{ color: textMuted }} />}
                    value={searchText}
                    onChange={e => setSearchText(e.target.value)}
                    allowClear
                    style={{ width: 240 }}
                    size="small"
                />
                <Dropdown menu={{ items: sortMenuItems }} trigger={['click']}>
                    <Tooltip title={t('table_overview.tooltip.sort')}><SortAscendingOutlined style={{ fontSize: 16, color: textSecondary, cursor: 'pointer' }} /></Tooltip>
                </Dropdown>
                <div
                    className={isV2Ui ? 'gn-v2-table-overview-view-switch' : undefined}
                    style={isV2Ui ? undefined : { display: 'flex', gap: 2, padding: 2, borderRadius: 6, background: darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }}
                >
                    <Tooltip title={t('table_overview.tooltip.card_view')}>
                        <button
                            type="button"
                            className={viewSwitchBtnClass('card')}
                            data-table-overview-view-mode="card"
                            aria-label={t('table_overview.tooltip.card_view')}
                            aria-pressed={viewMode === 'card'}
                            onClick={() => setViewMode('card')}
                            style={isV2Ui ? undefined : {
                                width: 28, height: 24, padding: 0, border: 0, borderRadius: 5, cursor: 'pointer', transition: 'all 0.15s',
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', font: 'inherit',
                                background: viewMode === 'card' ? (darkMode ? 'rgba(255,255,255,0.12)' : '#fff') : 'transparent',
                                boxShadow: viewMode === 'card' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                                color: viewMode === 'card' ? accentColor : textMuted,
                            }}
                        >
                            <AppstoreOutlined style={{ fontSize: 14 }} />
                        </button>
                    </Tooltip>
                    <Tooltip title={t('table_overview.tooltip.list_view')}>
                        <button
                            type="button"
                            className={viewSwitchBtnClass('list')}
                            data-table-overview-view-mode="list"
                            aria-label={t('table_overview.tooltip.list_view')}
                            aria-pressed={viewMode === 'list'}
                            onClick={() => setViewMode('list')}
                            style={isV2Ui ? undefined : {
                                width: 28, height: 24, padding: 0, border: 0, borderRadius: 5, cursor: 'pointer', transition: 'all 0.15s',
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', font: 'inherit',
                                background: viewMode === 'list' ? (darkMode ? 'rgba(255,255,255,0.12)' : '#fff') : 'transparent',
                                boxShadow: viewMode === 'list' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                                color: viewMode === 'list' ? accentColor : textMuted,
                            }}
                        >
                            <UnorderedListOutlined style={{ fontSize: 14 }} />
                        </button>
                    </Tooltip>
                    <Tooltip title={t('table_overview.tooltip.table_view')}>
                        <button
                            type="button"
                            className={viewSwitchBtnClass('table')}
                            data-table-overview-view-mode="table"
                            aria-label={t('table_overview.tooltip.table_view')}
                            aria-pressed={viewMode === 'table'}
                            onClick={() => setViewMode('table')}
                            style={isV2Ui ? undefined : {
                                width: 28, height: 24, padding: 0, border: 0, borderRadius: 5, cursor: 'pointer', transition: 'all 0.15s',
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', font: 'inherit',
                                background: viewMode === 'table' ? (darkMode ? 'rgba(255,255,255,0.12)' : '#fff') : 'transparent',
                                boxShadow: viewMode === 'table' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                                color: viewMode === 'table' ? accentColor : textMuted,
                            }}
                        >
                            <TableOutlined style={{ fontSize: 14 }} />
                        </button>
                    </Tooltip>
                </div>
                <Tooltip title={t('table_overview.tooltip.refresh')}><ReloadOutlined onClick={loadData} style={{ fontSize: 16, color: textSecondary, cursor: 'pointer' }} /></Tooltip>
            </div>

            {/* Content Area */}
            <div
                className={isV2Ui ? 'gn-v2-table-overview-content' : undefined}
                data-view-mode={isV2Ui ? viewMode : undefined}
                style={isV2Ui ? {
                    flex: 1,
                    minHeight: 0,
                } : {
                    flex: 1,
                    minHeight: 0,
                    overflow: viewMode === 'table' ? 'hidden' : 'auto',
                    padding: '0 16px 16px 16px',
                    display: viewMode === 'table' ? 'flex' : undefined,
                    flexDirection: viewMode === 'table' ? 'column' : undefined,
                }}
            >
                {sortedFiltered.length > 0 && (isSearchPending || visibleOverview.hiddenCount > 0 || deferredSearchText.trim()) && (
                    <div
                        className={isV2Ui ? 'gn-v2-table-overview-filter-bar' : undefined}
                        style={isV2Ui ? {
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 12,
                            fontSize: 12,
                            flexShrink: 0,
                        } : {
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 12,
                            marginBottom: 10,
                            padding: '8px 10px',
                            borderRadius: 10,
                            background: darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.025)',
                            color: textMuted,
                            fontSize: 12,
                        }}
                    >
                        <span>
                            {isSearchPending
                                ? t('table_overview.status.updating_filter')
                                : t('table_overview.status.matching_rendered', {
                                    matched: sortedFiltered.length,
                                    rendered: visibleTables.length,
                                })}
                        </span>
                        {visibleOverview.hiddenCount > 0 && (
                            <span>{t('table_overview.status.hidden_count_hint', { count: visibleOverview.hiddenCount })}</span>
                        )}
                    </div>
                )}
                {sortedFiltered.length === 0 ? (
                    <Empty description={searchText ? t('table_overview.empty.no_matches') : t('table_overview.empty.no_tables')} style={{ marginTop: 80 }} />
                ) : (
                    viewMode === 'table' ? (
                        <div
                            className="gn-table-overview-compact-scroll"
                            role="table"
                            aria-label={t('table_overview.tooltip.table_view')}
                        >
                            {renderCompactTableHeader()}
                            {visibleTableSections.map((section) => (
                                <React.Fragment key={section.key}>
                                    {pinnedOverview.pinnedRows.length > 0 && (
                                        <div className="gn-table-overview-compact-section">
                                            {renderOverviewSectionTitle(section)}
                                        </div>
                                    )}
                                    {section.rows.map(renderCompactTableRow)}
                                </React.Fragment>
                            ))}
                        </div>
                    ) : (
                    <div className={isV2Ui ? 'gn-v2-table-overview-sections' : undefined}>
                        {visibleTableSections.map((section) => (
                            <section key={section.key} className={isV2Ui ? 'gn-v2-table-overview-section' : undefined}>
                                {pinnedOverview.pinnedRows.length > 0 && renderOverviewSectionTitle(section)}
                                {viewMode === 'card' ? (
                                    <div className={isV2Ui ? 'gn-v2-table-card-grid' : undefined} style={{
                                        display: 'grid',
                                        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                                        gap: 12,
                                    }}>
                                        {section.rows.map(renderCardTable)}
                                    </div>
                                ) : (
                                    <div
                                        className={isV2Ui ? 'gn-v2-table-row-list' : undefined}
                                        style={{ display: 'flex', flexDirection: 'column', gap: isV2Ui ? 0 : 10 }}
                                    >
                                        {section.rows.map(renderListTable)}
                                    </div>
                                )}
                            </section>
                        ))}
                    </div>
                    )
                )}
                {sortedFiltered.length > 0 && visibleOverview.hiddenCount > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0 4px' }}>
                        <Button
                            size="small"
                            onClick={() => setVisibleTableLimit(limit => limit + TABLE_OVERVIEW_RENDER_BATCH_SIZE)}
                        >
                            {t('table_overview.action.show_more', { count: visibleOverview.hiddenCount })}
                        </Button>
                    </div>
                )}
            </div>
            {isV2Ui && v2ContextMenu && v2ContextMenuTable && typeof document !== 'undefined' && createPortal(
                <div
                    ref={v2ContextMenuPortalRef}
                    className="gn-v2-table-overview-context-menu-portal gn-v2-table-context-menu-popup"
                    data-gonavi-close-shortcut-guard="true"
                    data-gonavi-close-shortcut-blocks-background="true"
                    style={{
                        position: 'fixed',
                        left: v2ContextMenu.x,
                        top: v2ContextMenu.y,
                        zIndex: APP_POPUP_Z_INDEX,
                        width: OVERVIEW_CONTEXT_MENU_WIDTH,
                        maxWidth: 'calc(100vw - 24px)',
                        ['--gn-v2-context-menu-max-height' as any]: `${v2ContextMenu.maxHeight}px`,
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onContextMenu={(event) => event.preventDefault()}
                >
                    {renderV2OverviewTableContextMenu(v2ContextMenuTable)}
                </div>,
                document.body,
            )}
        </div>
    );
};

export default TableOverview;
