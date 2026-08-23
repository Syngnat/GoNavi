import Modal from './common/ResizableDraggableModal';
import React, { useState, useRef, useCallback, useMemo } from 'react';
import { Input, Button, Table, Progress, Space, Tag, message, Tooltip, Select, Empty } from 'antd';
import { SearchOutlined, StopOutlined, EyeOutlined, DatabaseOutlined } from '@ant-design/icons';
import { DBQuery, DBGetTables, DBGetAllColumns } from '../../wailsjs/go/app/App';
import { quoteIdentPart, escapeLiteral } from '../utils/sql';
import { useStore } from '../store';
import { buildOverlayWorkbenchTheme } from '../utils/overlayWorkbenchTheme';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { isMacLikePlatform } from '../utils/appearance';
import { useI18n } from '../i18n/provider';
import { normalizeTableNamesFromMetadataRows } from '../utils/tableMetadataRows';
import { getTableMetadataIssueDetail, isTableMetadataIncomplete } from '../utils/tableMetadataResult';

interface FindInDatabaseModalProps {
    open: boolean;
    onClose: () => void;
    connectionId: string;
    dbName: string;
}

interface SearchResultItem {
    tableName: string;
    matchedColumns: string[];
    matchCount: number;
    rows: Record<string, any>[];
    columns: string[];
}

/** Returns whether a database column type is searchable as text. */
const isTextColumnType = (colType: string): boolean => {
    const t = (colType || '').toLowerCase().trim();
    // Explicitly skip non-text types before falling back to searchable.
    if (/^(int|bigint|smallint|tinyint|mediumint|float|double|decimal|numeric|real|money|smallmoney|bit|boolean|bool)/.test(t)) return false;
    if (/^(date|time|datetime|timestamp|year|interval)/.test(t)) return false;
    if (/^(blob|binary|varbinary|image|bytea|raw|long raw)/.test(t)) return false;
    if (/^(geometry|geography|point|line|polygon|spatial)/.test(t)) return false;
    if (/^(json|jsonb|xml|uuid|uniqueidentifier)/.test(t)) return false;
    if (/^(serial|bigserial|smallserial|autoincrement|identity)/.test(t)) return false;
    // Positive text type matches.
    if (/^(varchar|char|nvarchar|nchar|text|ntext|tinytext|mediumtext|longtext|string|clob|nclob|character)/.test(t)) return true;
    if (t === 'sysname' || t === 'sql_variant') return true;
    // Unknown types are attempted by default.
    return true;
};

/** Builds a SELECT statement with a dialect-specific row limit. */
const buildLimitedSelectSQL = (dbType: string, baseSql: string, limit: number): string => {
    const normalizedType = (dbType || '').toLowerCase();
    switch (normalizedType) {
        case 'sqlserver':
        case 'mssql':
            return baseSql.replace(/^SELECT\b/i, `SELECT TOP ${limit}`);
        case 'oracle':
        case 'dameng':
            return `${baseSql} FETCH FIRST ${limit} ROWS ONLY`;
        default:
            return `${baseSql} LIMIT ${limit}`;
    }
};

const MAX_MATCH_ROWS_PER_TABLE = 100;

const FindInDatabaseModal: React.FC<FindInDatabaseModalProps> = ({ open, onClose, connectionId, dbName }) => {
    const { t } = useI18n();
    const [keyword, setKeyword] = useState('');
    const [matchMode, setMatchMode] = useState<'contains' | 'exact'>('contains');
    const [searching, setSearching] = useState(false);
    const [results, setResults] = useState<SearchResultItem[]>([]);
    const [progress, setProgress] = useState({ current: 0, total: 0, tableName: '' });
    const [expandedTable, setExpandedTable] = useState<string | null>(null);
    const cancelledRef = useRef(false);

    const connections = useStore(state => state.connections);
    const theme = useStore(state => state.theme);
    const disableLocalBackdropFilter = isMacLikePlatform();

    const conn = useMemo(() => connections.find(c => c.id === connectionId), [connections, connectionId]);
    const dbType = useMemo(() => (conn?.config?.type || 'mysql').toLowerCase(), [conn]);

    const wt = useMemo(() => {
        const isDark = theme === 'dark';
        return buildOverlayWorkbenchTheme(isDark, { disableBackdropFilter: disableLocalBackdropFilter });
    }, [disableLocalBackdropFilter, theme]);

    const buildConfig = useCallback(() => {
        if (!conn) return null;
        return {
            ...conn.config,
            port: Number(conn.config.port),
            password: conn.config.password || "",
            database: conn.config.database || "",
            useSSH: conn.config.useSSH || false,
            ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
        };
    }, [conn]);

    const handleSearch = useCallback(async () => {
        const searchKeyword = keyword.trim();
        if (!searchKeyword) {
            message.warning(t('find_in_database.message.keyword_required'));
            return;
        }
        const config = buildConfig();
        if (!config) {
            message.error(t('find_in_database.message.connection_config_not_found'));
            return;
        }

        setSearching(true);
        setResults([]);
        setExpandedTable(null);
        cancelledRef.current = false;

        try {
            const tablesRes = await DBGetTables(buildRpcConnectionConfig(config) as any, dbName);
            if (!tablesRes.success || isTableMetadataIncomplete(tablesRes)) {
                const detail = getTableMetadataIssueDetail(tablesRes);
                const notify = tablesRes.success ? message.warning : message.error;
                notify(t('find_in_database.message.get_tables_failed', { detail }));
                setSearching(false);
                return;
            }
            const tableNames = normalizeTableNamesFromMetadataRows(tablesRes.data);

            if (tableNames.length === 0) {
                message.info(t('find_in_database.message.no_tables'));
                setSearching(false);
                return;
            }

            setProgress({ current: 0, total: tableNames.length, tableName: '' });

            const allColsRes = await DBGetAllColumns(buildRpcConnectionConfig(config) as any, dbName);
            if (!allColsRes?.success) {
                message.error(t('find_in_database.message.get_all_columns_failed', {
                    detail: String(allColsRes?.message || ''),
                }));
                return;
            }
            const allColumns: any[] = (allColsRes?.success && Array.isArray(allColsRes.data)) ? allColsRes.data : [];
            if (allColsRes?.success && isTableMetadataIncomplete(allColsRes)) {
                message.warning(getTableMetadataIssueDetail(allColsRes));
            }

            const columnsByTable: Record<string, Array<{ name: string; type: string }>> = {};
            allColumns.forEach((col: any) => {
                const tbl = col.tableName || '';
                if (!columnsByTable[tbl]) columnsByTable[tbl] = [];
                columnsByTable[tbl].push({ name: col.name, type: col.type || '' });
            });

            const searchResults: SearchResultItem[] = [];
            const escapedKeyword = escapeLiteral(searchKeyword);

            for (let i = 0; i < tableNames.length; i++) {
                if (cancelledRef.current) break;

                const tableName = tableNames[i];
                setProgress({ current: i + 1, total: tableNames.length, tableName });

                const tableCols = columnsByTable[tableName] || [];
                const textCols = tableCols.filter(c => isTextColumnType(c.type));

                if (textCols.length === 0) continue;

                const castType = (dbType === 'sqlserver' || dbType === 'mssql') ? 'NVARCHAR(MAX)' : 'CHAR';
                const whereConditions = textCols.map(c => {
                    const quotedCol = quoteIdentPart(dbType, c.name);
                    if (matchMode === 'exact') {
                        return `CAST(${quotedCol} AS ${castType}) = '${escapedKeyword}'`;
                    }
                    return `CAST(${quotedCol} AS ${castType}) LIKE '%${escapedKeyword}%'`;
                });

                const quotedTable = quoteIdentPart(dbType, tableName);
                const baseSql = `SELECT * FROM ${quotedTable} WHERE ${whereConditions.join(' OR ')}`;
                const sql = buildLimitedSelectSQL(dbType, baseSql, MAX_MATCH_ROWS_PER_TABLE);

                try {
                    const res = await DBQuery(buildRpcConnectionConfig(config) as any, dbName, sql);
                    if (res.success && Array.isArray(res.data) && res.data.length > 0) {
                        const matchedCols = new Set<string>();
                        const lowerKeyword = searchKeyword.toLowerCase();
                        res.data.forEach((row: any) => {
                            textCols.forEach(c => {
                                const val = row[c.name];
                                if (val != null) {
                                    const strVal = String(val).toLowerCase();
                                    if (matchMode === 'exact' ? strVal === lowerKeyword : strVal.includes(lowerKeyword)) {
                                        matchedCols.add(c.name);
                                    }
                                }
                            });
                        });

                        if (matchedCols.size > 0) {
                            const columns = Object.keys(res.data[0]);
                            searchResults.push({
                                tableName,
                                matchedColumns: Array.from(matchedCols),
                                matchCount: res.data.length,
                                rows: res.data,
                                columns,
                            });
                            setResults([...searchResults]);
                        }
                    }
                } catch {
                    // Per-table query failures should not stop the whole search.
                }
            }

            if (!cancelledRef.current) {
                setResults([...searchResults]);
                if (searchResults.length === 0) {
                    message.info(t('find_in_database.message.no_matches'));
                }
            }
        } catch (e: any) {
            message.error(t('find_in_database.message.search_failed', { detail: e?.message || String(e) }));
        } finally {
            setSearching(false);
        }
    }, [keyword, matchMode, dbName, dbType, buildConfig, t]);

    const handleCancel = useCallback(() => {
        cancelledRef.current = true;
    }, []);

    const handleClose = useCallback(() => {
        cancelledRef.current = true;
        setResults([]);
        setExpandedTable(null);
        setProgress({ current: 0, total: 0, tableName: '' });
        onClose();
    }, [onClose]);

    const summaryColumns = useMemo(() => [
        {
            title: t('find_in_database.column.table_name'),
            dataIndex: 'tableName',
            key: 'tableName',
            width: 220,
            render: (text: string) => (
                <span style={{ fontWeight: 500, color: wt.titleText }}>
                    <DatabaseOutlined style={{ marginRight: 6, color: wt.iconColor }} />
                    {text}
                </span>
            ),
        },
        {
            title: t('find_in_database.column.matched_columns'),
            dataIndex: 'matchedColumns',
            key: 'matchedColumns',
            render: (cols: string[]) => (
                <Space size={4} wrap>
                    {cols.map(col => (
                        <Tag key={col} color="blue" style={{ margin: 0, fontSize: 12 }}>{col}</Tag>
                    ))}
                </Space>
            ),
        },
        {
            title: t('find_in_database.column.match_count'),
            dataIndex: 'matchCount',
            key: 'matchCount',
            width: 100,
            align: 'center' as const,
            render: (count: number) => (
                <Tag color={count >= MAX_MATCH_ROWS_PER_TABLE ? 'orange' : 'green'}>
                    {count >= MAX_MATCH_ROWS_PER_TABLE ? `≥${count}` : count}
                </Tag>
            ),
        },
        {
            title: t('find_in_database.column.action'),
            key: 'action',
            width: 80,
            align: 'center' as const,
            render: (_: any, record: SearchResultItem) => (
                <Tooltip title={expandedTable === record.tableName ? t('find_in_database.tooltip.collapse_details') : t('find_in_database.tooltip.view_details')}>
                    <Button
                        type="text"
                        size="small"
                        icon={<EyeOutlined />}
                        onClick={(e) => { e.stopPropagation(); setExpandedTable(prev => prev === record.tableName ? null : record.tableName); }}
                        style={{ color: wt.iconColor }}
                    />
                </Tooltip>
            ),
        },
    ], [wt, expandedTable, t]);

    const expandedResult = useMemo(() => {
        if (!expandedTable) return null;
        return results.find(r => r.tableName === expandedTable);
    }, [expandedTable, results]);

    const detailColumns = useMemo(() => {
        if (!expandedResult) return [];
        const lowerKeyword = keyword.trim().toLowerCase();
        return expandedResult.columns.map(col => ({
            title: col,
            dataIndex: col,
            key: col,
            width: 180,
            ellipsis: true,
            render: (value: any) => {
                const strVal = value != null ? String(value) : '';
                const isMatch = expandedResult.matchedColumns.includes(col) &&
                    strVal.toLowerCase().includes(lowerKeyword);
                return (
                    <Tooltip title={strVal} placement="topLeft">
                        <span style={isMatch ? { background: 'rgba(255, 193, 7, 0.3)', padding: '1px 3px', borderRadius: 3 } : undefined}>
                            {strVal || <span style={{ color: wt.mutedText }}>NULL</span>}
                        </span>
                    </Tooltip>
                );
            },
        }));
    }, [expandedResult, keyword, wt]);

    const percent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

    return (
        <Modal
            title={
                <span style={{ color: wt.titleText, fontWeight: 600 }}>
                    <SearchOutlined style={{ marginRight: 8, color: wt.iconColor }} />
                    {t('find_in_database.title', { dbName })}
                </span>
            }
            open={open}
            onCancel={handleClose}
            footer={null}
            width={960}
            styles={{
                content: {
                    background: wt.shellBg,
                    borderRadius: 16,
                    border: wt.shellBorder,
                    boxShadow: wt.shellShadow,
                    backdropFilter: wt.shellBackdropFilter,
                    WebkitBackdropFilter: wt.shellBackdropFilter,
                },
                header: { background: 'transparent', borderBottom: 'none', paddingBottom: 8 },
                body: { paddingTop: 8 },
            }}
            destroyOnHidden
        >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Input
                        placeholder={t('find_in_database.placeholder.keyword')}
                        value={keyword}
                        onChange={e => setKeyword(e.target.value)}
                        onPressEnter={!searching ? handleSearch : undefined}
                        style={{ flex: 1 }}
                        disabled={searching}
                        autoFocus
                    />
                    <Select
                        value={matchMode}
                        onChange={v => setMatchMode(v)}
                        disabled={searching}
                        style={{ width: 110 }}
                        options={[
                            { label: t('find_in_database.match.contains'), value: 'contains' },
                            { label: t('find_in_database.match.exact'), value: 'exact' },
                        ]}
                    />
                    {searching ? (
                        <Button icon={<StopOutlined />} danger onClick={handleCancel}>
                            {t('common.cancel')}
                        </Button>
                    ) : (
                        <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch} disabled={!keyword.trim()}>
                            {t('common.search')}
                        </Button>
                    )}
                </div>

                {searching && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <Progress
                            percent={percent}
                            size="small"
                            status="active"
                            strokeColor={wt.iconColor}
                        />
                        <span style={{ fontSize: 12, color: wt.mutedText }}>
                            {t('find_in_database.progress.searching_table', {
                                table: progress.tableName,
                                current: progress.current,
                                total: progress.total,
                            })}
                        </span>
                    </div>
                )}

                {results.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ fontSize: 13, color: wt.mutedText, fontWeight: 500 }}>
                            {t('find_in_database.summary.found_tables', { count: results.length })}
                            {searching && t('find_in_database.summary.searching')}
                        </div>
                        <Table
                            dataSource={results}
                            columns={summaryColumns}
                            rowKey="tableName"
                            size="small"
                            pagination={false}
                            style={{ borderRadius: 8, overflow: 'hidden' }}
                            scroll={{ y: expandedTable ? 200 : 400 }}
                            onRow={(record) => ({
                                style: {
                                    cursor: 'pointer',
                                    background: expandedTable === record.tableName ? wt.hoverBg : undefined,
                                },
                                onClick: () => setExpandedTable(prev => prev === record.tableName ? null : record.tableName),
                            })}
                        />
                    </div>
                )}

                {expandedResult && (
                    <div style={{
                        border: wt.sectionBorder,
                        borderRadius: 8,
                        background: wt.sectionBg,
                        overflow: 'hidden',
                    }}>
                        <div style={{
                            padding: '8px 12px',
                            borderBottom: wt.sectionBorder,
                            fontSize: 13,
                            fontWeight: 500,
                            color: wt.titleText,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                        }}>
                            <span>
                                <DatabaseOutlined style={{ marginRight: 6 }} />
                                {t('find_in_database.detail.title', { table: expandedResult.tableName })}
                            </span>
                            <Tag color="blue">{t('find_in_database.detail.row_count', { count: expandedResult.rows.length })}</Tag>
                        </div>
                        <Table
                            dataSource={expandedResult.rows.map((row, i) => ({ ...row, __rowIdx: i }))}
                            columns={detailColumns}
                            rowKey="__rowIdx"
                            size="small"
                            pagination={{ pageSize: 20, size: 'small', showSizeChanger: false }}
                            scroll={{ x: Math.max(800, expandedResult.columns.length * 180) }}
                            style={{ fontSize: 12 }}
                        />
                    </div>
                )}

                {!searching && results.length === 0 && progress.total > 0 && (
                    <Empty description={t('find_in_database.message.no_matches')} style={{ margin: '24px 0' }} />
                )}
            </div>
        </Modal>
    );
};

export default FindInDatabaseModal;
