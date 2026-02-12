import React, { useState, useEffect } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import { Spin, Alert } from 'antd';
import { TabData } from '../types';
import { useStore } from '../store';
import { DBQuery } from '../../wailsjs/go/app/App';

interface TriggerViewerProps {
    tab: TabData;
}

const TriggerViewer: React.FC<TriggerViewerProps> = ({ tab }) => {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [triggerDefinition, setTriggerDefinition] = useState<string>('');

    const connections = useStore(state => state.connections);
    const theme = useStore(state => state.theme);
    const darkMode = theme === 'dark';

    // 初始化透明 Monaco Editor 主题
    useEffect(() => {
        loader.init().then(monaco => {
            monaco.editor.defineTheme('transparent-dark', {
                base: 'vs-dark',
                inherit: true,
                rules: [],
                colors: {
                    'editor.background': '#00000000',
                    'editor.lineHighlightBackground': '#ffffff10',
                    'editorGutter.background': '#00000000',
                }
            });
            monaco.editor.defineTheme('transparent-light', {
                base: 'vs',
                inherit: true,
                rules: [],
                colors: {
                    'editor.background': '#00000000',
                    'editor.lineHighlightBackground': '#00000010',
                    'editorGutter.background': '#00000000',
                }
            });
        });
    }, []);

    const escapeSQLLiteral = (raw: string): string => String(raw || '').replace(/'/g, "''");
    const quoteSqlServerIdentifier = (raw: string): string => `[${String(raw || '').replace(/]/g, ']]')}]`;

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

    const buildShowTriggerQueries = (dialect: string, triggerName: string, dbName: string): string[] => {
        const safeTriggerName = escapeSQLLiteral(triggerName);
        const safeDbName = escapeSQLLiteral(dbName);
        switch (dialect) {
            case 'mysql':
                return [
                    `SHOW CREATE TRIGGER \`${triggerName.replace(/`/g, '``')}\``,
                    safeDbName
                        ? `SELECT ACTION_STATEMENT AS trigger_definition FROM information_schema.triggers WHERE trigger_schema = '${safeDbName}' AND trigger_name = '${safeTriggerName}' LIMIT 1`
                        : '',
                    safeDbName
                        ? `SHOW TRIGGERS FROM \`${dbName.replace(/`/g, '``')}\` LIKE '${safeTriggerName}'`
                        : `SHOW TRIGGERS LIKE '${safeTriggerName}'`,
                ].filter(Boolean);
            case 'postgres':
            case 'kingbase':
            case 'highgo':
            case 'vastbase':
                return [`SELECT pg_get_triggerdef(t.oid, true) AS trigger_definition
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
WHERE t.tgname = '${safeTriggerName}'
  AND NOT t.tgisinternal
LIMIT 1`];
            case 'sqlserver': {
                return [`SELECT OBJECT_DEFINITION(OBJECT_ID('${safeTriggerName.replace(/'/g, "''")}')) AS trigger_definition`];
            }
            case 'oracle':
            case 'dm':
                if (!safeDbName) {
                    return [`SELECT TRIGGER_BODY FROM USER_TRIGGERS WHERE TRIGGER_NAME = '${safeTriggerName.toUpperCase()}'`];
                }
                return [`SELECT TRIGGER_BODY FROM ALL_TRIGGERS WHERE OWNER = '${safeDbName.toUpperCase()}' AND TRIGGER_NAME = '${safeTriggerName.toUpperCase()}'`];
            case 'sqlite':
                return [`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = '${safeTriggerName}'`];
            case 'duckdb':
                return [`-- DuckDB 不支持触发器`];
            case 'tdengine':
                return [`-- TDengine 不支持触发器`];
            case 'mongodb':
                return [`-- MongoDB 不支持触发器`];
            default:
                return [`-- 暂不支持该数据库类型的触发器定义查看`];
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

    const extractTriggerDefinition = (dialect: string, data: any[]): string => {
        if (!data || data.length === 0) {
            return '-- 未找到触发器定义';
        }

        const row = data[0];

        switch (dialect) {
            case 'mysql': {
                // MySQL SHOW CREATE TRIGGER returns: Trigger, sql_mode, SQL Original Statement, ...
                const keys = Object.keys(row);
                if (row.trigger_definition || row.TRIGGER_DEFINITION) {
                    return String(row.trigger_definition || row.TRIGGER_DEFINITION);
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
            case 'vastbase': {
                return row.trigger_definition || row.TRIGGER_DEFINITION || Object.values(row)[0] || '';
            }
            case 'sqlserver': {
                return row.trigger_definition || row.TRIGGER_DEFINITION || Object.values(row)[0] || '';
            }
            case 'oracle':
            case 'dm': {
                return row.trigger_body || row.TRIGGER_BODY || Object.values(row)[0] || '';
            }
            case 'sqlite': {
                return row.sql || row.SQL || Object.values(row)[0] || '';
            }
            default:
                return JSON.stringify(row, null, 2);
        }
    };

    useEffect(() => {
        const loadTriggerDefinition = async () => {
            setLoading(true);
            setError(null);

            const conn = connections.find(c => c.id === tab.connectionId);
            if (!conn) {
                setError('未找到数据库连接');
                setLoading(false);
                return;
            }

            const triggerName = tab.triggerName || '';
            const dbName = tab.dbName || '';

            if (!triggerName) {
                setError('触发器名称为空');
                setLoading(false);
                return;
            }

            const dialect = getMetadataDialect(conn);
            const queries = buildShowTriggerQueries(dialect, triggerName, dbName);
            const sphinxLike = isSphinxConnection(conn) && dialect === 'mysql';

            if (!queries.length || String(queries[0] || '').startsWith('--')) {
                setTriggerDefinition(String(queries[0] || '-- 暂不支持该数据库类型的触发器定义查看'));
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
                    const definition = extractTriggerDefinition(dialect, result.data);
                    setTriggerDefinition(definition);
                    return;
                }

                if (result.success) {
                    if (sphinxLike) {
                        const version = await getVersionHint(config, dbName);
                        const versionText = version ? `（版本: ${version}）` : '';
                        setTriggerDefinition(`-- 当前 Sphinx 实例${versionText}未返回触发器定义。\n-- 已执行多套兼容查询，可能是版本能力限制或对象类型不支持。`);
                        return;
                    }
                    setTriggerDefinition('-- 未找到触发器定义');
                } else if (sphinxLike) {
                    const version = await getVersionHint(config, dbName);
                    const versionText = version ? `（版本: ${version}）` : '';
                    setTriggerDefinition(`-- 当前 Sphinx 实例${versionText}不支持触发器定义查询。\n-- 已自动尝试兼容语句，返回失败信息: ${result.message || 'unknown error'}`);
                } else {
                    setError(result.message || '查询触发器定义失败');
                }
            } catch (e: any) {
                setError('查询触发器定义失败: ' + (e?.message || String(e)));
            } finally {
                setLoading(false);
            }
        };

        loadTriggerDefinition();
    }, [tab.connectionId, tab.dbName, tab.triggerName, connections]);

    if (loading) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
                <Spin tip="加载触发器定义..." />
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
                <strong>触发器: </strong>{tab.triggerName}
                {tab.dbName && <span style={{ marginLeft: 16, color: '#888' }}>数据库: {tab.dbName}</span>}
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
                <Editor
                    height="100%"
                    language="sql"
                    theme={darkMode ? 'transparent-dark' : 'transparent-light'}
                    value={triggerDefinition}
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

export default TriggerViewer;
