import { DBQuery } from '../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { splitSidebarQualifiedName } from '../../utils/sidebarLocate';
import { splitMetadataQualifiedName } from '../../utils/qualifiedName';
import { buildSqlServerObjectDefinitionQueries } from '../../utils/sqlServerObjectDefinition';
import {
    escapeQueryEditorObjectEditSqlLiteral,
    getQueryEditorObjectEditRawValue,
    normalizeQueryEditorMySQLViewDDL,
    buildQueryEditorQualifiedObjectName,
} from './queryEditorObjectEditSql';

export const buildQueryEditorObjectDefinitionConnectionConfig = (conn: any): Record<string, any> => ({
    ...conn.config,
    port: Number(conn.config?.port),
    password: conn.config?.password || '',
    database: conn.config?.database || '',
    useSSH: conn.config?.useSSH || false,
    ssh: conn.config?.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
});

export const runQueryEditorObjectDefinitionCandidates = async (
    config: Record<string, any>,
    dbName: string,
    queries: string[],
    collectAll = false,
): Promise<any[]> => {
    const collectedRows: any[] = [];
    for (const query of queries) {
        const sql = String(query || '').trim();
        if (!sql || sql.startsWith('--')) continue;
        try {
            const result = await DBQuery(buildRpcConnectionConfig(config) as any, dbName, sql);
            if (!result.success || !Array.isArray(result.data) || result.data.length === 0) {
                continue;
            }
            if (!collectAll) {
                return result.data;
            }
            collectedRows.push(...result.data);
        } catch {
            // 元数据定义读取失败时保留编辑模板。
        }
    }
    return collectedRows;
};

export const buildQueryEditorViewDefinitionQueries = (
    dialect: string,
    viewName: string,
    dbName: string,
    schemaName?: string,
    viewKind?: 'view' | 'materialized',
): string[] => {
    const parsed = splitSidebarQualifiedName(viewName);
    const objectName = parsed.objectName || viewName;
    const schema = String(schemaName || parsed.schemaName || '').trim();
    const safeName = escapeQueryEditorObjectEditSqlLiteral(objectName);
    const safeDbName = escapeQueryEditorObjectEditSqlLiteral(dbName);

    switch (dialect) {
        case 'mysql':
        case 'starrocks': {
            const viewRef = schema
                ? `\`${schema.replace(/`/g, '``')}\`.\`${objectName.replace(/`/g, '``')}\``
                : `\`${objectName.replace(/`/g, '``')}\``;
            if (dialect === 'starrocks' && viewKind === 'materialized') {
                return [
                    `SHOW CREATE MATERIALIZED VIEW ${viewRef}`,
                    `SHOW CREATE TABLE ${viewRef}`,
                ];
            }
            return [
                `SHOW CREATE VIEW ${viewRef}`,
                safeDbName
                    ? `SELECT VIEW_DEFINITION AS view_definition FROM information_schema.views WHERE table_schema = '${safeDbName}' AND table_name = '${safeName}' LIMIT 1`
                    : '',
                `SHOW CREATE TABLE ${viewRef}`,
            ].filter(Boolean);
        }
        case 'postgres':
        case 'kingbase':
        case 'highgo':
        case 'vastbase':
        case 'opengauss':
        case 'gaussdb': {
            const schemaRef = schema || 'public';
            return [`SELECT pg_get_viewdef('${escapeQueryEditorObjectEditSqlLiteral(schemaRef)}.${safeName}'::regclass, true) AS view_definition`];
        }
        case 'sqlserver':
            return buildSqlServerObjectDefinitionQueries('view', viewName, dbName, 'view_definition');
        case 'oracle': {
            const owner = schema ? escapeQueryEditorObjectEditSqlLiteral(schema).toUpperCase() : (safeDbName ? safeDbName.toUpperCase() : '');
            if (owner) {
                return [`SELECT TEXT AS view_definition FROM ALL_VIEWS WHERE OWNER = '${owner}' AND VIEW_NAME = '${safeName.toUpperCase()}'`];
            }
            return [`SELECT TEXT AS view_definition FROM USER_VIEWS WHERE VIEW_NAME = '${safeName.toUpperCase()}'`];
        }
        case 'sqlite':
            return [`SELECT sql AS view_definition FROM sqlite_master WHERE type='view' AND name='${safeName}'`];
        case 'duckdb': {
            const schemaRef = schema || 'main';
            return [`SELECT view_definition FROM information_schema.views WHERE table_schema = '${escapeQueryEditorObjectEditSqlLiteral(schemaRef)}' AND table_name = '${safeName}' LIMIT 1`];
        }
        default:
            return [];
    }
};

export const extractQueryEditorViewDefinition = (dialect: string, data: any[]): string => {
    if (!Array.isArray(data) || data.length === 0) return '';
    const row = data[0] as Record<string, any>;
    if (dialect === 'mysql' || dialect === 'starrocks') {
        const direct = getQueryEditorObjectEditRawValue(row, ['view_definition', 'VIEW_DEFINITION']);
        if (direct !== undefined && direct !== null && String(direct).trim()) {
            return normalizeQueryEditorMySQLViewDDL(direct);
        }
        const sqlKey = Object.keys(row).find((key) => {
            const lowerKey = key.toLowerCase();
            return lowerKey.includes('create view') || lowerKey === 'create view' || lowerKey.includes('create table');
        });
        if (sqlKey) {
            return normalizeQueryEditorMySQLViewDDL(row[sqlKey]);
        }
        const createValue = Object.values(row).find((value) => {
            const text = String(value || '').toUpperCase();
            return text.includes('CREATE') && (text.includes('VIEW') || text.includes('TABLE'));
        });
        return createValue ? normalizeQueryEditorMySQLViewDDL(createValue) : '';
    }
    if (dialect === 'sqlserver') {
        const direct = getQueryEditorObjectEditRawValue(row, ['view_definition', 'definition']);
        if (direct !== undefined && direct !== null && String(direct).trim()) {
            return String(direct);
        }
        return data
            .map((item) => getQueryEditorObjectEditRawValue(item, ['Text', 'text']))
            .filter((value) => value !== undefined && value !== null)
            .map((value) => String(value))
            .join('');
    }
    const direct = getQueryEditorObjectEditRawValue(row, ['view_definition', 'definition', 'sql', 'text', 'TEXT', 'SQL']);
    return direct !== undefined && direct !== null ? String(direct) : String(Object.values(row)[0] || '');
};

export const buildQueryEditorSequenceDefinitionQueries = (
    dialect: string,
    sequenceName: string,
    dbName: string,
    schemaName?: string,
): string[] => {
    const parsed = splitSidebarQualifiedName(sequenceName);
    const objectName = parsed.objectName || sequenceName;
    const schema = String(schemaName || parsed.schemaName || '').trim();
    const safeName = escapeQueryEditorObjectEditSqlLiteral(objectName);
    const safeDbName = escapeQueryEditorObjectEditSqlLiteral(dbName);
    const owner = schema ? escapeQueryEditorObjectEditSqlLiteral(schema).toUpperCase() : (safeDbName ? safeDbName.toUpperCase() : '');

    switch (dialect) {
        case 'oracle':
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
            return [`SELECT sequence_schema, sequence_name, data_type, start_value, minimum_value, maximum_value, increment FROM information_schema.sequences WHERE sequence_schema = '${escapeQueryEditorObjectEditSqlLiteral(schemaRef)}' AND sequence_name = '${safeName}' LIMIT 1`];
        }
        default:
            return [];
    }
};

const buildQueryEditorSequenceDefinitionFromRow = (
    row: Record<string, any>,
    fallbackSequenceName: string,
    fallbackSchemaName?: string,
): string => {
    const sequenceName = String(getQueryEditorObjectEditRawValue(row, ['sequence_name']) || splitSidebarQualifiedName(fallbackSequenceName).objectName || fallbackSequenceName).trim();
    const owner = String(getQueryEditorObjectEditRawValue(row, ['sequence_owner', 'owner', 'sequence_schema']) || fallbackSchemaName || splitSidebarQualifiedName(fallbackSequenceName).schemaName || '').trim();
    const name = buildQueryEditorQualifiedObjectName(sequenceName, owner);
    if (!name) return '';

    const clauses: string[] = [];
    const increment = getQueryEditorObjectEditRawValue(row, ['increment_by', 'increment']);
    const minValue = getQueryEditorObjectEditRawValue(row, ['min_value', 'minimum_value']);
    const maxValue = getQueryEditorObjectEditRawValue(row, ['max_value', 'maximum_value']);
    const cacheSize = Number(getQueryEditorObjectEditRawValue(row, ['cache_size']));
    const cycleFlag = String(getQueryEditorObjectEditRawValue(row, ['cycle_flag']) || '').trim().toUpperCase();
    const orderFlag = String(getQueryEditorObjectEditRawValue(row, ['order_flag']) || '').trim().toUpperCase();

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

    return [`CREATE SEQUENCE ${name}`, ...clauses.map((clause) => `  ${clause}`)].join('\n');
};

export const extractQueryEditorSequenceDefinition = (
    data: any[],
    sequenceName: string,
    schemaName?: string,
): string => {
    if (!Array.isArray(data) || data.length === 0) return '';
    return buildQueryEditorSequenceDefinitionFromRow(data[0] as Record<string, any>, sequenceName, schemaName);
};

export const buildQueryEditorPackageDefinitionQueries = (
    dialect: string,
    packageName: string,
    dbName: string,
    schemaName?: string,
): string[] => {
    const parsed = splitSidebarQualifiedName(packageName);
    const objectName = parsed.objectName || packageName;
    const schema = String(schemaName || parsed.schemaName || '').trim();
    const safeName = escapeQueryEditorObjectEditSqlLiteral(objectName);
    const safeDbName = escapeQueryEditorObjectEditSqlLiteral(dbName);

    if (dialect !== 'oracle') {
        return [];
    }

    const owner = schema ? escapeQueryEditorObjectEditSqlLiteral(schema).toUpperCase() : (safeDbName ? safeDbName.toUpperCase() : '');
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
};

export const extractQueryEditorPackageDefinition = (data: any[]): string => {
    if (!Array.isArray(data) || data.length === 0) return '';
    return data
        .map((row: any) => getQueryEditorObjectEditRawValue(row, ['text', 'TEXT']) ?? Object.values(row || {})[0] ?? '')
        .map((value) => String(value))
        .join('');
};

export const buildQueryEditorTriggerDefinitionQueries = (
    dialect: string,
    triggerName: string,
    dbName: string,
    schemaName?: string,
    tableName?: string,
): string[] => {
    const schemaHint = String(schemaName || '').trim();
    const parsed = schemaHint
        ? splitMetadataQualifiedName(triggerName, schemaHint)
        : splitSidebarQualifiedName(triggerName);
    const objectName = parsed.objectName || triggerName;
    const schema = String(('parentPath' in parsed ? parsed.parentPath : parsed.schemaName) || schemaHint).trim();
    const safeName = escapeQueryEditorObjectEditSqlLiteral(objectName);
    const tableSchemaHint = schemaHint || schema;
    const parsedTable = tableSchemaHint
        ? splitMetadataQualifiedName(String(tableName || '').trim(), tableSchemaHint)
        : splitSidebarQualifiedName(String(tableName || '').trim());
    const triggerTableName = String(parsedTable.objectName || tableName || '').trim();
    const triggerTableSchema = String(('parentPath' in parsedTable ? parsedTable.parentPath : parsedTable.schemaName) || schemaHint).trim();
    const safeTableName = escapeQueryEditorObjectEditSqlLiteral(triggerTableName);
    const safeSchemaName = escapeQueryEditorObjectEditSqlLiteral(schema || triggerTableSchema);

    switch (dialect) {
        case 'mysql':
        case 'starrocks': {
            const triggerDatabaseName = schema || triggerTableSchema || dbName;
            const triggerRef = triggerDatabaseName
                ? `\`${triggerDatabaseName.replace(/`/g, '``')}\`.\`${objectName.replace(/`/g, '``')}\``
                : `\`${objectName.replace(/`/g, '``')}\``;
            return [
                `SHOW CREATE TRIGGER ${triggerRef}`,
                triggerDatabaseName
                    ? `SELECT TRIGGER_NAME, TRIGGER_SCHEMA, EVENT_OBJECT_SCHEMA, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORIENTATION, ACTION_STATEMENT FROM information_schema.triggers WHERE trigger_schema = '${escapeQueryEditorObjectEditSqlLiteral(triggerDatabaseName)}' AND trigger_name = '${safeName}' LIMIT 1`
                    : '',
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
WHERE t.tgname = '${safeName}'
  AND NOT t.tgisinternal
${safeSchemaName ? `  AND n.nspname = '${safeSchemaName}'\n` : ''}${safeTableName ? `  AND c.relname = '${safeTableName}'\n` : ''}LIMIT 1`];
        case 'sqlserver': {
            const quoteSqlServerIdentifier = (value: string): string => `[${String(value || '').replace(/]/g, ']]')}]`;
            const sqlServerTriggerLookupName = schema || triggerTableSchema
                ? `${quoteSqlServerIdentifier(schema || triggerTableSchema)}.${quoteSqlServerIdentifier(objectName)}`
                : quoteSqlServerIdentifier(objectName);
            return buildSqlServerObjectDefinitionQueries(
                'trigger',
                sqlServerTriggerLookupName,
                dbName,
                'trigger_definition',
            );
        }
        case 'oracle':
            return [];
        case 'sqlite':
            return [`SELECT sql AS trigger_definition FROM sqlite_master WHERE type = 'trigger' AND name = '${safeName}'`];
        default:
            return [];
    }
};

export const extractQueryEditorTriggerDefinition = (dialect: string, data: any[]): string => {
    if (!Array.isArray(data) || data.length === 0) return '';
    const row = data[0] as Record<string, any>;
    const direct = getQueryEditorObjectEditRawValue(row, ['trigger_definition', 'definition', 'sql', 'SQL']);
    if (direct !== undefined && direct !== null && String(direct).trim()) {
        return String(direct);
    }
    if (dialect === 'mysql' || dialect === 'starrocks') {
        const statementKey = Object.keys(row).find((key) => {
            const lowerKey = key.toLowerCase();
            return lowerKey.includes('statement') || lowerKey.includes('create trigger');
        });
        if (statementKey) return String(row[statementKey] || '');
        const createValue = Object.values(row).find((value) => String(value || '').toUpperCase().includes('CREATE TRIGGER'));
        return createValue ? String(createValue) : String(getQueryEditorObjectEditRawValue(row, ['ACTION_STATEMENT', 'action_statement']) || '');
    }
    return String(getQueryEditorObjectEditRawValue(row, ['TRIGGER_BODY', 'trigger_body', 'TEXT', 'text']) || Object.values(row)[0] || '');
};
