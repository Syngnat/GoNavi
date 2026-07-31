import React, { useState, useEffect, useRef, useCallback } from 'react';
import Editor from './MonacoEditor';
import { Button, Spin, Alert } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { TabData } from '../types';
import { useStore } from '../store';
import { DBQuery, DBShowCreateTable } from '../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { normalizeOceanBaseProtocol } from '../utils/oceanBaseProtocol';
import { useI18n } from '../i18n/provider';
import { splitQualifiedNameLast } from '../utils/qualifiedName';
import { buildSqlServerObjectDefinitionQueries } from '../utils/sqlServerObjectDefinition';
import { clearQueryTabDraft } from '../utils/sqlFileTabDrafts';
import { formatDdlForDisplay } from '../utils/ddlFormat';

interface DefinitionViewerProps {
    tab: TabData;
}

const normalizeMySQLViewDDL = (rawDefinition: unknown): string => {
    const text = String(rawDefinition || '').trim();
    if (!text) return '';

    const normalized = text.replace(/\r\n/g, '\n').trim().replace(/;+\s*$/, '');
    const createViewPrefixPattern = /^\s*create\s+(?:algorithm\s*=\s*\w+\s+)?(?:definer\s*=\s*(?:`[^`]+`|\S+)\s*@\s*(?:`[^`]+`|\S+)\s+)?(?:sql\s+security\s+(?:definer|invoker)\s+)?view\s+/i;
    if (createViewPrefixPattern.test(normalized)) {
        return `${normalized.replace(createViewPrefixPattern, 'CREATE OR REPLACE VIEW ')};`;
    }

    if (/^\s*(select|with)\b/i.test(normalized)) {
        return normalized;
    }

    return `${normalized};`;
};

const normalizeSqlPlusSlashTerminator = (sql: string): string => (
    String(sql || '').trim().replace(/(^|\n)([ \t]*\/[ \t]*);+([ \t]*(?:--[^\n]*)?)\s*$/i, '$1$2$3')
);

const hasStandaloneSqlPlusSlashTerminator = (sql: string): boolean => (
    /(?:^|\n)[ \t]*\/[ \t]*(?:--[^\n]*)?\s*$/i.test(String(sql || '').trim())
);

const ensureSqlStatementTerminator = (sql: string): string => {
    const normalized = normalizeSqlPlusSlashTerminator(sql);
    if (!normalized) return '';
    if (hasStandaloneSqlPlusSlashTerminator(normalized)) return normalized;
    return /;\s*$/.test(normalized) ? normalized : `${normalized};`;
};

const isCommentOnlyDefinition = (definition: string): boolean => {
    const normalized = String(definition || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) return false;
    const lines = normalized
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    return lines.length > 0 && lines.every((line) => line.startsWith('--'));
};

const withCreateOrReplacePackageHeaders = (definition: string): string => {
    const normalized = String(definition || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) return '';
    return normalized
        .split(/(?=^\s*PACKAGE(?:\s+BODY)?\b)/gim)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => (/^\s*CREATE\b/i.test(part) ? part : `CREATE OR REPLACE ${part}`))
        .join('\n/\n');
};

const buildEditableDefinitionSql = (
    tab: TabData,
    definition: string,
    objectName: string,
    copy: {
        commentTitle: string;
        compatibilityHint: string;
        emptyDefinitionHint: string;
    },
): string => {
    const normalizedDefinition = String(definition || '').trim();
    const header = `-- ${copy.commentTitle}\n-- ${copy.compatibilityHint}\n`;
    if (!normalizedDefinition) {
        return `${header}-- ${copy.emptyDefinitionHint}\n`;
    }

    if (isCommentOnlyDefinition(normalizedDefinition)) {
        return `${header}${ensureSqlStatementTerminator(normalizedDefinition)}`;
    }

    if (tab.type === 'view-def' && !/^\s*create\b/i.test(normalizedDefinition)) {
        if (/^\s*view\b/i.test(normalizedDefinition)) {
            return `${header}${ensureSqlStatementTerminator(normalizedDefinition.replace(/^\s*view\b/i, 'CREATE OR REPLACE VIEW'))}`;
        }
        return `${header}CREATE OR REPLACE VIEW ${objectName} AS\n${ensureSqlStatementTerminator(normalizedDefinition)}`;
    }

    if (tab.type === 'sequence-def' && !/^\s*create\b/i.test(normalizedDefinition)) {
        return `${header}${ensureSqlStatementTerminator(`CREATE SEQUENCE ${objectName}\n${normalizedDefinition}`)}`;
    }

    if (
        tab.type === 'package-def'
        && !/^\s*create\b/i.test(normalizedDefinition)
        && /^\s*package\b/i.test(normalizedDefinition)
    ) {
        return `${header}${withCreateOrReplacePackageHeaders(normalizedDefinition)}`;
    }

    if (
        tab.type === 'routine-def'
        && !/^\s*create\b/i.test(normalizedDefinition)
        && /^\s*(function|procedure)\b/i.test(normalizedDefinition)
    ) {
        return `${header}${ensureSqlStatementTerminator(`CREATE OR REPLACE ${normalizedDefinition}`)}`;
    }

    return `${header}${ensureSqlStatementTerminator(normalizedDefinition)}`;
};

const buildDisplayDefinitionSql = (
    tab: TabData,
    definition: string,
    objectName: string,
): string => {
    const normalizedDefinition = String(definition || '').trim();
    if (!normalizedDefinition || isCommentOnlyDefinition(normalizedDefinition)) {
        return normalizedDefinition;
    }

    if (tab.type === 'view-def' && !/^\s*create\b/i.test(normalizedDefinition)) {
        if (/^\s*view\b/i.test(normalizedDefinition)) {
            return ensureSqlStatementTerminator(normalizedDefinition.replace(/^\s*view\b/i, 'CREATE OR REPLACE VIEW'));
        }
        return `CREATE OR REPLACE VIEW ${objectName} AS\n${ensureSqlStatementTerminator(normalizedDefinition)}`;
    }

    if (tab.type === 'sequence-def' && !/^\s*create\b/i.test(normalizedDefinition)) {
        return ensureSqlStatementTerminator(`CREATE SEQUENCE ${objectName}\n${normalizedDefinition}`);
    }

    if (
        tab.type === 'package-def'
        && !/^\s*create\b/i.test(normalizedDefinition)
        && /^\s*package\b/i.test(normalizedDefinition)
    ) {
        return withCreateOrReplacePackageHeaders(normalizedDefinition);
    }

    if (
        tab.type === 'routine-def'
        && !/^\s*create\b/i.test(normalizedDefinition)
        && /^\s*(function|procedure)\b/i.test(normalizedDefinition)
    ) {
        return ensureSqlStatementTerminator(`CREATE OR REPLACE ${normalizedDefinition}`);
    }

    return ensureSqlStatementTerminator(normalizedDefinition);
};

const DefinitionViewer: React.FC<DefinitionViewerProps> = ({ tab }) => {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [definition, setDefinition] = useState<string>('');
    const [openingObjectEdit, setOpeningObjectEdit] = useState(false);
    const isMountedRef = useRef(true);
    const loadedDefinitionKeyRef = useRef('');
    const editorRef = useRef<any>(null);

    const connections = useStore(state => state.connections);
    const theme = useStore(state => state.theme);
    const addTab = useStore(state => state.addTab);
    const setActiveContext = useStore(state => state.setActiveContext);
    const darkMode = theme === 'dark';
    const { t } = useI18n();
    const objectIdentityKey = [
        tab.connectionId,
        tab.dbName,
        tab.type,
        tab.viewName,
        tab.viewKind,
        tab.eventName,
        tab.routineName,
        tab.routineType,
        tab.sequenceName,
        tab.packageName,
    ].map((item) => String(item || '')).join('||');

    const escapeSQLLiteral = (raw: string): string => String(raw || '').replace(/'/g, "''");

    const getMetadataDialect = (conn: any): string => {
        const type = String(conn?.config?.type || '').trim().toLowerCase();
        if (type === 'custom') {
            const driver = String(conn?.config?.driver || '').trim().toLowerCase();
            if (driver === 'diros' || driver === 'doris') return 'mysql';
            if (driver === 'goldendb' || driver === 'greatdb' || driver === 'gdb') return 'mysql';
            if (driver === 'oceanbase') return normalizeOceanBaseProtocol(conn?.config?.oceanBaseProtocol) === 'oracle' ? 'oracle' : 'mysql';
            if (driver === 'opengauss' || driver === 'open_gauss' || driver === 'open-gauss') return 'opengauss';
            if (driver === 'gaussdb' || driver === 'gauss_db' || driver === 'gauss-db') return 'gaussdb';
            return driver;
        }
        if (type === 'oceanbase' && normalizeOceanBaseProtocol(conn?.config?.oceanBaseProtocol) === 'oracle') return 'oracle';
        if (type === 'goldendb' || type === 'mariadb' || type === 'oceanbase' || type === 'diros' || type === 'sphinx') return 'mysql';
        if (type === 'dameng') return 'dm';
        return type;
    };

    const isSphinxConnection = (conn: any): boolean => {
        const type = String(conn?.config?.type || '').trim().toLowerCase();
        if (type === 'sphinx') return true;
        if (type !== 'custom') return false;
        const driver = String(conn?.config?.driver || '').trim().toLowerCase();
        return driver === 'sphinx' || driver === 'sphinxql';
    };

    const parseSchemaAndName = (fullName: string): { schema: string; name: string } => {
        const parsed = splitQualifiedNameLast(fullName);
        return { schema: parsed.parentPath, name: parsed.objectName };
    };

    const getCaseInsensitiveRawValue = (row: Record<string, any>, candidateKeys: string[]): any => {
        const keyMap = new Map<string, any>();
        Object.keys(row || {}).forEach((key) => keyMap.set(key.toLowerCase(), row[key]));
        for (const key of candidateKeys) {
            const value = keyMap.get(key.toLowerCase());
            if (value !== undefined && value !== null) {
                return value;
            }
        }
        return undefined;
    };

    const parseDuckDBParameterNames = (raw: any): string[] => {
        if (Array.isArray(raw)) {
            return raw
                .map((item) => String(item ?? '').trim())
                .filter((item) => item !== '' && item.toLowerCase() !== '<nil>');
        }
        const text = String(raw ?? '').trim();
        if (!text) return [];
        const normalized = text.startsWith('[') && text.endsWith(']')
            ? text.slice(1, -1)
            : text;
        return normalized
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part !== '' && part.toLowerCase() !== '<nil>');
    };

    const buildDuckDBMacroDDL = (
        schemaName: string,
        functionName: string,
        parametersRaw: any,
        macroDefinitionRaw: any
    ): string => {
        const schema = String(schemaName || '').trim();
        const name = String(functionName || '').trim();
        const macroDefinition = String(macroDefinitionRaw || '').trim();
        if (!name || !macroDefinition) return '';

        const parameters = parseDuckDBParameterNames(parametersRaw).join(', ');
        const qualifiedName = schema ? `${schema}.${name}` : name;
        const isTableMacro = !macroDefinition.startsWith('(');
        if (isTableMacro) {
            return `CREATE OR REPLACE MACRO ${qualifiedName}(${parameters}) AS TABLE ${macroDefinition};`;
        }
        return `CREATE OR REPLACE MACRO ${qualifiedName}(${parameters}) AS ${macroDefinition};`;
    };

    const buildShowViewQueries = (dialect: string, viewName: string, dbName: string, viewKind?: string): string[] => {
        const { schema, name } = parseSchemaAndName(viewName);
        const safeName = escapeSQLLiteral(name);
        const safeDbName = escapeSQLLiteral(dbName);

        switch (dialect) {
            case 'mysql':
            case 'starrocks':
                if (dialect === 'starrocks' && viewKind === 'materialized') {
                    const mvRef = schema
                        ? `\`${schema.replace(/`/g, '``')}\`.\`${name.replace(/`/g, '``')}\``
                        : `\`${name.replace(/`/g, '``')}\``;
                    return [
                        `SHOW CREATE MATERIALIZED VIEW ${mvRef}`,
                        `SHOW CREATE TABLE ${mvRef}`,
                    ];
                }
                return [
                    `SHOW CREATE VIEW \`${name.replace(/`/g, '``')}\``,
                    safeDbName
                        ? `SELECT VIEW_DEFINITION AS view_definition FROM information_schema.views WHERE table_schema = '${safeDbName}' AND table_name = '${safeName}' LIMIT 1`
                        : '',
                    `SHOW CREATE TABLE \`${name.replace(/`/g, '``')}\``,
                ].filter(Boolean);
            case 'postgres':
            case 'kingbase':
            case 'highgo':
            case 'vastbase':
            case 'opengauss':
            case 'gaussdb': {
                const schemaRef = schema || 'public';
                return [`SELECT pg_get_viewdef('${escapeSQLLiteral(schemaRef)}.${safeName}'::regclass, true) AS view_definition`];
            }
            case 'sqlserver':
                return buildSqlServerObjectDefinitionQueries('view', viewName, dbName, 'view_definition');
            case 'oracle':
            case 'dm':
                if (schema) {
                    return [`SELECT TEXT AS view_definition FROM ALL_VIEWS WHERE OWNER = '${escapeSQLLiteral(schema).toUpperCase()}' AND VIEW_NAME = '${safeName.toUpperCase()}'`];
                }
                if (safeDbName) {
                    return [`SELECT TEXT AS view_definition FROM ALL_VIEWS WHERE OWNER = '${safeDbName.toUpperCase()}' AND VIEW_NAME = '${safeName.toUpperCase()}'`];
                }
                return [`SELECT TEXT AS view_definition FROM USER_VIEWS WHERE VIEW_NAME = '${safeName.toUpperCase()}'`];
            case 'sqlite':
                return [`SELECT sql AS view_definition FROM sqlite_master WHERE type='view' AND name='${safeName}'`];
            case 'duckdb': {
                const schemaRef = schema || 'main';
                return [`SELECT view_definition FROM information_schema.views WHERE table_schema = '${escapeSQLLiteral(schemaRef)}' AND table_name = '${safeName}' LIMIT 1`];
            }
            default:
                return [`-- ${t('definition_viewer.editor.unsupported_view_definition')}`];
        }
    };

    const buildShowRoutineQueries = (dialect: string, routineName: string, routineType: string, dbName: string): string[] => {
        const { schema, name } = parseSchemaAndName(routineName);
        const safeName = escapeSQLLiteral(name);
        const safeDbName = escapeSQLLiteral(dbName);
        const upperType = (routineType || 'FUNCTION').toUpperCase();

        switch (dialect) {
            case 'mysql':
            case 'starrocks':
                return [
                    `SHOW CREATE ${upperType} \`${name.replace(/`/g, '``')}\``,
                    safeDbName
                        ? `SELECT ROUTINE_DEFINITION AS routine_definition, ROUTINE_TYPE AS routine_type FROM information_schema.routines WHERE routine_schema = '${safeDbName}' AND routine_name = '${safeName}' LIMIT 1`
                        : '',
                    upperType === 'PROCEDURE'
                        ? `SHOW PROCEDURE STATUS LIKE '${safeName}'`
                        : `SHOW FUNCTION STATUS LIKE '${safeName}'`,
                ].filter(Boolean);
            case 'postgres':
            case 'kingbase':
            case 'highgo':
            case 'vastbase':
            case 'opengauss':
            case 'gaussdb': {
                const schemaRef = schema || 'public';
                return [`SELECT pg_get_functiondef(p.oid) AS routine_definition FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = '${escapeSQLLiteral(schemaRef)}' AND p.proname = '${safeName}' LIMIT 1`];
            }
            case 'sqlserver':
                return buildSqlServerObjectDefinitionQueries('routine', routineName, dbName, 'routine_definition');
            case 'oracle':
            case 'dm': {
                const owner = schema ? escapeSQLLiteral(schema).toUpperCase() : (safeDbName ? safeDbName.toUpperCase() : '');
                if (owner) {
                    return [`SELECT TEXT FROM ALL_SOURCE WHERE OWNER = '${owner}' AND NAME = '${safeName.toUpperCase()}' AND TYPE = '${upperType}' ORDER BY LINE`];
                }
                return [`SELECT TEXT FROM USER_SOURCE WHERE NAME = '${safeName.toUpperCase()}' AND TYPE = '${upperType}' ORDER BY LINE`];
            }
            case 'duckdb': {
                const schemaRef = schema || 'main';
                const safeSchema = escapeSQLLiteral(schemaRef);
                return [
                    `SELECT schema_name, function_name, parameters, macro_definition FROM duckdb_functions() WHERE internal = false AND lower(function_type) = 'macro' AND schema_name = '${safeSchema}' AND function_name = '${safeName}' LIMIT 1`,
                    `SELECT schema_name, function_name, parameters, macro_definition FROM duckdb_functions() WHERE internal = false AND lower(function_type) = 'macro' AND function_name = '${safeName}' ORDER BY CASE WHEN schema_name = '${safeSchema}' THEN 0 ELSE 1 END, schema_name LIMIT 1`,
                ];
            }
            case 'sqlite':
                return [`-- ${t('definition_viewer.editor.unsupported_sqlite_routine_definition')}`];
            default:
                return [`-- ${t('definition_viewer.editor.unsupported_routine_definition')}`];
        }
    };

    const buildShowEventQueries = (dialect: string, eventName: string, dbName: string): string[] => {
        const { schema, name } = parseSchemaAndName(eventName);
        const safeName = escapeSQLLiteral(name);
        const safeSchema = escapeSQLLiteral(schema || dbName);
        const eventRef = schema
            ? `\`${schema.replace(/`/g, '``')}\`.\`${name.replace(/`/g, '``')}\``
            : `\`${name.replace(/`/g, '``')}\``;

        switch (dialect) {
            case 'mysql':
                return [
                    `SHOW CREATE EVENT ${eventRef}`,
                    safeSchema
                        ? `SELECT EVENT_SCHEMA AS schema_name, EVENT_NAME AS event_name, EVENT_DEFINITION AS event_definition, EVENT_TYPE AS event_type, EXECUTE_AT AS execute_at, INTERVAL_VALUE AS interval_value, INTERVAL_FIELD AS interval_field, STARTS AS starts, ENDS AS ends, STATUS AS status, ON_COMPLETION AS on_completion, EVENT_COMMENT AS event_comment FROM information_schema.events WHERE event_schema = '${safeSchema}' AND event_name = '${safeName}' LIMIT 1`
                        : '',
                ].filter(Boolean);
            default:
                return [`-- ${t('definition_viewer.editor.unsupported_event_definition')}`];
        }
    };

    const buildShowSequenceQueries = (dialect: string, sequenceName: string, dbName: string): string[] => {
        const { schema, name } = parseSchemaAndName(sequenceName);
        const safeName = escapeSQLLiteral(name);
        const safeDbName = escapeSQLLiteral(dbName);
        const owner = schema ? escapeSQLLiteral(schema).toUpperCase() : (safeDbName ? safeDbName.toUpperCase() : '');

        switch (dialect) {
            case 'oracle':
            case 'dm':
                if (owner) {
                    return [`SELECT SEQUENCE_OWNER, SEQUENCE_NAME, MIN_VALUE, MAX_VALUE, INCREMENT_BY, CYCLE_FLAG, ORDER_FLAG, CACHE_SIZE, LAST_NUMBER FROM ALL_SEQUENCES WHERE SEQUENCE_OWNER = '${owner}' AND SEQUENCE_NAME = '${safeName.toUpperCase()}'`];
                }
                return [`SELECT SEQUENCE_NAME, MIN_VALUE, MAX_VALUE, INCREMENT_BY, CYCLE_FLAG, ORDER_FLAG, CACHE_SIZE, LAST_NUMBER FROM USER_SEQUENCES WHERE SEQUENCE_NAME = '${safeName.toUpperCase()}'`];
            case 'postgres':
            case 'kingbase':
            case 'highgo':
            case 'vastbase':
            case 'opengauss':
            case 'gaussdb': {
                const schemaRef = schema || 'public';
                return [`SELECT sequence_schema, sequence_name, data_type, start_value, minimum_value, maximum_value, increment FROM information_schema.sequences WHERE sequence_schema = '${escapeSQLLiteral(schemaRef)}' AND sequence_name = '${safeName}' LIMIT 1`];
            }
            default:
                return [`-- ${t('definition_viewer.editor.unsupported_sequence_definition')}`];
        }
    };

    const buildShowPackageQueries = (dialect: string, packageName: string, dbName: string): string[] => {
        const { schema, name } = parseSchemaAndName(packageName);
        const safeName = escapeSQLLiteral(name);
        const safeDbName = escapeSQLLiteral(dbName);

        switch (dialect) {
            case 'oracle':
            case 'dm': {
                const owner = schema ? escapeSQLLiteral(schema).toUpperCase() : (safeDbName ? safeDbName.toUpperCase() : '');
                if (owner) {
                    return [
                        `SELECT TEXT FROM ALL_SOURCE WHERE OWNER = '${owner}' AND NAME = '${safeName.toUpperCase()}' AND TYPE = 'PACKAGE' ORDER BY LINE`,
                        `SELECT TEXT FROM ALL_SOURCE WHERE OWNER = '${owner}' AND NAME = '${safeName.toUpperCase()}' AND TYPE = 'PACKAGE BODY' ORDER BY LINE`,
                    ];
                }
                return [
                    `SELECT TEXT FROM USER_SOURCE WHERE NAME = '${safeName.toUpperCase()}' AND TYPE = 'PACKAGE' ORDER BY LINE`,
                    `SELECT TEXT FROM USER_SOURCE WHERE NAME = '${safeName.toUpperCase()}' AND TYPE = 'PACKAGE BODY' ORDER BY LINE`,
                ];
            }
            default:
                return [`-- ${t('definition_viewer.editor.unsupported_package_definition')}`];
        }
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

    const runQueryCandidatesCollectAll = async (
        config: Record<string, any>,
        dbName: string,
        queries: string[]
    ): Promise<{ success: boolean; data: any[]; message?: string }> => {
        let lastMessage = '';
        let hasSuccessfulQuery = false;
        const data: any[] = [];
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
                data.push(...result.data);
            } catch (error: any) {
                lastMessage = error?.message || String(error);
            }
        }
        if (hasSuccessfulQuery) {
            return { success: true, data };
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

    const extractViewDefinition = (dialect: string, data: any[]): string => {
        if (!data || data.length === 0) return `-- ${t('definition_viewer.editor.view_definition_not_found')}`;
        const row = data[0];

        switch (dialect) {
            case 'mysql':
            case 'starrocks': {
                const keys = Object.keys(row);
                const textDefinition = row.view_definition || row.VIEW_DEFINITION;
                if (textDefinition) return normalizeMySQLViewDDL(textDefinition);
                const sqlKey = keys.find(k => k.toLowerCase().includes('create view') || k.toLowerCase() === 'create view');
                if (sqlKey) return normalizeMySQLViewDDL(row[sqlKey]);
                const tableSqlKey = keys.find(k => k.toLowerCase().includes('create table'));
                if (tableSqlKey) return normalizeMySQLViewDDL(row[tableSqlKey]);
                for (const key of keys) {
                    const val = String(row[key] || '');
                    if (val.toUpperCase().includes('CREATE') && (val.toUpperCase().includes('VIEW') || val.toUpperCase().includes('TABLE'))) {
                        return normalizeMySQLViewDDL(val);
                    }
                }
                return JSON.stringify(row, null, 2);
            }
            case 'oracle':
            case 'dm':
                return row.view_definition || row.VIEW_DEFINITION || row.text || row.TEXT || Object.values(row)[0] || '';
            case 'sqlserver': {
                const directDefinition = getCaseInsensitiveRawValue(row, ['view_definition', 'definition']);
                if (directDefinition !== undefined && directDefinition !== null && String(directDefinition).trim() !== '') {
                    return String(directDefinition);
                }
                const helpTextDefinition = data
                    .map((item) => getCaseInsensitiveRawValue(item, ['Text', 'text']))
                    .filter((value) => value !== undefined && value !== null)
                    .map((value) => String(value))
                    .join('');
                if (helpTextDefinition.trim()) return helpTextDefinition;
                return String(Object.values(row)[0] || '');
            }
            default:
                return row.view_definition || row.VIEW_DEFINITION || row.sql || row.SQL || Object.values(row)[0] || '';
        }
    };

    const extractRoutineDefinition = (dialect: string, data: any[]): string => {
        if (!data || data.length === 0) return `-- ${t('definition_viewer.editor.routine_definition_not_found')}`;

        switch (dialect) {
            case 'mysql':
            case 'starrocks': {
                const row = data[0];
                const keys = Object.keys(row);
                if (row.routine_definition || row.ROUTINE_DEFINITION) {
                    return String(row.routine_definition || row.ROUTINE_DEFINITION);
                }
                const sqlKey = keys.find(k => k.toLowerCase().includes('create function') || k.toLowerCase().includes('create procedure'));
                if (sqlKey) return row[sqlKey];
                for (const key of keys) {
                    const val = String(row[key] || '');
                    if (val.toUpperCase().includes('CREATE') && (val.toUpperCase().includes('FUNCTION') || val.toUpperCase().includes('PROCEDURE'))) {
                        return val;
                    }
                }
                const routineName = String(row.Name || row.name || '').trim();
                if (routineName) {
                    const routineType = String(row.Type || row.type || row.ROUTINE_TYPE || row.routine_type || 'FUNCTION').trim().toUpperCase();
                    return `-- ${t('definition_viewer.editor.metadata_fallback.header')}\n-- ${t('definition_viewer.editor.metadata_fallback.name_label')}: ${routineName}\n-- ${t('definition_viewer.editor.metadata_fallback.type_label')}: ${routineType}\n${JSON.stringify(row, null, 2)}`;
                }
                return JSON.stringify(row, null, 2);
            }
            case 'oracle':
            case 'dm': {
                // Oracle/DM ALL_SOURCE returns multiple rows, one per line
                return data.map(row => row.text || row.TEXT || Object.values(row)[0] || '').join('');
            }
            case 'duckdb': {
                const row = data[0] as Record<string, any>;
                const ddl = buildDuckDBMacroDDL(
                    String(getCaseInsensitiveRawValue(row, ['schema_name']) || '').trim(),
                    String(getCaseInsensitiveRawValue(row, ['function_name', 'routine_name', 'name']) || '').trim(),
                    getCaseInsensitiveRawValue(row, ['parameters']),
                    getCaseInsensitiveRawValue(row, ['macro_definition'])
                );
                if (ddl) return ddl;
                const fallback = getCaseInsensitiveRawValue(row, ['macro_definition', 'routine_definition', 'definition']);
                if (fallback !== undefined && fallback !== null && String(fallback).trim() !== '') {
                    return String(fallback);
                }
                return JSON.stringify(row, null, 2);
            }
            case 'sqlserver': {
                const directDefinition = getCaseInsensitiveRawValue(data[0], ['routine_definition', 'definition']);
                if (directDefinition !== undefined && directDefinition !== null && String(directDefinition).trim() !== '') {
                    return String(directDefinition);
                }
                const helpTextDefinition = data
                    .map((row) => getCaseInsensitiveRawValue(row, ['Text', 'text']))
                    .filter((value) => value !== undefined && value !== null)
                    .map((value) => String(value))
                    .join('');
                if (helpTextDefinition.trim()) return helpTextDefinition;
                return String(Object.values(data[0])[0] || '');
            }
            default: {
                const row = data[0];
                return row.routine_definition || row.ROUTINE_DEFINITION || Object.values(row)[0] || '';
            }
        }
    };

    const extractEventDefinition = (dialect: string, data: any[]): string => {
        if (!data || data.length === 0) return `-- ${t('definition_viewer.editor.event_definition_not_found')}`;

        switch (dialect) {
            case 'mysql': {
                const row = data[0];
                const keys = Object.keys(row);
                const sqlKey = keys.find(k => k.toLowerCase().includes('create event'));
                if (sqlKey && row[sqlKey]) return String(row[sqlKey]);

                const definition = row.event_definition || row.EVENT_DEFINITION;
                const eventName = row.event_name || row.EVENT_NAME || row.Name || row.name;
                if (definition && eventName) {
                    return `-- ${t('definition_viewer.editor.event_fragment_fallback.header')}\n-- ${t('definition_viewer.editor.metadata_fallback.name_label')}: ${eventName}\n${String(definition)}`;
                }
                return JSON.stringify(row, null, 2);
            }
            default: {
                const row = data[0];
                return row.event_definition || row.EVENT_DEFINITION || Object.values(row)[0] || '';
            }
        }
    };

    const buildSequenceDefinitionFromRow = (row: Record<string, any>): string => {
        const sequenceName = String(getCaseInsensitiveRawValue(row, ['sequence_name']) || '').trim();
        const owner = String(getCaseInsensitiveRawValue(row, ['sequence_owner', 'owner', 'sequence_schema']) || '').trim();
        const name = owner && sequenceName ? `${owner}.${sequenceName}` : sequenceName;
        if (!name) return JSON.stringify(row, null, 2);

        const clauses: string[] = [];
        const increment = getCaseInsensitiveRawValue(row, ['increment_by', 'increment']);
        const minValue = getCaseInsensitiveRawValue(row, ['min_value', 'minimum_value']);
        const maxValue = getCaseInsensitiveRawValue(row, ['max_value', 'maximum_value']);
        const cacheSize = Number(getCaseInsensitiveRawValue(row, ['cache_size']));
        const cycleFlag = String(getCaseInsensitiveRawValue(row, ['cycle_flag']) || '').trim().toUpperCase();
        const orderFlag = String(getCaseInsensitiveRawValue(row, ['order_flag']) || '').trim().toUpperCase();

        if (increment !== undefined && increment !== null && String(increment).trim() !== '') {
            clauses.push(`INCREMENT BY ${increment}`);
        }
        if (minValue !== undefined && minValue !== null && String(minValue).trim() !== '') {
            clauses.push(`MINVALUE ${minValue}`);
        }
        if (maxValue !== undefined && maxValue !== null && String(maxValue).trim() !== '') {
            clauses.push(`MAXVALUE ${maxValue}`);
        }
        if (Number.isFinite(cacheSize)) {
            clauses.push(cacheSize > 0 ? `CACHE ${cacheSize}` : 'NOCACHE');
        }
        if (cycleFlag) clauses.push(cycleFlag === 'Y' ? 'CYCLE' : 'NOCYCLE');
        if (orderFlag) clauses.push(orderFlag === 'Y' ? 'ORDER' : 'NOORDER');

        return [`CREATE SEQUENCE ${name}`, ...clauses.map((clause) => `  ${clause}`)].join('\n') + ';';
    };

    const extractSequenceDefinition = (dialect: string, data: any[]): string => {
        if (!data || data.length === 0) return `-- ${t('definition_viewer.editor.sequence_definition_not_found')}`;
        switch (dialect) {
            case 'oracle':
            case 'dm':
            case 'postgres':
            case 'kingbase':
            case 'highgo':
            case 'vastbase':
            case 'opengauss':
            case 'gaussdb':
                return buildSequenceDefinitionFromRow(data[0] as Record<string, any>);
            default:
                return JSON.stringify(data[0], null, 2);
        }
    };

    const extractPackageDefinition = (dialect: string, data: any[]): string => {
        if (!data || data.length === 0) return `-- ${t('definition_viewer.editor.package_definition_not_found')}`;
        switch (dialect) {
            case 'oracle':
            case 'dm':
                return data.map(row => row.text || row.TEXT || Object.values(row)[0] || '').join('');
            default:
                return JSON.stringify(data[0], null, 2);
        }
    };

    const loadDefinition = async (): Promise<{ success: boolean; definition?: string; error?: string }> => {
        const conn = connections.find(c => c.id === tab.connectionId);
        if (!conn) {
            return { success: false, error: t('definition_viewer.error.connection_not_found') };
        }

        const dbName = tab.dbName || '';
        const dialect = getMetadataDialect(conn);
        const sphinxLike = isSphinxConnection(conn) && dialect === 'mysql';

        let queries: string[];
        let extractFn: (dialect: string, data: any[]) => string;
        let resolvedObjectLabel: string;
        let resolvedObjectName = '';

        if (tab.type === 'view-def') {
            const viewName = tab.viewName || '';
            if (!viewName) {
                return { success: false, error: t('definition_viewer.error.view_name_empty') };
            }
            queries = buildShowViewQueries(dialect, viewName, dbName, tab.viewKind);
            extractFn = extractViewDefinition;
            resolvedObjectLabel = tab.viewKind === 'materialized'
                ? t('definition_viewer.object.materialized_view')
                : t('definition_viewer.object.view');
            resolvedObjectName = viewName;
        } else if (tab.type === 'event-def') {
            const eventName = tab.eventName || '';
            if (!eventName) {
                return { success: false, error: t('definition_viewer.error.event_name_empty') };
            }
            queries = buildShowEventQueries(dialect, eventName, dbName);
            extractFn = extractEventDefinition;
            resolvedObjectLabel = t('definition_viewer.object.event');
            resolvedObjectName = eventName;
        } else if (tab.type === 'sequence-def') {
            const sequenceName = tab.sequenceName || '';
            if (!sequenceName) {
                return { success: false, error: t('definition_viewer.error.sequence_name_empty') };
            }
            queries = buildShowSequenceQueries(dialect, sequenceName, dbName);
            extractFn = extractSequenceDefinition;
            resolvedObjectLabel = t('definition_viewer.object.sequence');
            resolvedObjectName = sequenceName;
        } else if (tab.type === 'package-def') {
            const packageName = tab.packageName || '';
            if (!packageName) {
                return { success: false, error: t('definition_viewer.error.package_name_empty') };
            }
            queries = buildShowPackageQueries(dialect, packageName, dbName);
            extractFn = extractPackageDefinition;
            resolvedObjectLabel = t('definition_viewer.object.package');
            resolvedObjectName = packageName;
        } else {
            const routineName = tab.routineName || '';
            const routineType = tab.routineType || 'FUNCTION';
            if (!routineName) {
                return { success: false, error: t('definition_viewer.error.routine_name_empty') };
            }
            queries = buildShowRoutineQueries(dialect, routineName, routineType, dbName);
            extractFn = extractRoutineDefinition;
            resolvedObjectLabel = t('definition_viewer.object.routine');
            resolvedObjectName = routineName;
        }

        if (!queries.length || String(queries[0] || '').startsWith('--')) {
            return {
                success: true,
                definition: String(
                    queries[0] || `-- ${t('definition_viewer.editor.unsupported_object_definition')}`,
                ),
            };
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

            if (tab.type === 'view-def' && dialect === 'oracle') {
                const result = await DBShowCreateTable(
                    buildRpcConnectionConfig(config) as any,
                    dbName,
                    resolvedObjectName,
                );
                if (result.success && String(result.data || '').trim()) {
                    const displayDefinition = buildDisplayDefinitionSql(
                        tab,
                        String(result.data),
                        resolvedObjectName,
                    );
                    return {
                        success: true,
                        definition: formatDdlForDisplay(displayDefinition, dialect),
                    };
                }
                return {
                    success: false,
                    error: result.message || t('definition_viewer.error.query_failed'),
                };
            }

            const result = tab.type === 'package-def'
                ? await runQueryCandidatesCollectAll(config, dbName, queries)
                : await runQueryCandidates(config, dbName, queries);

            if (result.success && Array.isArray(result.data) && result.data.length > 0) {
                const rawDefinition = extractFn(dialect, result.data);
                const displayDefinition = buildDisplayDefinitionSql(tab, rawDefinition, resolvedObjectName);
                return {
                    success: true,
                    definition: displayDefinition,
                };
            }

            if (result.success) {
                if (sphinxLike) {
                    const version = await getVersionHint(config, dbName);
                    const versionText = version
                        ? t('definition_viewer.editor.sphinx.version_suffix', { version })
                        : '';
                    return {
                        success: true,
                        definition: `-- ${t('definition_viewer.editor.sphinx.empty_result', {
                            version: versionText,
                            object: resolvedObjectLabel,
                        })}\n-- ${t('definition_viewer.editor.sphinx.compat_queries_hint')}`,
                    };
                }
                return {
                    success: true,
                    definition: `-- ${t('definition_viewer.editor.object_definition_not_found', {
                        object: resolvedObjectLabel,
                    })}`,
                };
            }

            if (sphinxLike) {
                const version = await getVersionHint(config, dbName);
                const versionText = version
                    ? t('definition_viewer.editor.sphinx.version_suffix', { version })
                    : '';
                const failedMessage = result.message
                    ? `${t('definition_viewer.editor.sphinx.failed_message_label')}: ${result.message}`
                    : t('definition_viewer.editor.sphinx.failed_message_unknown');
                return {
                    success: true,
                    definition: `-- ${t('definition_viewer.editor.sphinx.unsupported_query', {
                        version: versionText,
                        object: resolvedObjectLabel,
                    })}\n-- ${failedMessage}`,
                };
            }

            return {
                success: false,
                error: result.message || t('definition_viewer.error.query_failed'),
            };
        } catch (e: any) {
            return {
                success: false,
                error: t('definition_viewer.error.query_failed_detail', {
                    detail: e?.message || String(e),
                }),
            };
        }
    };

    useEffect(() => {
        let cancelled = false;
        const syncDefinition = async () => {
            setLoading(true);
            setError(null);
            const result = await loadDefinition();
            if (cancelled) {
                return;
            }
            if (result.success) {
                loadedDefinitionKeyRef.current = objectIdentityKey;
                setDefinition(String(result.definition || ''));
            } else {
                setError(result.error || t('definition_viewer.error.query_failed'));
            }
            setLoading(false);
        };

        syncDefinition();

        return () => {
            cancelled = true;
        };
    }, [tab.connectionId, tab.dbName, tab.viewName, tab.viewKind, tab.eventName, tab.routineName, tab.routineType, tab.sequenceName, tab.packageName, tab.type, connections, objectIdentityKey, t]);

    useEffect(() => () => {
        isMountedRef.current = false;
    }, []);

    const objectLabel = tab.type === 'view-def'
        ? (tab.viewKind === 'materialized' ? t('definition_viewer.object.materialized_view') : t('definition_viewer.object.view'))
        : (tab.type === 'event-def'
            ? t('definition_viewer.object.event')
            : (tab.type === 'sequence-def'
                ? t('definition_viewer.object.sequence')
                : (tab.type === 'package-def'
                    ? t('definition_viewer.object.package')
                    : t('definition_viewer.object.routine'))));
    const objectName = tab.type === 'view-def'
        ? tab.viewName
        : (tab.type === 'event-def'
            ? tab.eventName
            : (tab.type === 'sequence-def'
                ? tab.sequenceName
                : (tab.type === 'package-def' ? tab.packageName : tab.routineName)));
    const loadingTip = tab.type === 'view-def'
        ? t('definition_viewer.loading.view_definition')
        : (tab.type === 'event-def'
            ? t('definition_viewer.loading.event_definition')
            : (tab.type === 'sequence-def'
                ? t('definition_viewer.loading.sequence_definition')
                : (tab.type === 'package-def'
                    ? t('definition_viewer.loading.package_definition')
                    : t('definition_viewer.loading.routine_definition'))));
    const normalizedObjectName = String(objectName || '').trim();
    const displayedDefinition = loadedDefinitionKeyRef.current === objectIdentityKey ? definition : '';
    const hasDefinition = String(displayedDefinition || '').trim() !== '';
    const editTabTitle = t('definition_viewer.edit.tab_title', {
        object: objectLabel,
        name: normalizedObjectName,
    });
    const editableDefinitionCopy = {
        commentTitle: t('definition_viewer.edit.comment_title', {
            object: objectLabel,
            name: normalizedObjectName,
        }),
        compatibilityHint: t('definition_viewer.edit.comment_compatibility'),
        emptyDefinitionHint: t('definition_viewer.edit.comment_empty_definition', {
            name: normalizedObjectName,
        }),
    };
    const editorModelPath = `gonavi-definition://${encodeURIComponent(objectIdentityKey)}`;
    const currentDefinition = loadedDefinitionKeyRef.current === objectIdentityKey ? String(definition || '') : '';

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

    const openObjectEditTab = useCallback((sourceDefinition: string) => {
        const dbName = String(tab.dbName || '').trim();
        const latestDefinition = String(sourceDefinition || '');
        loadedDefinitionKeyRef.current = objectIdentityKey;
        setDefinition(latestDefinition);
        const query = buildEditableDefinitionSql(tab, latestDefinition, normalizedObjectName, editableDefinitionCopy);
        setActiveContext({ connectionId: tab.connectionId, dbName });
        clearQueryTabDraft(tab.id);
        const isViewObject = tab.type === 'view-def' || Boolean(tab.viewName);
        addTab({
            id: tab.id,
            title: editTabTitle,
            type: 'query',
            connectionId: tab.connectionId,
            dbName,
            query,
            queryMode: 'object-edit',
            returnToTabId: undefined,
            // 保留视图名，供「验证数据变化」解析；其它对象编辑仍清空无关字段
            viewName: isViewObject ? (tab.viewName || normalizedObjectName) : undefined,
            viewKind: isViewObject ? tab.viewKind : undefined,
            eventName: undefined,
            routineName: undefined,
            routineType: undefined,
            sequenceName: undefined,
            packageName: undefined,
            triggerName: undefined,
            triggerTableName: undefined,
            schemaName: isViewObject ? tab.schemaName : undefined,
            objectType: isViewObject
                ? (tab.viewKind === 'materialized' ? 'materialized-view' : 'view')
                : undefined,
            tableName: undefined,
            sidebarLocateKey: undefined,
        });
    }, [
        addTab,
        editTabTitle,
        editableDefinitionCopy,
        normalizedObjectName,
        objectIdentityKey,
        setActiveContext,
        tab,
    ]);

    const openObjectEditQuery = async () => {
        if (!normalizedObjectName || openingObjectEdit) return;
        if (String(currentDefinition || '').trim()) {
            openObjectEditTab(currentDefinition);
            return;
        }
        setOpeningObjectEdit(true);
        setError(null);
        try {
            const result = await loadDefinition();
            if (!isMountedRef.current) {
                return;
            }
            if (!result.success) {
                setError(result.error || t('definition_viewer.error.query_failed'));
                return;
            }
            openObjectEditTab(String(result.definition || ''));
        } finally {
            if (isMountedRef.current) {
                setOpeningObjectEdit(false);
            }
        }
    };

    if (loading) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
                <Spin tip={loadingTip} />
            </div>
        );
    }

    if (error && !hasDefinition) {
        return (
            <div style={{ padding: 16 }}>
                <Alert type="error" message={t('definition_viewer.error.load_failed')} description={error} showIcon />
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ padding: '8px 16px', borderBottom: darkMode ? '1px solid #303030' : '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <strong>{objectLabel}: </strong>{objectName}
                    {tab.dbName && <span style={{ marginLeft: 16, color: '#888' }}>{t('definition_viewer.field.database')}: {tab.dbName}</span>}
                    {tab.routineType && <span style={{ marginLeft: 16, color: '#888' }}>{t('definition_viewer.field.type')}: {tab.routineType}</span>}
                </div>
                <Button size="small" icon={<EditOutlined />} onClick={openObjectEditQuery} disabled={!normalizedObjectName} loading={openingObjectEdit}>
                    {t('definition_viewer.action.edit_object')}
                </Button>
            </div>
            {error && hasDefinition && (
                <div style={{ padding: '8px 16px 0' }}>
                    <Alert type="warning" message={t('definition_viewer.warning.refresh_latest_failed')} description={error} showIcon />
                </div>
            )}
            <div style={{ flex: 1, minHeight: 0 }}>
                <Editor
                    path={editorModelPath}
                    height="100%"
                    gonaviTypography="sql"
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

export default DefinitionViewer;
