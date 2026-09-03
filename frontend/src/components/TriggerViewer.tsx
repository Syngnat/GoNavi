import React, { useState, useEffect, useRef, useCallback } from 'react';
import Editor from './MonacoEditor';
import { Button, Spin, Alert } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { TabData } from '../types';
import { useStore } from '../store';
import { DBGetTriggers, DBQuery } from '../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { resolveSqlDialect } from '../utils/sqlDialect';
import {
    splitMetadataQualifiedName,
    splitQualifiedNameLast,
} from '../utils/qualifiedName';
import { buildEditableTriggerSql } from '../utils/triggerEditSql';
import {
    buildTableDesignerTriggerDropSql,
    buildTableDesignerTriggerRestoreSql,
    shouldDropTableDesignerTriggerBeforeReplace,
} from '../utils/tableDesignerTriggerSql';
import { findTriggerDefinitionStatement } from '../utils/triggerDefinition';
import { buildSqlServerObjectDefinitionQueries } from '../utils/sqlServerObjectDefinition';
import { useI18n } from '../i18n/provider';

interface TriggerViewerProps {
    tab: TabData;
}

const getCaseInsensitiveRawValue = (row: Record<string, any>, keys: string[]): any => {
    const normalizedKeyMap = new Map<string, string>();
    Object.keys(row || {}).forEach((key) => normalizedKeyMap.set(key.toLowerCase(), key));
    for (const key of keys) {
        const matchedKey = normalizedKeyMap.get(String(key || '').toLowerCase());
        if (!matchedKey) continue;
        const value = row[matchedKey];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
            return value;
        }
    }
    return undefined;
};

const buildMySQLTriggerDDLFromMetadata = (
    row: Record<string, any>,
    fallbackTriggerName: string,
    fallbackTableName: string,
): string => {
    const triggerName = String(
        getCaseInsensitiveRawValue(row, ['trigger_name', 'Trigger', 'TRIGGER_NAME'])
        || splitQualifiedNameLast(fallbackTriggerName).objectName
        || fallbackTriggerName,
    ).trim();
    const triggerSchema = String(getCaseInsensitiveRawValue(row, ['trigger_schema', 'TRIGGER_SCHEMA']) || '').trim();
    const eventSchema = String(getCaseInsensitiveRawValue(row, ['event_object_schema', 'EVENT_OBJECT_SCHEMA']) || '').trim();
    const eventTable = String(
        getCaseInsensitiveRawValue(row, ['event_object_table', 'EVENT_OBJECT_TABLE', 'table_name', 'TABLE_NAME'])
        || splitQualifiedNameLast(fallbackTableName).objectName
        || fallbackTableName,
    ).trim();
    const actionTiming = String(getCaseInsensitiveRawValue(row, ['action_timing', 'ACTION_TIMING']) || '').trim().toUpperCase();
    const eventManipulation = String(getCaseInsensitiveRawValue(row, ['event_manipulation', 'EVENT_MANIPULATION']) || '').trim().toUpperCase();
    const actionOrientation = String(getCaseInsensitiveRawValue(row, ['action_orientation', 'ACTION_ORIENTATION']) || '').trim().toUpperCase();
    const actionStatement = String(getCaseInsensitiveRawValue(row, ['action_statement', 'ACTION_STATEMENT']) || '').trim();

    if (!triggerName || !eventTable || !actionTiming || !eventManipulation || !actionStatement) {
        return '';
    }

    const qualifiedTriggerName = triggerSchema ? `\`${triggerSchema.replace(/`/g, '``')}\`.\`${triggerName.replace(/`/g, '``')}\`` : `\`${triggerName.replace(/`/g, '``')}\``;
    const qualifiedTableName = eventSchema ? `\`${eventSchema.replace(/`/g, '``')}\`.\`${eventTable.replace(/`/g, '``')}\`` : `\`${eventTable.replace(/`/g, '``')}\``;
    const orientationClause = actionOrientation === 'ROW' ? '\nFOR EACH ROW' : '';
    return `CREATE TRIGGER ${qualifiedTriggerName}\n${actionTiming} ${eventManipulation} ON ${qualifiedTableName}${orientationClause}\n${actionStatement}`;
};

const buildOracleLikeTriggerDDLFromMetadata = (
    row: Record<string, any>,
    fallbackTriggerName: string,
    fallbackTableName: string,
): string => {
    const triggerName = String(
        getCaseInsensitiveRawValue(row, ['trigger_name', 'TRIGGER_NAME'])
        || splitQualifiedNameLast(fallbackTriggerName).objectName
        || fallbackTriggerName,
    ).trim();
    const owner = String(getCaseInsensitiveRawValue(row, ['owner', 'OWNER']) || splitQualifiedNameLast(fallbackTriggerName).parentPath || '').trim();
    const tableOwner = String(getCaseInsensitiveRawValue(row, ['table_owner', 'TABLE_OWNER']) || splitQualifiedNameLast(fallbackTableName).parentPath || '').trim();
    const tableName = String(
        getCaseInsensitiveRawValue(row, ['table_name', 'TABLE_NAME'])
        || splitQualifiedNameLast(fallbackTableName).objectName
        || fallbackTableName,
    ).trim();
    const triggerType = String(getCaseInsensitiveRawValue(row, ['trigger_type', 'TRIGGER_TYPE']) || '').trim();
    const triggeringEvent = String(getCaseInsensitiveRawValue(row, ['triggering_event', 'TRIGGERING_EVENT']) || '').trim();
    const whenClause = String(getCaseInsensitiveRawValue(row, ['when_clause', 'WHEN_CLAUSE']) || '').trim();
    const triggerBody = String(getCaseInsensitiveRawValue(row, ['trigger_body', 'TRIGGER_BODY']) || '').trim();

    if (!triggerName || !tableName || !triggerType || !triggeringEvent || !triggerBody) {
        return '';
    }

    const qualifiedTriggerName = owner ? `${owner}.${triggerName}` : triggerName;
    const qualifiedTableName = tableOwner ? `${tableOwner}.${tableName}` : tableName;
    const normalizedWhenClause = whenClause ? `\nWHEN (${whenClause.replace(/^\((.*)\)$/s, '$1')})` : '';
    const normalizedTriggerType = triggerType.replace(/\s+/g, ' ').trim();
    const triggerTypeMatch = normalizedTriggerType.match(/^(BEFORE|AFTER|INSTEAD OF)(?:\s+(EACH ROW|STATEMENT))?$/i);
    if (triggerTypeMatch) {
        const timing = String(triggerTypeMatch[1] || '').toUpperCase();
        const firingLevel = String(triggerTypeMatch[2] || '').toUpperCase();
        const forEachRowClause = firingLevel === 'EACH ROW' ? '\nFOR EACH ROW' : '';
        return `CREATE OR REPLACE TRIGGER ${qualifiedTriggerName}\n${timing} ${triggeringEvent} ON ${qualifiedTableName}${forEachRowClause}${normalizedWhenClause}\n${triggerBody}`;
    }
    return `CREATE OR REPLACE TRIGGER ${qualifiedTriggerName}\n${triggerType} ${triggeringEvent} ON ${qualifiedTableName}${normalizedWhenClause}\n${triggerBody}`;
};

const TriggerViewer: React.FC<TriggerViewerProps> = ({ tab }) => {
    const { t } = useI18n();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [triggerDefinition, setTriggerDefinition] = useState<string>('');
    const [openingObjectEdit, setOpeningObjectEdit] = useState(false);
    const isMountedRef = useRef(true);
    const loadedDefinitionKeyRef = useRef('');
    const editorRef = useRef<any>(null);

    const connections = useStore(state => state.connections);
    const theme = useStore(state => state.theme);
    const addTab = useStore(state => state.addTab);
    const setActiveContext = useStore(state => state.setActiveContext);
    const darkMode = theme === 'dark';
    const objectIdentityKey = [
        tab.connectionId,
        tab.dbName,
        tab.type,
        tab.triggerName,
        tab.triggerTableName,
        tab.schemaName,
    ].map((item) => String(item || '')).join('||');

    // 透明 Monaco Editor 主题由 MonacoEditor 包装组件按需注册（含 stickyScroll 不透明背景）

    const escapeSQLLiteral = (raw: string): string => String(raw || '').replace(/'/g, "''");
    const parseSchemaAndName = (fullName: string, expectedParent = ''): { schema: string; name: string } => {
        const normalizedExpectedParent = String(expectedParent || '').trim();
        const parsed = normalizedExpectedParent
            ? splitMetadataQualifiedName(fullName, normalizedExpectedParent)
            : splitQualifiedNameLast(fullName);
        return {
            schema: parsed.parentPath || normalizedExpectedParent,
            name: parsed.objectName,
        };
    };

    const getMetadataDialect = (conn: any): string => {
        const type = String(conn?.config?.type || '').trim().toLowerCase();
        const dialect = resolveSqlDialect(
            type,
            String(conn?.config?.driver || '').trim(),
            { oceanBaseProtocol: conn?.config?.oceanBaseProtocol },
        );
        if (dialect === 'diros' || dialect === 'goldendb' || dialect === 'mariadb' || dialect === 'oceanbase' || dialect === 'sphinx') return 'mysql';
        if (dialect === 'dameng') return 'dm';
        return String(dialect || '').trim().toLowerCase();
    };

    const isSphinxConnection = (conn: any): boolean => {
        const type = String(conn?.config?.type || '').trim().toLowerCase();
        if (type === 'sphinx') return true;
        if (type !== 'custom') return false;
        const driver = String(conn?.config?.driver || '').trim().toLowerCase();
        return driver === 'sphinx' || driver === 'sphinxql';
    };

    const commentLine = (key: string, params?: Record<string, any>): string => `-- ${t(key, params)}`;

    const buildShowTriggerQueries = (
        dialect: string,
        triggerName: string,
        dbName: string,
        tableName = '',
        schemaName = '',
    ): string[] => {
        const schemaHint = String(schemaName || '').trim();
        const { schema, name } = parseSchemaAndName(triggerName, schemaHint);
        const safeTriggerName = escapeSQLLiteral(name);
        const safeDbName = escapeSQLLiteral(dbName);
        const parsedTable = splitMetadataQualifiedName(String(tableName || '').trim(), schemaHint || schema);
        const safeTableName = escapeSQLLiteral(parsedTable.objectName || tableName);
        const effectiveSchema = schema || parsedTable.parentPath || schemaHint;
        const safeSchemaName = escapeSQLLiteral(effectiveSchema);
        switch (dialect) {
            case 'mysql':
            case 'starrocks':
            {
                const triggerDatabaseName = String(effectiveSchema || dbName || '').trim();
                const safeTriggerDatabaseName = escapeSQLLiteral(triggerDatabaseName);
                const triggerRef = effectiveSchema
                    ? `\`${effectiveSchema.replace(/`/g, '``')}\`.\`${name.replace(/`/g, '``')}\``
                    : `\`${name.replace(/`/g, '``')}\``;
                return [
                    `SHOW CREATE TRIGGER ${triggerRef}`,
                    safeTriggerDatabaseName
                        ? `SELECT TRIGGER_NAME, TRIGGER_SCHEMA, EVENT_OBJECT_SCHEMA, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORIENTATION, ACTION_STATEMENT FROM information_schema.triggers WHERE trigger_schema = '${safeTriggerDatabaseName}' AND trigger_name = '${safeTriggerName}' LIMIT 1`
                        : '',
                    safeTriggerDatabaseName
                        ? `SHOW TRIGGERS FROM \`${triggerDatabaseName.replace(/`/g, '``')}\` LIKE '${safeTriggerName}'`
                        : `SHOW TRIGGERS LIKE '${safeTriggerName}'`,
                ].filter(Boolean);
            }
            case 'postgres':
            case 'kingbase':
            case 'highgo':
            case 'vastbase':
            case 'opengauss':
            case 'gaussdb':
                return [`SELECT pg_get_triggerdef(t.oid, true) AS trigger_definition
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE t.tgname = '${safeTriggerName}'
  AND NOT t.tgisinternal
${safeSchemaName ? `  AND n.nspname = '${safeSchemaName}'\n` : ''}${safeTableName ? `  AND c.relname = '${safeTableName}'\n` : ''}LIMIT 1`];
            case 'sqlserver': {
                const quoteSqlServerIdentifier = (value: string): string => `[${String(value || '').replace(/]/g, ']]')}]`;
                const sqlServerTriggerLookupName = effectiveSchema
                    ? `${quoteSqlServerIdentifier(effectiveSchema)}.${quoteSqlServerIdentifier(name)}`
                    : quoteSqlServerIdentifier(name);
                return buildSqlServerObjectDefinitionQueries(
                    'trigger',
                    sqlServerTriggerLookupName,
                    dbName,
                    'trigger_definition',
                );
            }
            case 'oracle':
                return [];
            case 'dm':
                if (schema) {
                    return [
                        `SELECT DBMS_METADATA.GET_DDL('TRIGGER', '${safeTriggerName.toUpperCase()}', '${escapeSQLLiteral(effectiveSchema).toUpperCase()}') AS trigger_definition FROM DUAL`,
                        `SELECT OWNER, TABLE_OWNER, TABLE_NAME, TRIGGER_NAME, TRIGGER_TYPE, TRIGGERING_EVENT, WHEN_CLAUSE, TRIGGER_BODY FROM ALL_TRIGGERS WHERE OWNER = '${escapeSQLLiteral(effectiveSchema).toUpperCase()}' AND TRIGGER_NAME = '${safeTriggerName.toUpperCase()}'`,
                    ];
                }
                if (!safeDbName) {
                    return [
                        `SELECT DBMS_METADATA.GET_DDL('TRIGGER', '${safeTriggerName.toUpperCase()}') AS trigger_definition FROM DUAL`,
                        `SELECT TABLE_NAME, TRIGGER_NAME, TRIGGER_TYPE, TRIGGERING_EVENT, WHEN_CLAUSE, TRIGGER_BODY FROM USER_TRIGGERS WHERE TRIGGER_NAME = '${safeTriggerName.toUpperCase()}'`,
                    ];
                }
                return [
                    `SELECT DBMS_METADATA.GET_DDL('TRIGGER', '${safeTriggerName.toUpperCase()}', '${safeDbName.toUpperCase()}') AS trigger_definition FROM DUAL`,
                    `SELECT OWNER, TABLE_OWNER, TABLE_NAME, TRIGGER_NAME, TRIGGER_TYPE, TRIGGERING_EVENT, WHEN_CLAUSE, TRIGGER_BODY FROM ALL_TRIGGERS WHERE OWNER = '${safeDbName.toUpperCase()}' AND TRIGGER_NAME = '${safeTriggerName.toUpperCase()}'`,
                ];
            case 'sqlite':
                return [`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = '${safeTriggerName}'`];
            case 'duckdb':
                return [commentLine('trigger_viewer.editor.unsupported.duckdb')];
            case 'tdengine':
                return [commentLine('trigger_viewer.editor.unsupported.tdengine')];
            case 'mongodb':
                return [commentLine('trigger_viewer.editor.unsupported.mongodb')];
            default:
                return [commentLine('trigger_viewer.editor.unsupported.generic')];
        }
    };

    const buildOracleTriggerTableLookupQuery = (
        triggerName: string,
        dbName: string,
        schemaName?: string,
    ): string => {
        const { schema, name } = parseSchemaAndName(triggerName, schemaName);
        const owner = String(schema || schemaName || dbName || '').trim();
        const safeName = escapeSQLLiteral(name);
        const upperName = safeName.toUpperCase();
        const namePredicate = safeName === upperName
            ? `TRIGGER_NAME = '${safeName}'`
            : `TRIGGER_NAME IN ('${safeName}', '${upperName}')`;
        if (!owner) {
            return `SELECT USER AS OWNER, TABLE_OWNER, TABLE_NAME, TRIGGER_NAME FROM USER_TRIGGERS WHERE ${namePredicate}`;
        }
        return `SELECT OWNER, TABLE_OWNER, TABLE_NAME, TRIGGER_NAME FROM ALL_TRIGGERS WHERE OWNER = '${escapeSQLLiteral(owner).toUpperCase()}' AND ${namePredicate}`;
    };

    const extractOracleTriggerTableName = (
        data: any[],
        triggerName: string,
        fallbackOwner: string,
    ): string => {
        const targetName = String(parseSchemaAndName(triggerName, fallbackOwner).name || triggerName || '').trim();
        const rows = Array.isArray(data)
            ? data.filter((row): row is Record<string, any> => Boolean(row) && typeof row === 'object')
            : [];
        const row = rows.find((candidate) => (
            String(getCaseInsensitiveRawValue(candidate, ['trigger_name', 'TRIGGER_NAME']) || '').trim() === targetName
        )) || rows.find((candidate) => (
            String(getCaseInsensitiveRawValue(candidate, ['trigger_name', 'TRIGGER_NAME']) || '').trim().toLowerCase() === targetName.toLowerCase()
        )) || rows[0];
        if (!row) return '';

        const tableName = String(getCaseInsensitiveRawValue(row, ['table_name', 'TABLE_NAME']) || '').trim();
        if (!tableName) return '';
        const tableOwner = String(
            getCaseInsensitiveRawValue(row, ['table_owner', 'TABLE_OWNER', 'owner', 'OWNER'])
            || fallbackOwner,
        ).trim();
        return tableOwner
            ? `${tableOwner}.${tableName}`
            : tableName;
    };

    const runQueryCandidates = async (
        config: Record<string, any>,
        dbName: string,
        queries: string[]
    ): Promise<{ success: boolean; data: any[]; message?: string }> => {
        let lastMessage = '';
        let hasSuccessfulQuery = false;
        for (const query of queries) {
            const sql = String(query || '').trim();
            if (!sql) continue;
            try {
                const result = await DBQuery(buildRpcConnectionConfig(config) as any, dbName, sql);
                if (!result.success || !Array.isArray(result.data)) {
                    lastMessage = result.message || lastMessage;
                    continue;
                }
                hasSuccessfulQuery = true;
                if (result.data.length > 0) {
                    return { success: true, data: result.data };
                }
            } catch (error: any) {
                lastMessage = error?.message || String(error);
            }
        }
        if (hasSuccessfulQuery) {
            return { success: true, data: [] };
        }
        return { success: false, data: [], message: lastMessage };
    };

    const getVersionHint = async (config: Record<string, any>, dbName: string): Promise<string> => {
        const candidates = [
            `SELECT VERSION() AS version`,
            `SHOW VARIABLES LIKE 'version'`,
        ];
        for (const query of candidates) {
            try {
                const result = await DBQuery(buildRpcConnectionConfig(config) as any, dbName, query);
                if (!result.success || !Array.isArray(result.data) || result.data.length === 0) {
                    continue;
                }
                const row = result.data[0] as Record<string, any>;
                const version =
                    row.version
                    || row.VERSION
                    || row.Value
                    || row.value
                    || Object.values(row)[1]
                    || Object.values(row)[0];
                const text = String(version || '').trim();
                if (text) return text;
            } catch {
                // ignore
            }
        }
        return '';
    };

    const extractTriggerDefinition = (dialect: string, data: any[], fallbackTriggerName: string, fallbackTableName: string): string => {
        if (!data || data.length === 0) {
            return commentLine('trigger_viewer.editor.definition_not_found');
        }

        const row = data[0] as Record<string, any>;

        switch (dialect) {
            case 'mysql':
            case 'starrocks': {
                // MySQL SHOW CREATE TRIGGER returns: Trigger, sql_mode, SQL Original Statement, ...
                const keys = Object.keys(row);
                const metadataDDL = buildMySQLTriggerDDLFromMetadata(row, fallbackTriggerName, fallbackTableName);
                if (row.trigger_definition || row.TRIGGER_DEFINITION) {
                    return String(row.trigger_definition || row.TRIGGER_DEFINITION);
                }
                if (metadataDDL) {
                    return metadataDDL;
                }
                if (row.ACTION_STATEMENT || row.action_statement) {
                    return String(row.ACTION_STATEMENT || row.action_statement);
                }
                const sqlKey = keys.find(k => k.toLowerCase().includes('statement') || k.toLowerCase() === 'sql original statement');
                if (sqlKey) return row[sqlKey];
                // Fallback: try to find any key containing CREATE TRIGGER
                for (const key of keys) {
                    const val = String(row[key] || '');
                    if (val.toUpperCase().includes('CREATE TRIGGER')) {
                        return val;
                    }
                }
                return JSON.stringify(row, null, 2);
            }
            case 'postgres':
            case 'kingbase':
            case 'highgo':
            case 'vastbase':
            case 'opengauss':
            case 'gaussdb': {
                return row.trigger_definition || row.TRIGGER_DEFINITION || Object.values(row)[0] || '';
            }
            case 'sqlserver': {
                const directDefinition = getCaseInsensitiveRawValue(row, ['trigger_definition', 'definition']);
                if (directDefinition !== undefined && directDefinition !== null && String(directDefinition).trim() !== '') {
                    return String(directDefinition);
                }
                const helpTextDefinition = data
                    .map((item) => getCaseInsensitiveRawValue(item, ['Text', 'text']))
                    .filter((value) => value !== undefined && value !== null)
                    .map((value) => String(value))
                    .join('');
                if (helpTextDefinition.trim()) return helpTextDefinition;
                return Object.values(row)[0] || '';
            }
            case 'oracle':
            case 'dm': {
                const ddl = String(row.trigger_definition || row.TRIGGER_DEFINITION || '').trim();
                if (ddl) {
                    return ddl;
                }
                const metadataDDL = buildOracleLikeTriggerDDLFromMetadata(row, fallbackTriggerName, fallbackTableName);
                if (metadataDDL) {
                    return metadataDDL;
                }
                return row.trigger_body || row.TRIGGER_BODY || Object.values(row)[0] || '';
            }
            case 'sqlite': {
                return row.sql || row.SQL || Object.values(row)[0] || '';
            }
            default:
                return JSON.stringify(row, null, 2);
        }
    };

    const loadTriggerDefinition = async (): Promise<{ success: boolean; definition?: string; error?: string }> => {
        const conn = connections.find(c => c.id === tab.connectionId);
        if (!conn) {
            return { success: false, error: t('trigger_viewer.error.connection_not_found') };
        }

        const triggerName = tab.triggerName || '';
        const dbName = tab.dbName || '';

        if (!triggerName) {
            return { success: false, error: t('trigger_viewer.error.trigger_name_empty') };
        }

        const dialect = getMetadataDialect(conn);
        const queries = buildShowTriggerQueries(
            dialect,
            triggerName,
            dbName,
            String(tab.triggerTableName || ''),
            String(tab.schemaName || ''),
        );
        const sphinxLike = isSphinxConnection(conn) && dialect === 'mysql';

        if (dialect !== 'oracle' && (!queries.length || String(queries[0] || '').startsWith('--'))) {
            return { success: true, definition: String(queries[0] || commentLine('trigger_viewer.editor.unsupported.generic')) };
        }

        try {
            const config = {
                ...conn.config,
                port: Number(conn.config.port),
                password: conn.config.password || '',
                database: conn.config.database || '',
                useSSH: conn.config.useSSH || false,
                ssh: conn.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' }
            };

            let triggerTableName = String(tab.triggerTableName || '').trim();
            if (dialect === 'oracle') {
                if (!triggerTableName) {
                    const parsedTrigger = parseSchemaAndName(triggerName, tab.schemaName);
                    const fallbackOwner = String(parsedTrigger.schema || tab.schemaName || dbName || '').trim();
                    const tableLookup = await runQueryCandidates(config, dbName, [
                        buildOracleTriggerTableLookupQuery(triggerName, dbName, tab.schemaName),
                    ]);
                    if (!tableLookup.success) {
                        return {
                            success: false,
                            error: tableLookup.message || t('trigger_viewer.error.query_failed'),
                        };
                    }
                    triggerTableName = extractOracleTriggerTableName(
                        tableLookup.data,
                        triggerName,
                        fallbackOwner,
                    );
                }
                if (!triggerTableName) {
                    return {
                        success: true,
                        definition: commentLine('trigger_viewer.editor.definition_not_found'),
                    };
                }
                const result = await DBGetTriggers(
                    buildRpcConnectionConfig(config) as any,
                    dbName,
                    triggerTableName,
                );
                if (!result.success) {
                    return {
                        success: false,
                        error: result.message || t('trigger_viewer.error.query_failed'),
                    };
                }
                const definition = findTriggerDefinitionStatement(result.data, triggerName);
                return {
                    success: true,
                    definition: definition || commentLine('trigger_viewer.editor.definition_not_found'),
                };
            }

            const result = await runQueryCandidates(config, dbName, queries);

            if (result.success && Array.isArray(result.data) && result.data.length > 0) {
                return {
                    success: true,
                    definition: extractTriggerDefinition(dialect, result.data, triggerName, String(tab.triggerTableName || '')),
                };
            }

            if (result.success) {
                if (sphinxLike) {
                    const version = await getVersionHint(config, dbName);
                    const versionText = version ? t('trigger_viewer.editor.sphinx.version_suffix', { version }) : '';
                    return {
                        success: true,
                        definition: [
                            commentLine('trigger_viewer.editor.sphinx.empty_result', { version: versionText }),
                            commentLine('trigger_viewer.editor.sphinx.compat_queries_hint'),
                        ].join('\n'),
                    };
                }
                return { success: true, definition: commentLine('trigger_viewer.editor.definition_not_found') };
            }

            if (sphinxLike) {
                const version = await getVersionHint(config, dbName);
                const versionText = version ? t('trigger_viewer.editor.sphinx.version_suffix', { version }) : '';
                const failedMessage = result.message
                    ? `${t('trigger_viewer.editor.sphinx.failed_message_label')}: ${result.message}`
                    : t('trigger_viewer.editor.sphinx.failed_message_unknown');
                return {
                    success: true,
                    definition: [
                        commentLine('trigger_viewer.editor.sphinx.unsupported_query', { version: versionText }),
                        commentLine('trigger_viewer.editor.sphinx.compat_queries_hint'),
                        `-- ${failedMessage}`,
                    ].join('\n'),
                };
            }

            return {
                success: false,
                error: result.message
                    ? t('trigger_viewer.error.query_failed_detail', { detail: result.message })
                    : t('trigger_viewer.error.query_failed'),
            };
        } catch (e: any) {
            return { success: false, error: t('trigger_viewer.error.query_failed_detail', { detail: e?.message || String(e) }) };
        }
    };

    useEffect(() => {
        let cancelled = false;
        const syncTriggerDefinition = async () => {
            setLoading(true);
            setError(null);
            const result = await loadTriggerDefinition();
            if (cancelled) {
                return;
            }
            if (result.success) {
                loadedDefinitionKeyRef.current = objectIdentityKey;
                setTriggerDefinition(String(result.definition || ''));
            } else {
                setError(result.error || t('trigger_viewer.error.query_failed'));
            }
            setLoading(false);
        };

        syncTriggerDefinition();

        return () => {
            cancelled = true;
        };
    }, [tab.connectionId, tab.dbName, tab.triggerName, connections, objectIdentityKey, t]);

    useEffect(() => () => {
        isMountedRef.current = false;
    }, []);

    const displayedDefinition = loadedDefinitionKeyRef.current === objectIdentityKey ? triggerDefinition : '';
    const hasDefinition = String(displayedDefinition || '').trim() !== '';
    const editorModelPath = `gonavi-trigger://${encodeURIComponent(objectIdentityKey)}`;

    const refreshEditorLayout = useCallback(() => {
        const editor = editorRef.current;
        if (!editor) {
            return;
        }

        const run = () => {
            editor.layout?.();
            editor.render?.();
            editor.setScrollTop?.(0);
            editor.setScrollLeft?.(0);
        };

        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => run());
            return;
        }

        setTimeout(run, 0);
    }, []);

    const handleEditorMount = useCallback((editor: any) => {
        editorRef.current = editor;
        refreshEditorLayout();
    }, [refreshEditorLayout]);

    useEffect(() => {
        if (!displayedDefinition) {
            return;
        }
        refreshEditorLayout();
    }, [displayedDefinition, refreshEditorLayout]);

    useEffect(() => () => {
        editorRef.current = null;
    }, []);

    if (loading) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
                <Spin tip={t('trigger_viewer.loading.definition')} />
            </div>
        );
    }

    if (error && !hasDefinition) {
        return (
            <div style={{ padding: 16 }}>
                <Alert type="error" message={t('trigger_viewer.error.load_failed')} description={error} showIcon />
            </div>
        );
    }

    const triggerName = String(tab.triggerName || '').trim();
    const dbName = String(tab.dbName || '').trim();
    const schemaName = String(tab.schemaName || '').trim();
    const openObjectEditQuery = async () => {
        if (!triggerName || openingObjectEdit) return;
        setOpeningObjectEdit(true);
        setError(null);
        try {
            const result = await loadTriggerDefinition();
            if (!isMountedRef.current) {
                return;
            }
            if (!result.success) {
                setError(result.error || t('trigger_viewer.error.query_failed'));
                return;
            }
            const latestDefinition = String(result.definition || '');
            const conn = connections.find((item) => item.id === tab.connectionId);
            const dialect = conn ? getMetadataDialect(conn) : '';
            const triggerTableName = String(tab.triggerTableName || '').trim();
            const triggerRollbackSql = buildTableDesignerTriggerRestoreSql(
                { name: triggerName, statement: latestDefinition },
                triggerTableName,
                dialect,
                tab.schemaName,
            );
            const triggerDropSql = shouldDropTableDesignerTriggerBeforeReplace(triggerRollbackSql, dialect)
                ? buildTableDesignerTriggerDropSql(triggerName, triggerTableName, dialect, tab.schemaName)
                : '';
            loadedDefinitionKeyRef.current = objectIdentityKey;
            setTriggerDefinition(latestDefinition);
            setActiveContext({
                connectionId: tab.connectionId,
                dbName,
                schemaName: schemaName || undefined,
            });
            addTab({
                id: `query-edit-trigger-${tab.connectionId}-${dbName}-${Date.now()}`,
                title: t('trigger_viewer.tab.edit_trigger_title', { name: triggerName }),
                type: 'query',
                connectionId: tab.connectionId,
                dbName,
                schemaName: schemaName || undefined,
                query: buildEditableTriggerSql(triggerName, latestDefinition, {
                    dropSql: triggerDropSql,
                    dbType: dialect,
                    translate: t,
                }),
                triggerName,
                triggerTableName: triggerTableName || undefined,
                triggerRollbackSql: triggerRollbackSql || undefined,
                queryMode: 'object-edit',
            });
        } finally {
            if (isMountedRef.current) {
                setOpeningObjectEdit(false);
            }
        }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ padding: '8px 16px', borderBottom: darkMode ? '1px solid #303030' : '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <strong>{t('trigger_viewer.field.trigger')}: </strong>{tab.triggerName}
                    {tab.dbName && <span style={{ marginLeft: 16, color: '#888' }}>{t('trigger_viewer.field.database')}: {tab.dbName}</span>}
                </div>
                <Button size="small" icon={<EditOutlined />} onClick={openObjectEditQuery} disabled={!triggerName} loading={openingObjectEdit}>
                    {t('trigger_viewer.action.edit_object')}
                </Button>
            </div>
            {error && hasDefinition && (
                <div style={{ padding: '8px 16px 0' }}>
                    <Alert type="warning" message={t('trigger_viewer.warning.refresh_latest_failed')} description={error} showIcon />
                </div>
            )}
            <div style={{ flex: 1, minHeight: 0 }}>
                <Editor
                    path={editorModelPath}
                    height="100%"
                    language="sql"
                    theme={darkMode ? 'transparent-dark' : 'transparent-light'}
                    value={displayedDefinition}
                    onMount={handleEditorMount}
                    options={{
                        readOnly: true,
                        minimap: { enabled: false },
                        fontSize: 14,
                        lineHeight: 24,
                        lineNumbers: 'on',
                        lineNumbersMinChars: 4,
                        stickyScroll: { enabled: false },
                        scrollBeyondLastLine: false,
                        wordWrap: 'on',
                        automaticLayout: true,
                    }}
                />
            </div>
        </div>
    );
};

export default TriggerViewer;
