import React, { useState, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { Spin, Alert } from 'antd';
import { TabData } from '../types';
import { useStore } from '../store';
import { DBQuery } from '../../wailsjs/go/app/App';

interface DefinitionViewerProps {
    tab: TabData;
}

const DefinitionViewer: React.FC<DefinitionViewerProps> = ({ tab }) => {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [definition, setDefinition] = useState<string>('');

    const connections = useStore(state => state.connections);
    const theme = useStore(state => state.theme);
    const darkMode = theme === 'dark';

    const escapeSQLLiteral = (raw: string): string => String(raw || '').replace(/'/g, "''");

    const getMetadataDialect = (conn: any): string => {
        const type = String(conn?.config?.type || '').trim().toLowerCase();
        if (type === 'custom') {
            const driver = String(conn?.config?.driver || '').trim().toLowerCase();
            if (driver === 'diros' || driver === 'doris') return 'mysql';
            return driver;
        }
        if (type === 'mariadb' || type === 'diros' || type === 'sphinx') return 'mysql';
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
        const raw = String(fullName || '').trim();
        const idx = raw.lastIndexOf('.');
        if (idx > 0 && idx < raw.length - 1) {
            return { schema: raw.substring(0, idx), name: raw.substring(idx + 1) };
        }
        return { schema: '', name: raw };
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

    const buildShowViewQueries = (dialect: string, viewName: string, dbName: string): string[] => {
        const { schema, name } = parseSchemaAndName(viewName);
        const safeName = escapeSQLLiteral(name);
        const safeDbName = escapeSQLLiteral(dbName);

        switch (dialect) {
            case 'mysql':
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
            case 'vastbase': {
                const schemaRef = schema || 'public';
                return [`SELECT pg_get_viewdef('${escapeSQLLiteral(schemaRef)}.${safeName}'::regclass, true) AS view_definition`];
            }
            case 'sqlserver':
                return [`SELECT OBJECT_DEFINITION(OBJECT_ID('${escapeSQLLiteral(viewName)}')) AS view_definition`];
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
                return [`-- 暂不支持该数据库类型的视图定义查看`];
        }
    };

    const buildShowRoutineQueries = (dialect: string, routineName: string, routineType: string, dbName: string): string[] => {
        const { schema, name } = parseSchemaAndName(routineName);
        const safeName = escapeSQLLiteral(name);
        const safeDbName = escapeSQLLiteral(dbName);
        const upperType = (routineType || 'FUNCTION').toUpperCase();

        switch (dialect) {
            case 'mysql':
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
            case 'vastbase': {
                const schemaRef = schema || 'public';
                return [`SELECT pg_get_functiondef(p.oid) AS routine_definition FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = '${escapeSQLLiteral(schemaRef)}' AND p.proname = '${safeName}' LIMIT 1`];
            }
            case 'sqlserver':
                return [`SELECT OBJECT_DEFINITION(OBJECT_ID('${escapeSQLLiteral(routineName)}')) AS routine_definition`];
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
                return [`-- SQLite 不支持函数/存储过程定义管理`];
            default:
                return [`-- 暂不支持该数据库类型的函数/存储过程定义查看`];
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
                const result = await DBQuery(config as any, dbName, sql);
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
                const result = await DBQuery(config as any, dbName, query);
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
        if (!data || data.length === 0) return '-- 未找到视图定义';
        const row = data[0];

        switch (dialect) {
            case 'mysql': {
                const keys = Object.keys(row);
                const textDefinition = row.view_definition || row.VIEW_DEFINITION;
                if (textDefinition) return String(textDefinition);
                const sqlKey = keys.find(k => k.toLowerCase().includes('create view') || k.toLowerCase() === 'create view');
                if (sqlKey) return row[sqlKey];
                const tableSqlKey = keys.find(k => k.toLowerCase().includes('create table'));
                if (tableSqlKey) return row[tableSqlKey];
                for (const key of keys) {
                    const val = String(row[key] || '');
                    if (val.toUpperCase().includes('CREATE') && (val.toUpperCase().includes('VIEW') || val.toUpperCase().includes('TABLE'))) {
                        return val;
                    }
                }
                return JSON.stringify(row, null, 2);
            }
            case 'oracle':
            case 'dm':
                return row.view_definition || row.VIEW_DEFINITION || row.text || row.TEXT || Object.values(row)[0] || '';
            default:
                return row.view_definition || row.VIEW_DEFINITION || row.sql || row.SQL || Object.values(row)[0] || '';
        }
    };

    const extractRoutineDefinition = (dialect: string, data: any[]): string => {
        if (!data || data.length === 0) return '-- 未找到函数/存储过程定义';

        switch (dialect) {
            case 'mysql': {
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
                    return `-- 当前数据源未返回可执行定义文本，已返回元数据\n-- 名称: ${routineName}\n-- 类型: ${routineType}\n${JSON.stringify(row, null, 2)}`;
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
            default: {
                const row = data[0];
                return row.routine_definition || row.ROUTINE_DEFINITION || Object.values(row)[0] || '';
            }
        }
    };

    useEffect(() => {
        const loadDefinition = async () => {
            setLoading(true);
            setError(null);

            const conn = connections.find(c => c.id === tab.connectionId);
            if (!conn) {
                setError('未找到数据库连接');
                setLoading(false);
                return;
            }

            const dbName = tab.dbName || '';
            const dialect = getMetadataDialect(conn);
            const sphinxLike = isSphinxConnection(conn) && dialect === 'mysql';

            let queries: string[];
            let extractFn: (dialect: string, data: any[]) => string;
            let objectLabel: string;

            if (tab.type === 'view-def') {
                const viewName = tab.viewName || '';
                if (!viewName) {
                    setError('视图名称为空');
                    setLoading(false);
                    return;
                }
                queries = buildShowViewQueries(dialect, viewName, dbName);
                extractFn = extractViewDefinition;
                objectLabel = '视图';
            } else {
                const routineName = tab.routineName || '';
                const routineType = tab.routineType || 'FUNCTION';
                if (!routineName) {
                    setError('函数/存储过程名称为空');
                    setLoading(false);
                    return;
                }
                queries = buildShowRoutineQueries(dialect, routineName, routineType, dbName);
                extractFn = extractRoutineDefinition;
                objectLabel = '函数/存储过程';
            }

            if (!queries.length || String(queries[0] || '').startsWith('--')) {
                setDefinition(String(queries[0] || '-- 暂不支持该对象定义查看'));
                setLoading(false);
                return;
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

                const result = await runQueryCandidates(config, dbName, queries);

                if (result.success && Array.isArray(result.data) && result.data.length > 0) {
                    const def = extractFn(dialect, result.data);
                    setDefinition(def);
                    return;
                }

                if (result.success) {
                    if (sphinxLike) {
                        const version = await getVersionHint(config, dbName);
                        const versionText = version ? `（版本: ${version}）` : '';
                        setDefinition(`-- 当前 Sphinx 实例${versionText}未返回${objectLabel}定义。\n-- 已执行多套兼容查询，可能是版本能力限制或对象类型不支持。`);
                        return;
                    }
                    setDefinition(`-- 未找到${objectLabel}定义`);
                } else if (sphinxLike) {
                    const version = await getVersionHint(config, dbName);
                    const versionText = version ? `（版本: ${version}）` : '';
                    setDefinition(`-- 当前 Sphinx 实例${versionText}不支持${objectLabel}定义查询。\n-- 已自动尝试兼容语句，返回失败信息: ${result.message || 'unknown error'}`);
                } else {
                    setError(result.message || '查询定义失败');
                }
            } catch (e: any) {
                setError('查询定义失败: ' + (e?.message || String(e)));
            } finally {
                setLoading(false);
            }
        };

        loadDefinition();
    }, [tab.connectionId, tab.dbName, tab.viewName, tab.routineName, tab.routineType, tab.type, connections]);

    const objectLabel = tab.type === 'view-def' ? '视图' : '函数/存储过程';
    const objectName = tab.type === 'view-def' ? tab.viewName : tab.routineName;

    if (loading) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
                <Spin tip={`加载${objectLabel}定义...`} />
            </div>
        );
    }

    if (error) {
        return (
            <div style={{ padding: 16 }}>
                <Alert type="error" message="加载失败" description={error} showIcon />
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ padding: '8px 16px', borderBottom: darkMode ? '1px solid #303030' : '1px solid #f0f0f0' }}>
                <strong>{objectLabel}: </strong>{objectName}
                {tab.dbName && <span style={{ marginLeft: 16, color: '#888' }}>数据库: {tab.dbName}</span>}
                {tab.routineType && <span style={{ marginLeft: 16, color: '#888' }}>类型: {tab.routineType}</span>}
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
                <Editor
                    height="100%"
                    language="sql"
                    theme={darkMode ? 'transparent-dark' : 'transparent-light'}
                    value={definition}
                    options={{
                        readOnly: true,
                        minimap: { enabled: false },
                        fontSize: 14,
                        lineNumbers: 'on',
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
