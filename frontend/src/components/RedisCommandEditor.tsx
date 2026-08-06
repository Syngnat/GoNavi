import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Button, Space, message } from 'antd';
import { PlayCircleOutlined, ClearOutlined } from '@ant-design/icons';
import { useStore } from '../store';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { t, type I18nParams } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';
import Editor, { type OnMount } from './MonacoEditor';
import {
    isMacLikePlatform,
    normalizeBlurForPlatform,
    normalizeOpacityForPlatform,
    resolveAppearanceValues,
} from '../utils/appearance';
import { buildRedisWorkbenchTheme } from './redisViewerWorkbenchTheme';
import { confirmProductionMutation } from '../utils/productionRiskConfirm';

interface RedisCommandEditorProps {
    connectionId: string;
    redisDB: number;
}

interface CommandResult {
    command: string;
    result: any;
    error?: string;
    timestamp: number;
    durationMs: number;
}

export const REDIS_COMMAND_EDITOR_MIN_HEIGHT = 120;
export const REDIS_COMMAND_OUTPUT_MIN_HEIGHT = 240;
export const REDIS_COMMAND_RESIZER_HEIGHT = 8;

export const clampRedisCommandEditorHeight = (
    requestedHeight: number,
    containerHeight: number | undefined,
): number => {
    const minHeight = REDIS_COMMAND_EDITOR_MIN_HEIGHT;
    const fallbackMaxHeight = 800;
    const maxHeight = containerHeight
        ? Math.max(
            minHeight,
            containerHeight - REDIS_COMMAND_OUTPUT_MIN_HEIGHT - REDIS_COMMAND_RESIZER_HEIGHT,
        )
        : fallbackMaxHeight;

    return Math.min(Math.max(requestedHeight, minHeight), maxHeight);
};

// 智能解析 Redis 脚本块，保护多行引号内的换行符
function parseRedisScriptBlocks(script: string): string[] {
    const blocks: string[] = [];
    let currentBlock = "";
    let inQuote: string | null = null;
    let isEscaping = false;

    const lines = script.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (!inQuote && (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('#'))) {
            continue;
        }

        for (let j = 0; j < line.length; j++) {
            const char = line[j];
            
            if (isEscaping) {
                isEscaping = false;
                currentBlock += char;
                continue;
            }

            if (char === '\\') {
                isEscaping = true;
                currentBlock += char;
                continue;
            }

            if (char === '"' || char === "'") {
                if (inQuote === char) {
                    inQuote = null;
                } else if (!inQuote) {
                    inQuote = char;
                }
            }

            currentBlock += char;
        }

        if (inQuote || (i < lines.length - 1 && currentBlock.trim() !== '')) {
            if (!inQuote) {
                blocks.push(currentBlock.trim());
                currentBlock = "";
            } else {
                currentBlock += '\n';
            }
        }
    }

    if (currentBlock.trim() !== '') {
        blocks.push(currentBlock.trim());
    }

    return blocks.filter(b => b.trim() !== '');
}

const RedisCommandEditor: React.FC<RedisCommandEditorProps> = ({ connectionId, redisDB }) => {
    const connections = useStore(state => state.connections);
    const theme = useStore(state => state.theme);
    const appearance = useStore(state => state.appearance);
    const i18n = useOptionalI18n();
    const i18nLanguage = i18n?.language;
    const tr = (key: string, params?: I18nParams) => t(key, params, i18nLanguage);
    const connection = connections.find(c => c.id === connectionId);
    const darkMode = theme === 'dark';
    const isV2Ui = appearance.uiVersion === 'v2';
    const resolvedAppearance = resolveAppearanceValues(appearance);
    const opacity = normalizeOpacityForPlatform(resolvedAppearance.opacity);
    const blur = normalizeBlurForPlatform(resolvedAppearance.blur);
    const disableLocalBackdropFilter = isMacLikePlatform();
    const workbenchTheme = useMemo(
        () => buildRedisWorkbenchTheme({ darkMode, opacity, blur, disableBackdropFilter: disableLocalBackdropFilter }),
        [blur, darkMode, disableLocalBackdropFilter, opacity, appearance.uiVersion],
    );

    const [command, setCommand] = useState('');
    const [results, setResults] = useState<CommandResult[]>([]);
    const [loading, setLoading] = useState(false);
    
    // UI Layout state
    const [editorHeight, setEditorHeight] = useState(250);
    const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
    const dragBodyStyleRef = useRef<{ cursor: string; userSelect: string } | null>(null);
    const dragListenersRef = useRef<{
        blur: () => void;
        move: (event: MouseEvent) => void;
        up: () => void;
    } | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const resultsEndRef = useRef<HTMLDivElement>(null);
    
    const editorRef = useRef<any>(null);

    const getConfig = useCallback(() => {
        if (!connection) return null;
        return {
            ...connection.config,
            port: Number(connection.config.port),
            password: connection.config.password || "",
            useSSH: connection.config.useSSH || false,
            ssh: connection.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" },
            redisDB: redisDB
        };
    }, [connection, redisDB]);

    const redisReadOnlyCommands = useMemo(() => new Set([
        'AUTH', 'COMMAND', 'DBSIZE', 'ECHO', 'EXISTS', 'GET', 'GETBIT', 'GETRANGE', 'HELLO',
        'HGET', 'HGETALL', 'HEXISTS', 'HKEYS', 'HLEN', 'HMGET', 'HSTRLEN', 'HVALS', 'INFO',
        'KEYS', 'LASTSAVE', 'LINDEX', 'LLEN', 'LRANGE', 'MGET', 'OBJECT', 'PING',
        'PTTL', 'RANDOMKEY', 'ROLE', 'SCAN', 'SCARD', 'SDIFF', 'SINTER', 'SISMEMBER',
        'READONLY', 'READWRITE', 'SELECT', 'SMEMBERS', 'SMISMEMBER', 'SRANDMEMBER', 'STRLEN',
        'TIME', 'TTL', 'TYPE', 'XLEN',
        'XINFO', 'XPENDING', 'XRANGE', 'XREAD', 'XREVRANGE', 'ZCARD', 'ZCOUNT', 'ZLEXCOUNT',
        'ZRANGE', 'ZRANGEBYLEX', 'ZRANGEBYSCORE', 'ZRANK', 'ZREVRANGE', 'ZREVRANGEBYLEX',
        'ZREVRANGEBYSCORE', 'ZREVRANK', 'ZSCORE',
    ]), []);

    const commandMayMutate = useCallback((value: string) => {
        const keyword = String(value || '').trim().match(/^[A-Za-z]+/)?.[0]?.toUpperCase() || '';
        return !keyword || !redisReadOnlyCommands.has(keyword);
    }, [redisReadOnlyCommands]);

    const handleEditorMount: OnMount = (editor, monaco) => {
        editorRef.current = editor;
        editor.addCommand(
            monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
            () => handleExecute()
        );

        if (!(window as any).__redisCompletionRegistered) {
            (window as any).__redisCompletionRegistered = true;
            
            const redisCommands = [
                "APPEND", "AUTH", "BGREWRITEAOF", "BGSAVE", "BITCOUNT", "BITFIELD", "BITOP", 
                "BITPOS", "BLPOP", "BRPOP", "BRPOPLPUSH", "BZMPOP", "BZPOPMIN", "BZPOPMAX",
                "CLIENT", "CLUSTER", "COMMAND", "CONFIG", "DBSIZE", "DEBUG", "DECR", "DECRBY",
                "DEL", "DISCARD", "DUMP", "ECHO", "EVAL", "EVALSHA", "EXEC", "EXISTS", "EXPIRE",
                "EXPIREAT", "EXPIRETIME", "FLUSHALL", "FLUSHDB", "GEOADD", "GEODIST", "GEOHASH",
                "GEOPOS", "GEORADIUS", "GEORADIUSBYMEMBER", "GEOSEARCH", "GEOSEARCHSTORE",
                "GET", "GETBIT", "GETDEL", "GETEX", "GETRANGE", "GETSET", "HDEL", "HELLO", 
                "HEXISTS", "HGET", "HGETALL", "HINCRBY", "HINCRBYFLOAT", "HKEYS", "HLEN", 
                "HMGET", "HMSET", "HSCAN", "HSET", "HSETNX", "HSTRLEN", "HVALS", "INCR", 
                "INCRBY", "INCRBYFLOAT", "INFO", "KEYS", "LASTSAVE", "LCS", "LINDEX", "LINSERT",
                "LLEN", "LMOVE", "LMPOP", "LPOP", "LPOS", "LPUSH", "LPUSHX", "LRANGE", "LREM",
                "LSET", "LTRIM", "MEMORY", "MGET", "MIGRATE", "MODULE", "MONITOR", "MOVE", "MSET",
                "MSETNX", "MULTI", "OBJECT", "PERSIST", "PEXPIRE", "PEXPIREAT", "PEXPIRETIME",
                "PFADD", "PFCOUNT", "PFMERGE", "PING", "PSETEX", "PSUBSCRIBE", "PTTL", "PUBLISH",
                "PUBSUB", "PUNSUBSCRIBE", "QUIT", "RANDOMKEY", "READONLY", "READWRITE", "RENAME",
                "RENAMENX", "RESET", "RESTORE", "ROLE", "RPOP", "RPOPLPUSH", "RPUSH", "RPUSHX",
                "SADD", "SAVE", "SCAN", "SCARD", "SCRIPT", "SDIFF", "SDIFFSTORE", "SELECT",
                "SET", "SETBIT", "SETEX", "SETNX", "SETRANGE", "SHUTDOWN", "SINTER", "SINTERCARD",
                "SINTERSTORE", "SISMEMBER", "SLAVEOF", "SLOWLOG", "SMEMBERS", "SMISMEMBER",
                "SMOVE", "SORT", "SORT_RO", "SPOP", "SRANDMEMBER", "SREM", "SSCAN", "STRLEN",
                "SUBSCRIBE", "SUNION", "SUNIONSTORE", "SWAPDB", "SYNC", "TIME", "TOUCH", "TTL",
                "TYPE", "UNLINK", "UNSUBSCRIBE", "UNWATCH", "WAIT", "WATCH", "XACK", "XADD",
                "XAUTOCLAIM", "XCLAIM", "XDEL", "XGROUP", "XINFO", "XLEN", "XPENDING", "XRANGE",
                "XREAD", "XREADGROUP", "XREVRANGE", "XTRIM", "ZADD", "ZCARD", "ZCOUNT", "ZDIFF",
                "ZDIFFSTORE", "ZINCRBY", "ZINTER", "ZINTERCARD", "ZINTERSTORE", "ZLEXCOUNT",
                "ZMPOP", "ZMSCORE", "ZPOPMAX", "ZPOPMIN", "ZRANDMEMBER", "ZRANGE", "ZRANGEBYLEX",
                "ZRANGEBYSCORE", "ZRANK", "ZREM", "ZREMRANGEBYLEX", "ZREMRANGEBYRANK",
                "ZREMRANGEBYSCORE", "ZREVRANGE", "ZREVRANGEBYLEX", "ZREVRANGEBYSCORE", "ZREVRANK",
                "ZSCAN", "ZSCORE", "ZUNION", "ZUNIONSTORE"
            ];
            
            monaco.languages.registerCompletionItemProvider('redis', {
                provideCompletionItems: (model: any, position: any) => {
                    const word = model.getWordUntilPosition(position);
                    const range = {
                        startLineNumber: position.lineNumber,
                        endLineNumber: position.lineNumber,
                        startColumn: word.startColumn,
                        endColumn: word.endColumn
                    };
                    return {
                        suggestions: redisCommands.map(cmd => ({
                            label: cmd,
                            kind: monaco.languages.CompletionItemKind.Keyword,
                            insertText: cmd,
                            range: range,
                            detail: tr('redis_command.completion.detail')
                        }))
                    };
                }
            });
        }
    };

    const handleExecute = async () => {
        const config = getConfig();
        if (!config) return;

        let cmdToExecute = '';
        
        // 1. 获取用户是否有高亮选中的文本
        const selection = editorRef.current?.getSelection();
        if (selection && !selection.isEmpty()) {
            cmdToExecute = editorRef.current?.getModel()?.getValueInRange(selection) || '';
        } else {
            // 没有选中则取全部文本
            cmdToExecute = editorRef.current?.getValue() || '';
        }

        cmdToExecute = cmdToExecute.trim();
        if (!cmdToExecute) {
            message.warning(tr('redis_command.message.command_required'));
            return;
        }

        // 2. 智能解析多行命令
        const commands = parseRedisScriptBlocks(cmdToExecute);
        if (commands.length === 0) return;
        if (commands.some(commandMayMutate)) {
            const approved = await confirmProductionMutation(
                connection,
                tr('connection.production_risk.action.modify_data'),
                `db${redisDB}`,
                tr,
            );
            if (!approved) return;
        }

        setLoading(true);
        const newResults: CommandResult[] = [];

        for (const cmd of commands) {
            const start = Date.now();
            try {
                const res = await (window as any).go.app.App.RedisExecuteCommand(buildRpcConnectionConfig(config), cmd);
                newResults.push({
                    command: cmd,
                    result: res.success ? res.data : null,
                    error: res.success ? undefined : res.message,
                    timestamp: Date.now(),
                    durationMs: Date.now() - start
                });
            } catch (e: any) {
                newResults.push({
                    command: cmd,
                    result: null,
                    error: e?.message || String(e),
                    timestamp: Date.now(),
                    durationMs: Date.now() - start
                });
            }
        }

        setResults(prev => [...prev, ...newResults]);
        setLoading(false);
    };
    
    // Auto scroll to bottom when new results arrive
    useEffect(() => {
        if (resultsEndRef.current) {
            resultsEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [results]);

    const handleClear = () => {
        setResults([]);
    };

    const formatResult = (result: any): React.ReactNode => {
        if (result === null || result === undefined) {
            return <span style={{ color: '#569cd6' }}>(nil)</span>;
        }
        if (typeof result === 'string') {
            // 尝试美化 JSON 字符串
            try {
                const parsed = JSON.parse(result);
                if (typeof parsed === 'object' && parsed !== null) {
                    return (
                        <div style={{ marginTop: 4, padding: 8, background: 'rgba(0,0,0,0.2)', borderRadius: 4 }}>
                            {JSON.stringify(parsed, null, 2)}
                        </div>
                    );
                }
            } catch (e) {
                // not a valid json, just return string
            }
            return <span style={{ color: '#ce9178' }}>"{result}"</span>;
        }
        if (typeof result === 'number') {
            return <span style={{ color: '#b5cea8' }}>(integer) {result}</span>;
        }
        if (Array.isArray(result)) {
            if (result.length === 0) {
                return '(empty array)';
            }
            return (
                <div style={{ marginLeft: 8 }}>
                    {result.map((item, index) => (
                        <div key={index} style={{ display: 'flex' }}>
                            <span style={{ color: '#608b4e', marginRight: 8, userSelect: 'none' }}>{index + 1})</span>
                            <div>{formatResult(item)}</div>
                        </div>
                    ))}
                </div>
            );
        }
        if (typeof result === 'object') {
            return JSON.stringify(result, null, 2);
        }
        return String(result);
    };

    // Resizing logic
    const detachDragListeners = useCallback(() => {
        const listeners = dragListenersRef.current;
        if (!listeners) return;
        dragListenersRef.current = null;
        if (typeof document !== 'undefined') {
            document.removeEventListener('mousemove', listeners.move);
            document.removeEventListener('mouseup', listeners.up);
        }
        if (typeof window !== 'undefined') {
            window.removeEventListener('blur', listeners.blur);
        }
    }, []);

    const restoreDragBodyStyles = useCallback(() => {
        const previous = dragBodyStyleRef.current;
        dragBodyStyleRef.current = null;
        if (!previous || typeof document === 'undefined') return;
        document.body.style.cursor = previous.cursor;
        document.body.style.userSelect = previous.userSelect;
    }, []);

    const finishDrag = useCallback((layoutEditor = true) => {
        dragRef.current = null;
        detachDragListeners();
        restoreDragBodyStyles();
        if (layoutEditor && editorRef.current) {
            editorRef.current.layout();
        }
    }, [detachDragListeners, restoreDragBodyStyles]);

    const handleDragMove = useCallback((e: MouseEvent) => {
        if (!dragRef.current) return;
        if (e.buttons === 0) {
            finishDrag();
            return;
        }
        const delta = e.clientY - dragRef.current.startY;
        let newHeight = dragRef.current.startHeight + delta;
        
        // 限制输入区高度，避免拖拽后压缩掉底部输出区。
        newHeight = clampRedisCommandEditorHeight(
            newHeight,
            containerRef.current?.clientHeight,
        );
        
        setEditorHeight(newHeight);
        
        // 更新编辑器布局
        if (editorRef.current) {
            editorRef.current.layout();
        }
    }, [finishDrag]);

    const handleDragStart = useCallback((e: React.MouseEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();

        finishDrag(false);
        dragRef.current = { startY: e.clientY, startHeight: editorHeight };
        const handleDragEnd = () => finishDrag();
        const handleWindowBlur = () => finishDrag();
        dragListenersRef.current = {
            blur: handleWindowBlur,
            move: handleDragMove,
            up: handleDragEnd,
        };
        document.addEventListener('mousemove', handleDragMove);
        document.addEventListener('mouseup', handleDragEnd);
        window.addEventListener('blur', handleWindowBlur);
        dragBodyStyleRef.current = {
            cursor: document.body.style.cursor,
            userSelect: document.body.style.userSelect,
        };
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
    }, [editorHeight, finishDrag, handleDragMove]);

    useEffect(() => () => {
        finishDrag(false);
    }, [finishDrag]);

    if (!connection) {
        return <div style={{ padding: 20 }}>{tr('redis_command.state.connection_not_found')}</div>;
    }

    return (
        <div
            ref={containerRef}
            data-redis-command-editor="true"
            style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                overflow: 'hidden',
                background: workbenchTheme.appBg,
                color: workbenchTheme.textPrimary,
                backdropFilter: workbenchTheme.backdropFilter,
                WebkitBackdropFilter: workbenchTheme.backdropFilter,
            }}
        >
            {/* Editor Top Pane */}
            <div
                data-redis-command-input-pane="true"
                style={{
                    height: editorHeight,
                    minHeight: REDIS_COMMAND_EDITOR_MIN_HEIGHT,
                    display: 'flex',
                    flexDirection: 'column',
                    background: workbenchTheme.panelBg,
                    borderBottom: workbenchTheme.panelBorder,
                }}
            >
                <div style={{ padding: '8px 12px', borderBottom: workbenchTheme.panelBorder, display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: workbenchTheme.panelBgStrong }}>
                    <Space>
                        <span style={{ fontWeight: 600, color: workbenchTheme.textPrimary }}>{tr('redis_command.title.console')}</span>
                        <span style={{ color: workbenchTheme.textSecondary, fontSize: 13, background: workbenchTheme.statusTagMutedBg, border: workbenchTheme.statusTagMutedBorder, padding: '2px 8px', borderRadius: 12 }}>db{redisDB}</span>
                    </Space>
                    <Space>
                        <Button
                            type="primary"
                            icon={<PlayCircleOutlined />}
                            onClick={handleExecute}
                            loading={loading}
                        >
                            {tr('redis_command.action.execute')}
                        </Button>
                    </Space>
                </div>
                <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                    <Editor
                        theme={darkMode ? 'transparent-dark' : 'transparent-light'}
                        gonaviTypography="code"
                        defaultLanguage="redis"
                        language="redis"
                        value={command}
                        onChange={(value) => setCommand(value || '')}
                        onMount={handleEditorMount}
                        options={{
                            minimap: { enabled: false },
                            lineNumbers: 'on',
                            wordWrap: 'on',
                            scrollBeyondLastLine: false,
                            automaticLayout: true,
                            tabSize: 4,
                            padding: { top: 10, bottom: 10 }
                        }}
                    />
                </div>
            </div>

            {/* Resizer Handle */}
            <div 
                className="horizontal-resizer"
                data-redis-command-resizer="true"
                onMouseDown={handleDragStart}
                style={{ 
                    height: REDIS_COMMAND_RESIZER_HEIGHT,
                    cursor: 'row-resize', 
                    background: workbenchTheme.panelBgStrong,
                    borderTop: workbenchTheme.panelBorder,
                    borderBottom: workbenchTheme.panelBorder,
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    zIndex: 10
                }}
            >
                <div style={{ width: 40, height: 4, background: workbenchTheme.textMuted, borderRadius: 2, opacity: 0.6 }} />
            </div>

            {/* Results Terminal Bottom Pane */}
            <div
                data-redis-command-output-pane="true"
                style={{
                    flex: 1,
                    minHeight: REDIS_COMMAND_OUTPUT_MIN_HEIGHT,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    background: darkMode ? '#111418' : workbenchTheme.panelBg,
                }}
            >
                 <div style={{ padding: '4px 12px', background: darkMode ? '#1b1f27' : workbenchTheme.panelBgStrong, display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: workbenchTheme.panelBorder }}>
                    <span style={{ color: workbenchTheme.textSecondary, fontSize: 12 }}>{tr('redis_command.output.title')}</span>
                    <Button type="text" size="small" icon={<ClearOutlined />} onClick={handleClear} style={{ color: workbenchTheme.textSecondary }}>{tr('redis_command.action.clear_console')}</Button>
                </div>
                <div
                    data-redis-command-output-terminal="true"
                    style={{
                        flex: 1,
                        minHeight: 0,
                        overflow: 'auto',
                        background: darkMode ? '#111418' : '#f8fafc',
                        color: darkMode ? '#d4d4d4' : '#0f172a',
                        fontFamily: 'var(--gn-font-mono)',
                        fontSize: 'var(--gn-font-size-mono, 13px)',
                        lineHeight: '1.62',
                        padding: 12,
                    }}
                >
                    {results.length === 0 ? (
                        <div style={{ color: workbenchTheme.textMuted, textAlign: 'center', marginTop: 40 }}>
                            <div>{tr('redis_command.output.empty_hint')}</div>
                            <div style={{ fontSize: 12, marginTop: 12 }}>
                                {tr('redis_command.output.selection_tip')}
                            </div>
                        </div>
                    ) : (
                        results.map((item, index) => (
                            <div key={item.timestamp + index} style={{ marginBottom: 16 }}>
                                <div style={{ color: '#569cd6', marginBottom: 6, fontWeight: 'bold' }}>
                                    <span style={{ color: '#4CAF50', marginRight: 8 }}>➜</span>
                                    {item.command}
                                    <span style={{ color: workbenchTheme.textMuted, fontSize: 11, marginLeft: 12, fontWeight: 'normal' }}>[{item.durationMs}ms]</span>
                                </div>
                                
                                <div style={{ paddingLeft: 20 }}>
                                    {item.error ? (
                                        <div style={{ color: '#f14c4c', whiteSpace: 'pre-wrap' }}>
                                            (error) {item.error}
                                        </div>
                                    ) : (
                                        <div style={{ whiteSpace: 'pre-wrap' }}>
                                            {formatResult(item.result)}
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))
                    )}
                    <div ref={resultsEndRef} />
                </div>
            </div>
        </div>
    );
};

export default RedisCommandEditor;
