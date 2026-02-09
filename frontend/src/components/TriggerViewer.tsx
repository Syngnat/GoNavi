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
            return String(conn?.config?.driver || '').trim().toLowerCase();
        }
        if (type === 'mariadb') return 'mysql';
        if (type === 'dameng') return 'dm';
        return type;
    };

    const buildShowTriggerQuery = (dialect: string, triggerName: string, dbName: string): string => {
        const safeTriggerName = escapeSQLLiteral(triggerName);
        const safeDbName = escapeSQLLiteral(dbName);
        switch (dialect) {
            case 'mysql':
                return `SHOW CREATE TRIGGER \`${triggerName.replace(/`/g, '``')}\``;
            case 'postgres':
            case 'kingbase':
            case 'highgo':
            case 'vastbase':
                return `SELECT pg_get_triggerdef(t.oid, true) AS trigger_definition
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
WHERE t.tgname = '${safeTriggerName}'
  AND NOT t.tgisinternal
LIMIT 1`;
            case 'sqlserver': {
                return `SELECT OBJECT_DEFINITION(OBJECT_ID('${safeTriggerName.replace(/'/g, "''")}')) AS trigger_definition`;
            }
            case 'oracle':
            case 'dm':
                if (!safeDbName) {
                    return `SELECT TRIGGER_BODY FROM USER_TRIGGERS WHERE TRIGGER_NAME = '${safeTriggerName.toUpperCase()}'`;
                }
                return `SELECT TRIGGER_BODY FROM ALL_TRIGGERS WHERE OWNER = '${safeDbName.toUpperCase()}' AND TRIGGER_NAME = '${safeTriggerName.toUpperCase()}'`;
            case 'sqlite':
                return `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = '${safeTriggerName}'`;
            case 'tdengine':
                return `-- TDengine 不支持触发器`;
            case 'mongodb':
                return `-- MongoDB 不支持触发器`;
            default:
                return `-- 暂不支持该数据库类型的触发器定义查看`;
        }
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
            const query = buildShowTriggerQuery(dialect, triggerName, dbName);

            if (query.startsWith('--')) {
                setTriggerDefinition(query);
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

                const result = await DBQuery(config as any, dbName, query);

                if (result.success && Array.isArray(result.data)) {
                    const definition = extractTriggerDefinition(dialect, result.data);
                    setTriggerDefinition(definition);
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
