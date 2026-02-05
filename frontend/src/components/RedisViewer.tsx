import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Table, Input, Button, Space, Tag, message, Modal, Form, InputNumber, Popconfirm, Tooltip, Radio } from 'antd';
import { ReloadOutlined, DeleteOutlined, PlusOutlined, EditOutlined, SearchOutlined, ClockCircleOutlined, CopyOutlined } from '@ant-design/icons';
import { useStore } from '../store';
import { RedisKeyInfo, RedisValue } from '../types';
import Editor from '@monaco-editor/react';
import type { ColumnType } from 'antd/es/table';

const { Search } = Input;

interface RedisViewerProps {
    connectionId: string;
    redisDB: number;
}

// 尝试多种方式解码二进制数据
const tryDecodeValue = (value: string): { displayValue: string; encoding: string; needsHex: boolean } => {
    if (!value || value.length === 0) {
        return { displayValue: '', encoding: 'UTF-8', needsHex: false };
    }

    // 统计字节分布
    let nullCount = 0;
    let printableCount = 0;
    let highByteCount = 0;
    const sampleSize = Math.min(value.length, 200);

    for (let i = 0; i < sampleSize; i++) {
        const code = value.charCodeAt(i);
        if (code === 0) {
            nullCount++;
        } else if (code >= 32 && code < 127) {
            printableCount++;
        } else if (code >= 128) {
            highByteCount++;
        }
    }

    // 如果超过30%是null字节，很可能是二进制数据，显示十六进制
    if (nullCount / sampleSize > 0.3) {
        return { displayValue: toHexDisplay(value), encoding: 'HEX', needsHex: true };
    }

    // 如果超过70%是可打印ASCII字符，直接显示
    if (printableCount / sampleSize > 0.7) {
        return { displayValue: value, encoding: 'UTF-8', needsHex: false };
    }

    // 尝试UTF-8解码
    if (highByteCount > 0) {
        try {
            const bytes = new Uint8Array(value.length);
            for (let i = 0; i < value.length; i++) {
                bytes[i] = value.charCodeAt(i) & 0xFF;
            }
            const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

            // 检查解码质量
            let validChars = 0;
            let replacementChars = 0;
            let controlChars = 0;

            for (let i = 0; i < Math.min(decoded.length, 200); i++) {
                const code = decoded.charCodeAt(i);
                if (code === 0xFFFD) {
                    replacementChars++;
                } else if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
                    controlChars++;
                } else if ((code >= 32 && code < 127) || (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3000 && code <= 0x303F)) {
                    // ASCII可打印字符、中文字符、中文标点
                    validChars++;
                }
            }

            const totalChecked = Math.min(decoded.length, 200);

            // 如果替换字符超过10%或控制字符超过20%，说明不是有效的UTF-8文本
            if (replacementChars / totalChecked > 0.1 || controlChars / totalChecked > 0.2) {
                return { displayValue: toHexDisplay(value), encoding: 'HEX', needsHex: true };
            }

            // 如果有效字符超过50%，使用UTF-8解码
            if (validChars / totalChecked > 0.5) {
                return { displayValue: decoded, encoding: 'UTF-8', needsHex: false };
            }
        } catch (e) {
            // UTF-8解码失败
        }
    }

    // 默认显示十六进制
    return { displayValue: toHexDisplay(value), encoding: 'HEX', needsHex: true };
};

// 检测是否为二进制数据（包含大量不可打印字符）
const isBinaryData = (value: string): boolean => {
    if (!value || value.length === 0) return false;
    // 检查前 100 个字符中不可打印字符的比例
    const sampleSize = Math.min(value.length, 100);
    let nonPrintableCount = 0;
    for (let i = 0; i < sampleSize; i++) {
        const code = value.charCodeAt(i);
        // 不可打印字符：控制字符（0-31，除了 9, 10, 13）和 DEL（127）
        if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127 || code > 255) {
            nonPrintableCount++;
        }
    }
    // 如果超过 10% 是不可打印字符，认为是二进制数据
    return nonPrintableCount / sampleSize > 0.1;
};

// 将字符串转换为十六进制显示
const toHexDisplay = (value: string): string => {
    const bytes: string[] = [];
    const ascii: string[] = [];
    let result = '';

    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        bytes.push(code.toString(16).padStart(2, '0').toUpperCase());
        // 可打印 ASCII 字符显示原字符，否则显示点
        ascii.push(code >= 32 && code < 127 ? value[i] : '.');

        if (bytes.length === 16 || i === value.length - 1) {
            const offset = (Math.floor(i / 16) * 16).toString(16).padStart(8, '0').toUpperCase();
            const hexPart = bytes.join(' ').padEnd(47, ' ');
            const asciiPart = ascii.join('');
            result += `${offset}  ${hexPart}  |${asciiPart}|\n`;
            bytes.length = 0;
            ascii.length = 0;
        }
    }
    return result;
};

// 尝试解析并格式化 JSON
const tryFormatJson = (value: string): { isJson: boolean; formatted: string } => {
    try {
        const parsed = JSON.parse(value);
        return { isJson: true, formatted: JSON.stringify(parsed, null, 2) };
    } catch {
        return { isJson: false, formatted: value };
    }
};

// 格式化字符串值 - 支持 JSON、二进制数据检测和智能解码
const formatStringValue = (value: string): { displayValue: string; isBinary: boolean; isJson: boolean; encoding?: string } => {
    // 先检测是否为二进制数据
    if (isBinaryData(value)) {
        const { displayValue, encoding, needsHex } = tryDecodeValue(value);
        return { displayValue, isBinary: needsHex, isJson: false, encoding };
    }
    // 尝试 JSON 格式化
    const { isJson, formatted } = tryFormatJson(value);
    return { displayValue: formatted, isBinary: false, isJson, encoding: 'UTF-8' };
};

// 可拖拽分隔条组件 - 使用直接 DOM 操作避免卡顿
const ResizableDivider: React.FC<{
    onResizeEnd: (newWidth: number) => void;
    targetRef: React.RefObject<HTMLDivElement>;
    minWidth?: number;
}> = ({ onResizeEnd, targetRef, minWidth = 300 }) => {
    const handleMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        const target = targetRef.current;
        if (!target) return;

        const startX = e.clientX;
        const startWidth = target.offsetWidth;
        const containerWidth = target.parentElement?.offsetWidth || window.innerWidth;
        const maxWidth = containerWidth - 350; // 右侧至少留 350px

        // 创建遮罩层防止文本选择和其他交互
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;cursor:col-resize;z-index:9999;';
        document.body.appendChild(overlay);

        let currentWidth = startWidth;

        const handleMouseMove = (moveEvent: MouseEvent) => {
            moveEvent.preventDefault();
            const delta = moveEvent.clientX - startX;
            currentWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + delta));
            // 直接操作 DOM，不触发 React 重渲染
            target.style.width = `${currentWidth}px`;
            target.style.flexBasis = `${currentWidth}px`;
        };

        const handleMouseUp = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            document.body.removeChild(overlay);
            // 拖拽结束时才更新 React state
            onResizeEnd(currentWidth);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    };

    return (
        <div
            onMouseDown={handleMouseDown}
            style={{
                width: 6,
                cursor: 'col-resize',
                background: '#f0f0f0',
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#d9d9d9')}
            onMouseLeave={(e) => (e.currentTarget.style.background = '#f0f0f0')}
        >
            <div style={{ width: 2, height: 30, background: '#bfbfbf', borderRadius: 1 }} />
        </div>
    );
};

// 可拖拽列头组件 - 纯 DOM 操作实现
const ResizableTitle: React.FC<any> = (props) => {
    const { onResize, width, children, ...restProps } = props;
    const thRef = useRef<HTMLTableCellElement>(null);

    // 如果没有 onResize 或 width，说明这列不需要拖拽（如复选框列）
    if (!onResize || !width) {
        return <th {...restProps}>{children}</th>;
    }

    const handleMouseDown = (e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();

        const startX = e.clientX;
        const startWidth = width;
        const th = thRef.current;
        if (!th) return;

        // 找到对应的 colgroup col 元素来同步更新列宽
        const table = th.closest('table');
        const thIndex = Array.from(th.parentElement?.children || []).indexOf(th);
        const col = table?.querySelector(`colgroup col:nth-child(${thIndex + 1})`) as HTMLElement | null;

        // 创建遮罩层防止文本选择
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;cursor:col-resize;z-index:9999;';
        document.body.appendChild(overlay);

        let currentWidth = startWidth;

        const handleMouseMove = (moveEvent: MouseEvent) => {
            moveEvent.preventDefault();
            const delta = moveEvent.clientX - startX;
            currentWidth = Math.max(50, startWidth + delta);
            // 直接操作 DOM
            th.style.width = `${currentWidth}px`;
            if (col) {
                col.style.width = `${currentWidth}px`;
            }
        };

        const handleMouseUp = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            document.body.removeChild(overlay);
            // 拖拽结束时更新 React state
            onResize(null, { size: { width: currentWidth } });
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    };

    return (
        <th
            ref={thRef}
            {...restProps}
            style={{
                ...restProps.style,
                position: 'relative'
            }}
        >
            {children}
            <div
                style={{
                    position: 'absolute',
                    right: 0,
                    top: 0,
                    bottom: 0,
                    width: 10,
                    cursor: 'col-resize',
                    zIndex: 1,
                    background: 'transparent'
                }}
                onMouseDown={handleMouseDown}
                onMouseOver={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.06)'; }}
                onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; }}
            />
        </th>
    );
};

const RedisViewer: React.FC<RedisViewerProps> = ({ connectionId, redisDB }) => {
    const { connections } = useStore();
    const connection = connections.find(c => c.id === connectionId);

    const [keys, setKeys] = useState<RedisKeyInfo[]>([]);
    const [loading, setLoading] = useState(false);
    const [searchPattern, setSearchPattern] = useState('*');
    const [cursor, setCursor] = useState<number>(0);
    const [hasMore, setHasMore] = useState(false);
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [keyValue, setKeyValue] = useState<RedisValue | null>(null);
    const [valueLoading, setValueLoading] = useState(false);
    const [editModalOpen, setEditModalOpen] = useState(false);
    const [editForm] = Form.useForm();
    const [newKeyModalOpen, setNewKeyModalOpen] = useState(false);
    const [newKeyForm] = Form.useForm();
    const [ttlModalOpen, setTtlModalOpen] = useState(false);
    const [ttlForm] = Form.useForm();
    const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
    const [editValue, setEditValue] = useState('');

    // 视图模式状态（用于所有数据类型）
    const [viewMode, setViewMode] = useState<'auto' | 'text' | 'utf8' | 'hex'>('auto');

    // JSON 编辑弹窗状态
    const [jsonEditModalOpen, setJsonEditModalOpen] = useState(false);
    const [jsonEditConfig, setJsonEditConfig] = useState<{
        title: string;
        value: string;
        isJson: boolean;
        onSave: (newValue: string) => Promise<void>;
    } | null>(null);
    const jsonEditValueRef = useRef<string>('');

    // 面板宽度状态和 ref - 默认占据 50% 宽度
    const [leftPanelWidth, setLeftPanelWidth] = useState<number | string>('50%');
    const leftPanelRef = useRef<HTMLDivElement>(null);

    // 列宽状态 - 复选框列约 32px，总宽度需要接近面板宽度
    // Key 列自适应剩余空间，其他列固定宽度
    const [columnWidths, setColumnWidths] = useState({
        key: 220,    // Key 名称，需要较宽
        type: 65,    // 类型标签
        ttl: 80,     // TTL 显示
        action: 50   // 操作按钮
    });

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

    const loadKeys = useCallback(async (pattern: string = '*', fromCursor: number = 0, append: boolean = false) => {
        const config = getConfig();
        if (!config) return;

        setLoading(true);
        try {
            const res = await (window as any).go.app.App.RedisScanKeys(config, pattern, fromCursor, 100);
            if (res.success) {
                const result = res.data;
                if (append) {
                    setKeys(prev => [...prev, ...result.keys]);
                } else {
                    setKeys(result.keys);
                }
                setCursor(result.cursor);
                setHasMore(result.cursor !== 0);
            } else {
                message.error('加载 Key 失败: ' + res.message);
            }
        } catch (e: any) {
            message.error('加载 Key 失败: ' + (e?.message || String(e)));
        } finally {
            setLoading(false);
        }
    }, [getConfig]);

    useEffect(() => {
        loadKeys(searchPattern, 0, false);
    }, [redisDB]);

    const handleSearch = (value: string) => {
        const pattern = value.trim() || '*';
        setSearchPattern(pattern);
        setCursor(0);
        loadKeys(pattern, 0, false);
    };

    const handleLoadMore = () => {
        loadKeys(searchPattern, cursor, true);
    };

    const handleRefresh = () => {
        setCursor(0);
        loadKeys(searchPattern, 0, false);
    };

    const loadKeyValue = async (key: string) => {
        const config = getConfig();
        if (!config) return;

        setValueLoading(true);
        try {
            const res = await (window as any).go.app.App.RedisGetValue(config, key);
            if (res.success) {
                setKeyValue(res.data);
                setSelectedKey(key);
            } else {
                message.error('获取值失败: ' + res.message);
            }
        } catch (e: any) {
            message.error('获取值失败: ' + (e?.message || String(e)));
        } finally {
            setValueLoading(false);
        }
    };

    const handleDeleteKeys = async (keysToDelete: string[]) => {
        const config = getConfig();
        if (!config) return;

        try {
            const res = await (window as any).go.app.App.RedisDeleteKeys(config, keysToDelete);
            if (res.success) {
                message.success(`已删除 ${res.data.deleted} 个 Key`);
                setKeys(prev => prev.filter(k => !keysToDelete.includes(k.key)));
                if (selectedKey && keysToDelete.includes(selectedKey)) {
                    setSelectedKey(null);
                    setKeyValue(null);
                }
                setSelectedKeys([]);
            } else {
                message.error('删除失败: ' + res.message);
            }
        } catch (e: any) {
            message.error('删除失败: ' + (e?.message || String(e)));
        }
    };

    const handleSetTTL = async () => {
        const config = getConfig();
        if (!config || !selectedKey) return;

        try {
            const values = await ttlForm.validateFields();
            const res = await (window as any).go.app.App.RedisSetTTL(config, selectedKey, values.ttl);
            if (res.success) {
                message.success('TTL 设置成功');
                setTtlModalOpen(false);
                loadKeyValue(selectedKey);
                handleRefresh();
            } else {
                message.error('设置失败: ' + res.message);
            }
        } catch (e: any) {
            message.error('设置失败: ' + (e?.message || String(e)));
        }
    };

    const handleSaveString = async () => {
        const config = getConfig();
        if (!config || !selectedKey) return;

        try {
            const res = await (window as any).go.app.App.RedisSetString(config, selectedKey, editValue, keyValue?.ttl || -1);
            if (res.success) {
                message.success('保存成功');
                setEditModalOpen(false);
                loadKeyValue(selectedKey);
            } else {
                message.error('保存失败: ' + res.message);
            }
        } catch (e: any) {
            message.error('保存失败: ' + (e?.message || String(e)));
        }
    };

    const handleCreateKey = async () => {
        const config = getConfig();
        if (!config) return;

        try {
            const values = await newKeyForm.validateFields();
            const res = await (window as any).go.app.App.RedisSetString(config, values.key, values.value, values.ttl || -1);
            if (res.success) {
                message.success('创建成功');
                setNewKeyModalOpen(false);
                newKeyForm.resetFields();
                handleRefresh();
            } else {
                message.error('创建失败: ' + res.message);
            }
        } catch (e: any) {
            message.error('创建失败: ' + (e?.message || String(e)));
        }
    };

    const getTypeColor = (type: string) => {
        switch (type) {
            case 'string': return 'green';
            case 'hash': return 'blue';
            case 'list': return 'orange';
            case 'set': return 'purple';
            case 'zset': return 'magenta';
            default: return 'default';
        }
    };

    const formatTTL = (ttl: number) => {
        if (ttl === -1) return '永久';
        if (ttl === -2) return '已过期';
        if (ttl < 60) return `${ttl}秒`;
        if (ttl < 3600) return `${Math.floor(ttl / 60)}分${ttl % 60}秒`;
        if (ttl < 86400) return `${Math.floor(ttl / 3600)}时${Math.floor((ttl % 3600) / 60)}分`;
        return `${Math.floor(ttl / 86400)}天${Math.floor((ttl % 86400) / 3600)}时`;
    };

    // 处理列宽调整 - react-resizable 的 onResize 回调格式
    const handleColumnResize = (key: string) => (_e: any, { size }: { size: { width: number } }) => {
        setColumnWidths(prev => ({ ...prev, [key]: size.width }));
    };

    const columns: ColumnType<RedisKeyInfo>[] = [
        {
            title: 'Key',
            dataIndex: 'key',
            key: 'key',
            width: columnWidths.key,
            ellipsis: true,
            onHeaderCell: (column: any) => ({
                width: column.width,
                onResize: handleColumnResize('key')
            }),
            render: (text: string) => (
                <Tooltip title={text}>
                    <span style={{ cursor: 'pointer' }} onClick={() => loadKeyValue(text)}>{text}</span>
                </Tooltip>
            )
        },
        {
            title: '类型',
            dataIndex: 'type',
            key: 'type',
            width: columnWidths.type,
            onHeaderCell: (column: any) => ({
                width: column.width,
                onResize: handleColumnResize('type')
            }),
            render: (type: string) => <Tag color={getTypeColor(type)}>{type}</Tag>
        },
        {
            title: 'TTL',
            dataIndex: 'ttl',
            key: 'ttl',
            width: columnWidths.ttl,
            onHeaderCell: (column: any) => ({
                width: column.width,
                onResize: handleColumnResize('ttl')
            }),
            render: (ttl: number) => formatTTL(ttl)
        },
        {
            title: '操作',
            key: 'action',
            width: columnWidths.action,
            onHeaderCell: (column: any) => ({
                width: column.width,
                onResize: handleColumnResize('action')
            }),
            render: (_: any, record: RedisKeyInfo) => (
                <Popconfirm title="确定删除此 Key？" onConfirm={() => handleDeleteKeys([record.key])}>
                    <Button type="text" danger size="small" icon={<DeleteOutlined />} />
                </Popconfirm>
            )
        }
    ];

    const renderValueEditor = () => {
        if (!keyValue || !selectedKey) {
            return <div style={{ padding: 20, textAlign: 'center', color: '#999' }}>选择一个 Key 查看详情</div>;
        }

        const renderStringValue = () => {
            const strValue = String(keyValue.value);

            // 根据查看模式生成显示内容
            const getDisplayContent = () => {
                if (viewMode === 'hex') {
                    return { displayValue: toHexDisplay(strValue), isBinary: true, encoding: 'HEX' };
                } else if (viewMode === 'text') {
                    return { displayValue: strValue, isBinary: false, encoding: 'Text' };
                } else if (viewMode === 'utf8') {
                    try {
                        const bytes = new Uint8Array(strValue.length);
                        for (let i = 0; i < strValue.length; i++) {
                            bytes[i] = strValue.charCodeAt(i) & 0xFF;
                        }
                        const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
                        return { displayValue: decoded, isBinary: false, encoding: 'UTF-8' };
                    } catch (e) {
                        return { displayValue: strValue, isBinary: false, encoding: 'UTF-8 (失败)' };
                    }
                } else {
                    // auto mode
                    const { displayValue, isBinary, isJson, encoding } = formatStringValue(strValue);
                    return { displayValue, isBinary, encoding };
                }
            };

            const { displayValue, isBinary, encoding } = getDisplayContent();
            const isJson = viewMode === 'auto' && formatStringValue(strValue).isJson;

            return (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                    <div style={{
                        padding: '4px 8px',
                        background: '#f5f5f5',
                        borderBottom: '1px solid #d9d9d9',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center'
                    }}>
                        <span style={{ fontSize: 12, color: '#666' }}>
                            {encoding && `编码: ${encoding}`}
                        </span>
                        <Radio.Group size="small" value={viewMode} onChange={(e) => setViewMode(e.target.value)}>
                            <Radio.Button value="auto">自动</Radio.Button>
                            <Radio.Button value="text">原始文本</Radio.Button>
                            <Radio.Button value="utf8">UTF-8</Radio.Button>
                            <Radio.Button value="hex">十六进制</Radio.Button>
                        </Radio.Group>
                    </div>
                    <Editor
                        height="calc(100% - 72px)"
                        language={isJson ? 'json' : 'plaintext'}
                        value={displayValue}
                        options={{
                            readOnly: true,
                            minimap: { enabled: false },
                            lineNumbers: 'on',
                            wordWrap: isBinary ? 'off' : 'on',
                            scrollBeyondLastLine: false,
                            automaticLayout: true,
                            folding: true,
                            formatOnPaste: true,
                            fontFamily: isBinary ? 'monospace' : undefined
                        }}
                    />
                    <div style={{ padding: '8px 0', flexShrink: 0 }}>
                        <Space>
                            <Button icon={<CopyOutlined />} onClick={() => {
                                navigator.clipboard.writeText(strValue).then(() => {
                                    message.success('已复制');
                                }).catch(() => {
                                    message.error('复制失败');
                                });
                            }}>复制</Button>
                            {!isBinary && viewMode === 'auto' && (
                                <Button icon={<EditOutlined />} onClick={() => {
                                    setEditValue(displayValue);
                                    setEditModalOpen(true);
                                }}>编辑</Button>
                            )}
                            {(isBinary || viewMode !== 'auto') && (
                                <span style={{ color: '#999', fontSize: 12 }}>
                                    {viewMode !== 'auto' ? '切换到"自动"模式以编辑' : '二进制数据不支持编辑'}
                                </span>
                            )}
                        </Space>
                    </div>
                </div>
            );
        };

        const renderHashValue = () => {
            // 根据查看模式处理值
            const processValue = (value: string) => {
                if (viewMode === 'hex') {
                    return { displayValue: toHexDisplay(value), isBinary: true, isJson: false, encoding: 'HEX' };
                } else if (viewMode === 'text') {
                    return { displayValue: value, isBinary: false, isJson: false, encoding: 'Text' };
                } else if (viewMode === 'utf8') {
                    try {
                        const bytes = new Uint8Array(value.length);
                        for (let i = 0; i < value.length; i++) {
                            bytes[i] = value.charCodeAt(i) & 0xFF;
                        }
                        const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
                        return { displayValue: decoded, isBinary: false, isJson: false, encoding: 'UTF-8' };
                    } catch (e) {
                        return { displayValue: value, isBinary: false, isJson: false, encoding: 'UTF-8 (失败)' };
                    }
                } else {
                    // auto mode
                    return formatStringValue(value);
                }
            };

            const data = Object.entries(keyValue.value as Record<string, string>).map(([field, value]) => {
                const { displayValue, isBinary, isJson, encoding } = processValue(value);
                return { field, value, displayValue, isBinary, isJson, encoding };
            });

            const handleEditHashField = async (field: string, newValue: string) => {
                const config = getConfig();
                if (!config) return;
                try {
                    const res = await (window as any).go.app.App.RedisSetHashField(config, selectedKey, field, newValue);
                    if (res.success) {
                        message.success('修改成功');
                        loadKeyValue(selectedKey);
                    } else {
                        message.error('修改失败: ' + res.message);
                    }
                } catch (e: any) {
                    message.error('修改失败: ' + (e?.message || String(e)));
                }
            };

            const handleDeleteHashField = async (field: string) => {
                const config = getConfig();
                if (!config) return;
                try {
                    const res = await (window as any).go.app.App.RedisDeleteHashField(config, selectedKey, field);
                    if (res.success) {
                        message.success('删除成功');
                        loadKeyValue(selectedKey);
                    } else {
                        message.error('删除失败: ' + res.message);
                    }
                } catch (e: any) {
                    message.error('删除失败: ' + (e?.message || String(e)));
                }
            };

            return (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                    <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Button size="small" icon={<PlusOutlined />} onClick={() => {
                            Modal.confirm({
                                title: '添加字段',
                                content: (
                                    <Form id="add-hash-field-form" layout="vertical">
                                        <Form.Item label="字段名" name="field" rules={[{ required: true }]}>
                                            <Input id="new-hash-field" />
                                        </Form.Item>
                                        <Form.Item label="值" name="value" rules={[{ required: true }]}>
                                            <Input.TextArea id="new-hash-value" rows={4} />
                                        </Form.Item>
                                    </Form>
                                ),
                                onOk: async () => {
                                    const field = (document.getElementById('new-hash-field') as HTMLInputElement)?.value;
                                    const value = (document.getElementById('new-hash-value') as HTMLTextAreaElement)?.value;
                                    if (field && value !== undefined) {
                                        await handleEditHashField(field, value);
                                    }
                                }
                            });
                        }}>添加字段</Button>
                        <Radio.Group size="small" value={viewMode} onChange={(e) => setViewMode(e.target.value)}>
                            <Radio.Button value="auto">自动</Radio.Button>
                            <Radio.Button value="text">原始文本</Radio.Button>
                            <Radio.Button value="utf8">UTF-8</Radio.Button>
                            <Radio.Button value="hex">十六进制</Radio.Button>
                        </Radio.Group>
                    </div>
                    <Table
                        dataSource={data}
                        columns={[
                            { title: 'Field', dataIndex: 'field', key: 'field', width: 200, ellipsis: true },
                            {
                                title: 'Value',
                                dataIndex: 'displayValue',
                                key: 'value',
                                ellipsis: true,
                                render: (text: string, record: any) => {
                                    const tooltipContent = record.encoding && record.encoding !== 'UTF-8'
                                        ? `[${record.encoding}]\n${text}`
                                        : text;

                                    return (
                                        <Tooltip title={<pre style={{ maxHeight: 300, overflow: 'auto', margin: 0, fontSize: 12 }}>{tooltipContent}</pre>} styles={{ root: { maxWidth: 600 } }}>
                                            <span style={{
                                                color: record.isBinary ? '#d46b08' : (record.isJson ? '#1890ff' : undefined),
                                                fontFamily: record.isBinary ? 'monospace' : undefined,
                                                fontSize: record.isBinary ? 11 : undefined
                                            }}>
                                                {text}
                                            </span>
                                        </Tooltip>
                                    );
                                }
                            },
                            {
                                title: '操作',
                                key: 'action',
                                width: 120,
                                render: (_: any, record: any) => (
                                    <Space size="small">
                                        <Tooltip title="复制值">
                                            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => {
                                                navigator.clipboard.writeText(record.value).then(() => {
                                                    message.success('已复制');
                                                }).catch(() => {
                                                    message.error('复制失败');
                                                });
                                            }} />
                                        </Tooltip>
                                        {!record.isBinary && (
                                            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => {
                                                // 如果是 JSON，格式化显示
                                                const editContent = record.isJson ? record.displayValue : record.value;
                                                setJsonEditConfig({
                                                    title: `编辑字段: ${record.field}`,
                                                    value: editContent,
                                                    isJson: record.isJson,
                                                    onSave: async (newValue: string) => {
                                                        await handleEditHashField(record.field, newValue);
                                                    }
                                                });
                                                setJsonEditModalOpen(true);
                                            }} />
                                        )}
                                        <Popconfirm title="确定删除此字段？" onConfirm={() => handleDeleteHashField(record.field)}>
                                            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                                        </Popconfirm>
                                    </Space>
                                )
                            }
                        ]}
                        rowKey="field"
                        size="small"
                        pagination={{ pageSize: 50 }}
                        scroll={{ y: 'calc(100vh - 350px)' }}
                        style={{ flex: 1 }}
                    />
                </div>
            );
        };

        const renderListValue = () => {
            // 根据查看模式处理值
            const processValue = (value: string) => {
                if (viewMode === 'hex') {
                    return { displayValue: toHexDisplay(value), isBinary: true, isJson: false, encoding: 'HEX' };
                } else if (viewMode === 'text') {
                    return { displayValue: value, isBinary: false, isJson: false, encoding: 'Text' };
                } else if (viewMode === 'utf8') {
                    try {
                        const bytes = new Uint8Array(value.length);
                        for (let i = 0; i < value.length; i++) {
                            bytes[i] = value.charCodeAt(i) & 0xFF;
                        }
                        const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
                        return { displayValue: decoded, isBinary: false, isJson: false, encoding: 'UTF-8' };
                    } catch (e) {
                        return { displayValue: value, isBinary: false, isJson: false, encoding: 'UTF-8 (失败)' };
                    }
                } else {
                    // auto mode
                    return formatStringValue(value);
                }
            };

            const data = (keyValue.value as string[]).map((value, index) => {
                const { displayValue, isBinary, isJson, encoding } = processValue(value);
                return { index, value, displayValue, isBinary, isJson, encoding };
            });

            const handleEditListItem = async (index: number, newValue: string) => {
                const config = getConfig();
                if (!config) return;
                try {
                    const res = await (window as any).go.app.App.RedisListSet(config, selectedKey, index, newValue);
                    if (res.success) {
                        message.success('修改成功');
                        loadKeyValue(selectedKey);
                    } else {
                        message.error('修改失败: ' + res.message);
                    }
                } catch (e: any) {
                    message.error('修改失败: ' + (e?.message || String(e)));
                }
            };

            const handleAddListItem = async (value: string, position: 'left' | 'right') => {
                const config = getConfig();
                if (!config) return;
                try {
                    const res = await (window as any).go.app.App.RedisListPush(config, selectedKey, { values: [value], position });
                    if (res.success) {
                        message.success('添加成功');
                        loadKeyValue(selectedKey);
                    } else {
                        message.error('添加失败: ' + res.message);
                    }
                } catch (e: any) {
                    message.error('添加失败: ' + (e?.message || String(e)));
                }
            };

            return (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                    <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Space>
                            <Button size="small" icon={<PlusOutlined />} onClick={() => {
                                Modal.confirm({
                                    title: '添加元素',
                                    content: (
                                        <div>
                                            <Input.TextArea id="new-list-value" rows={4} placeholder="输入新元素值" />
                                        </div>
                                    ),
                                    onOk: async () => {
                                        const value = (document.getElementById('new-list-value') as HTMLTextAreaElement)?.value;
                                        if (value) {
                                            await handleAddListItem(value, 'right');
                                        }
                                    }
                                });
                            }}>添加到尾部</Button>
                            <Button size="small" onClick={() => {
                                Modal.confirm({
                                    title: '添加元素到头部',
                                    content: (
                                        <div>
                                            <Input.TextArea id="new-list-value-left" rows={4} placeholder="输入新元素值" />
                                        </div>
                                    ),
                                    onOk: async () => {
                                        const value = (document.getElementById('new-list-value-left') as HTMLTextAreaElement)?.value;
                                        if (value) {
                                            await handleAddListItem(value, 'left');
                                        }
                                    }
                                });
                            }}>添加到头部</Button>
                        </Space>
                        <Radio.Group size="small" value={viewMode} onChange={(e) => setViewMode(e.target.value)}>
                            <Radio.Button value="auto">自动</Radio.Button>
                            <Radio.Button value="text">原始文本</Radio.Button>
                            <Radio.Button value="utf8">UTF-8</Radio.Button>
                            <Radio.Button value="hex">十六进制</Radio.Button>
                        </Radio.Group>
                    </div>
                    <Table
                        dataSource={data}
                        columns={[
                            { title: '索引', dataIndex: 'index', key: 'index', width: 80 },
                            {
                                title: '值',
                                dataIndex: 'displayValue',
                                key: 'value',
                                ellipsis: true,
                                render: (text: string, record: any) => {
                                    const tooltipContent = record.encoding && record.encoding !== 'UTF-8'
                                        ? `[${record.encoding}]\n${text}`
                                        : text;

                                    return (
                                        <Tooltip title={<pre style={{ maxHeight: 300, overflow: 'auto', margin: 0, fontSize: 12 }}>{tooltipContent}</pre>} styles={{ root: { maxWidth: 600 } }}>
                                            <span style={{
                                                color: record.isBinary ? '#d46b08' : (record.isJson ? '#1890ff' : undefined),
                                                fontFamily: record.isBinary ? 'monospace' : undefined,
                                                fontSize: record.isBinary ? 11 : undefined
                                            }}>
                                                {text}
                                            </span>
                                        </Tooltip>
                                    );
                                }
                            },
                            {
                                title: '操作',
                                key: 'action',
                                width: 80,
                                render: (_: any, record: any) => (
                                    <Space size="small">
                                        <Tooltip title="复制值">
                                            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => {
                                                navigator.clipboard.writeText(record.value).then(() => {
                                                    message.success('已复制');
                                                }).catch(() => {
                                                    message.error('复制失败');
                                                });
                                            }} />
                                        </Tooltip>
                                        {!record.isBinary && (
                                            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => {
                                                // 如果是 JSON，格式化显示
                                                const editContent = record.isJson ? record.displayValue : record.value;
                                                setJsonEditConfig({
                                                    title: `编辑索引 ${record.index}`,
                                                    value: editContent,
                                                    isJson: record.isJson,
                                                    onSave: async (newValue: string) => {
                                                        await handleEditListItem(record.index, newValue);
                                                    }
                                                });
                                                setJsonEditModalOpen(true);
                                            }} />
                                        )}
                                    </Space>
                                )
                            }
                        ]}
                        rowKey="index"
                        size="small"
                        pagination={{ pageSize: 50 }}
                        scroll={{ y: 'calc(100vh - 350px)' }}
                        style={{ flex: 1 }}
                    />
                </div>
            );
        };

        const renderSetValue = () => {
            // 根据查看模式处理值
            const processValue = (value: string) => {
                if (viewMode === 'hex') {
                    return { displayValue: toHexDisplay(value), isBinary: true, isJson: false, encoding: 'HEX' };
                } else if (viewMode === 'text') {
                    return { displayValue: value, isBinary: false, isJson: false, encoding: 'Text' };
                } else if (viewMode === 'utf8') {
                    try {
                        const bytes = new Uint8Array(value.length);
                        for (let i = 0; i < value.length; i++) {
                            bytes[i] = value.charCodeAt(i) & 0xFF;
                        }
                        const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
                        return { displayValue: decoded, isBinary: false, isJson: false, encoding: 'UTF-8' };
                    } catch (e) {
                        return { displayValue: value, isBinary: false, isJson: false, encoding: 'UTF-8 (失败)' };
                    }
                } else {
                    // auto mode
                    return formatStringValue(value);
                }
            };

            const data = (keyValue.value as string[]).map((member, index) => {
                const { displayValue, isBinary, isJson, encoding } = processValue(member);
                return { index, member, displayValue, isBinary, isJson, encoding };
            });

            const handleAddSetMember = async (member: string) => {
                const config = getConfig();
                if (!config) return;
                try {
                    const res = await (window as any).go.app.App.RedisSetAdd(config, selectedKey, [member]);
                    if (res.success) {
                        message.success('添加成功');
                        loadKeyValue(selectedKey);
                    } else {
                        message.error('添加失败: ' + res.message);
                    }
                } catch (e: any) {
                    message.error('添加失败: ' + (e?.message || String(e)));
                }
            };

            const handleRemoveSetMember = async (member: string) => {
                const config = getConfig();
                if (!config) return;
                try {
                    const res = await (window as any).go.app.App.RedisSetRemove(config, selectedKey, [member]);
                    if (res.success) {
                        message.success('删除成功');
                        loadKeyValue(selectedKey);
                    } else {
                        message.error('删除失败: ' + res.message);
                    }
                } catch (e: any) {
                    message.error('删除失败: ' + (e?.message || String(e)));
                }
            };

            return (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                    <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Button size="small" icon={<PlusOutlined />} onClick={() => {
                            Modal.confirm({
                                title: '添加成员',
                                content: (
                                    <Input.TextArea id="new-set-member" rows={4} placeholder="输入新成员值" />
                                ),
                                onOk: async () => {
                                    const member = (document.getElementById('new-set-member') as HTMLTextAreaElement)?.value;
                                    if (member) {
                                        await handleAddSetMember(member);
                                    }
                                }
                            });
                        }}>添加成员</Button>
                        <Radio.Group size="small" value={viewMode} onChange={(e) => setViewMode(e.target.value)}>
                            <Radio.Button value="auto">自动</Radio.Button>
                            <Radio.Button value="text">原始文本</Radio.Button>
                            <Radio.Button value="utf8">UTF-8</Radio.Button>
                            <Radio.Button value="hex">十六进制</Radio.Button>
                        </Radio.Group>
                    </div>
                    <Table
                        dataSource={data}
                        columns={[
                            {
                                title: '成员',
                                dataIndex: 'displayValue',
                                key: 'member',
                                ellipsis: true,
                                render: (text: string, record: any) => {
                                    const tooltipContent = record.encoding && record.encoding !== 'UTF-8'
                                        ? `[${record.encoding}]\n${text}`
                                        : text;

                                    return (
                                        <Tooltip title={<pre style={{ maxHeight: 300, overflow: 'auto', margin: 0, fontSize: 12 }}>{tooltipContent}</pre>} styles={{ root: { maxWidth: 600 } }}>
                                            <span style={{
                                                color: record.isBinary ? '#d46b08' : (record.isJson ? '#1890ff' : undefined),
                                                fontFamily: record.isBinary ? 'monospace' : undefined,
                                                fontSize: record.isBinary ? 11 : undefined
                                            }}>
                                                {text}
                                            </span>
                                        </Tooltip>
                                    );
                                }
                            },
                            {
                                title: '操作',
                                key: 'action',
                                width: 80,
                                render: (_: any, record: any) => (
                                    <Space size="small">
                                        <Tooltip title="复制值">
                                            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => {
                                                navigator.clipboard.writeText(record.member).then(() => {
                                                    message.success('已复制');
                                                }).catch(() => {
                                                    message.error('复制失败');
                                                });
                                            }} />
                                        </Tooltip>
                                        <Popconfirm title="确定删除此成员？" onConfirm={() => handleRemoveSetMember(record.member)}>
                                            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                                        </Popconfirm>
                                    </Space>
                                )
                            }
                        ]}
                        rowKey="index"
                        size="small"
                        pagination={{ pageSize: 50 }}
                        scroll={{ y: 'calc(100vh - 350px)' }}
                        style={{ flex: 1 }}
                    />
                </div>
            );
        };

        const renderZSetValue = () => {
            // 根据查看模式处理值
            const processValue = (value: string) => {
                if (viewMode === 'hex') {
                    return { displayValue: toHexDisplay(value), isBinary: true, isJson: false, encoding: 'HEX' };
                } else if (viewMode === 'text') {
                    return { displayValue: value, isBinary: false, isJson: false, encoding: 'Text' };
                } else if (viewMode === 'utf8') {
                    try {
                        const bytes = new Uint8Array(value.length);
                        for (let i = 0; i < value.length; i++) {
                            bytes[i] = value.charCodeAt(i) & 0xFF;
                        }
                        const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
                        return { displayValue: decoded, isBinary: false, isJson: false, encoding: 'UTF-8' };
                    } catch (e) {
                        return { displayValue: value, isBinary: false, isJson: false, encoding: 'UTF-8 (失败)' };
                    }
                } else {
                    // auto mode
                    return formatStringValue(value);
                }
            };

            const data = (keyValue.value as Array<{ member: string; score: number }>).map((item, index) => {
                const { displayValue, isBinary, isJson, encoding } = processValue(item.member);
                return { ...item, index, displayMember: displayValue, isBinary, isJson, encoding };
            });

            const handleAddZSetMember = async (member: string, score: number) => {
                const config = getConfig();
                if (!config) return;
                try {
                    const res = await (window as any).go.app.App.RedisZSetAdd(config, selectedKey, [{ member, score }]);
                    if (res.success) {
                        message.success('添加成功');
                        loadKeyValue(selectedKey);
                    } else {
                        message.error('添加失败: ' + res.message);
                    }
                } catch (e: any) {
                    message.error('添加失败: ' + (e?.message || String(e)));
                }
            };

            const handleRemoveZSetMember = async (member: string) => {
                const config = getConfig();
                if (!config) return;
                try {
                    const res = await (window as any).go.app.App.RedisZSetRemove(config, selectedKey, [member]);
                    if (res.success) {
                        message.success('删除成功');
                        loadKeyValue(selectedKey);
                    } else {
                        message.error('删除失败: ' + res.message);
                    }
                } catch (e: any) {
                    message.error('删除失败: ' + (e?.message || String(e)));
                }
            };

            return (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                    <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Button size="small" icon={<PlusOutlined />} onClick={() => {
                            Modal.confirm({
                                title: '添加成员',
                                content: (
                                    <div>
                                        <div style={{ marginBottom: 8 }}>
                                            <label>分数：</label>
                                            <InputNumber id="new-zset-score" defaultValue={0} style={{ width: '100%' }} />
                                        </div>
                                        <div>
                                            <label>成员：</label>
                                            <Input.TextArea id="new-zset-member" rows={4} placeholder="输入成员值" />
                                        </div>
                                    </div>
                                ),
                                onOk: async () => {
                                    const score = parseFloat((document.getElementById('new-zset-score') as HTMLInputElement)?.value || '0');
                                    const member = (document.getElementById('new-zset-member') as HTMLTextAreaElement)?.value;
                                    if (member) {
                                        await handleAddZSetMember(member, score);
                                    }
                                }
                            });
                        }}>添加成员</Button>
                        <Radio.Group size="small" value={viewMode} onChange={(e) => setViewMode(e.target.value)}>
                            <Radio.Button value="auto">自动</Radio.Button>
                            <Radio.Button value="text">原始文本</Radio.Button>
                            <Radio.Button value="utf8">UTF-8</Radio.Button>
                            <Radio.Button value="hex">十六进制</Radio.Button>
                        </Radio.Group>
                    </div>
                    <Table
                        dataSource={data}
                        columns={[
                            { title: '分数', dataIndex: 'score', key: 'score', width: 120 },
                            {
                                title: '成员',
                                dataIndex: 'displayMember',
                                key: 'member',
                                ellipsis: true,
                                render: (text: string, record: any) => {
                                    const tooltipContent = record.encoding && record.encoding !== 'UTF-8'
                                        ? `[${record.encoding}]\n${text}`
                                        : text;

                                    return (
                                        <Tooltip title={<pre style={{ maxHeight: 300, overflow: 'auto', margin: 0, fontSize: 12 }}>{tooltipContent}</pre>} styles={{ root: { maxWidth: 600 } }}>
                                            <span style={{
                                                color: record.isBinary ? '#d46b08' : (record.isJson ? '#1890ff' : undefined),
                                                fontFamily: record.isBinary ? 'monospace' : undefined,
                                                fontSize: record.isBinary ? 11 : undefined
                                            }}>
                                                {text}
                                            </span>
                                        </Tooltip>
                                    );
                                }
                            },
                            {
                                title: '操作',
                                key: 'action',
                                width: 120,
                                render: (_: any, record: any) => (
                                    <Space size="small">
                                        <Tooltip title="复制值">
                                            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => {
                                                navigator.clipboard.writeText(record.member).then(() => {
                                                    message.success('已复制');
                                                }).catch(() => {
                                                    message.error('复制失败');
                                                });
                                            }} />
                                        </Tooltip>
                                        {!record.isBinary && (
                                            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => {
                                                Modal.confirm({
                                                    title: '修改分数',
                                                    content: (
                                                        <div>
                                                            <label>新分数：</label>
                                                            <InputNumber id="edit-zset-score" defaultValue={record.score} style={{ width: '100%' }} />
                                                        </div>
                                                    ),
                                                    onOk: async () => {
                                                        const newScore = parseFloat((document.getElementById('edit-zset-score') as HTMLInputElement)?.value || '0');
                                                        await handleAddZSetMember(record.member, newScore);
                                                    }
                                                });
                                            }} />
                                        )}
                                        <Popconfirm title="确定删除此成员？" onConfirm={() => handleRemoveZSetMember(record.member)}>
                                            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                                        </Popconfirm>
                                    </Space>
                                )
                            }
                        ]}
                        rowKey="index"
                        size="small"
                        pagination={{ pageSize: 50 }}
                        scroll={{ y: 'calc(100vh - 350px)' }}
                        style={{ flex: 1 }}
                    />
                </div>
            );
        };

        return (
            <div style={{ padding: 12, height: '100%', display: 'flex', flexDirection: 'column' }}>
                <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Tooltip title={selectedKey}>
                            <strong style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedKey}</strong>
                        </Tooltip>
                        <Tooltip title="复制 Key 名称">
                            <Button
                                type="text"
                                size="small"
                                icon={<CopyOutlined />}
                                style={{ padding: '0 4px', display: 'flex', alignItems: 'center' }}
                                onClick={() => {
                                    navigator.clipboard.writeText(selectedKey).then(() => {
                                        message.success('已复制 Key 名称');
                                    }).catch(() => {
                                        message.error('复制失败');
                                    });
                                }}
                            />
                        </Tooltip>
                        <Tag color={getTypeColor(keyValue.type)} style={{ margin: 0 }}>{keyValue.type}</Tag>
                        <Tag icon={<ClockCircleOutlined />} style={{ margin: 0 }}>{formatTTL(keyValue.ttl)}</Tag>
                        {keyValue.length > 0 && <Tag style={{ margin: 0 }}>长度: {keyValue.length}</Tag>}
                    </div>
                    <Space>
                        <Button size="small" onClick={() => {
                            ttlForm.setFieldsValue({ ttl: keyValue.ttl > 0 ? keyValue.ttl : -1 });
                            setTtlModalOpen(true);
                        }}>设置 TTL</Button>
                        <Button size="small" onClick={() => loadKeyValue(selectedKey)} icon={<ReloadOutlined />}>刷新</Button>
                    </Space>
                </div>
                <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                    {keyValue.type === 'string' && renderStringValue()}
                    {keyValue.type === 'hash' && renderHashValue()}
                    {keyValue.type === 'list' && renderListValue()}
                    {keyValue.type === 'set' && renderSetValue()}
                    {keyValue.type === 'zset' && renderZSetValue()}
                </div>
            </div>
        );
    };

    if (!connection) {
        return <div style={{ padding: 20 }}>连接不存在</div>;
    }

    return (
        <div style={{ display: 'flex', height: '100%' }}>
            {/* Left: Key List */}
            <div ref={leftPanelRef} style={{ width: leftPanelWidth, minWidth: 300, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
                <div style={{ padding: 8, borderBottom: '1px solid #f0f0f0' }}>
                    <Space.Compact style={{ width: '100%' }}>
                        <Search
                            placeholder="搜索 Key (支持 * 通配符)"
                            defaultValue="*"
                            onSearch={handleSearch}
                            enterButton={<SearchOutlined />}
                        />
                    </Space.Compact>
                    <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between' }}>
                        <Space>
                            <Button size="small" icon={<ReloadOutlined />} onClick={handleRefresh}>刷新</Button>
                            <Button size="small" icon={<PlusOutlined />} onClick={() => setNewKeyModalOpen(true)}>新建</Button>
                        </Space>
                        {selectedKeys.length > 0 && (
                            <Popconfirm title={`确定删除选中的 ${selectedKeys.length} 个 Key？`} onConfirm={() => handleDeleteKeys(selectedKeys)}>
                                <Button size="small" danger icon={<DeleteOutlined />}>删除选中</Button>
                            </Popconfirm>
                        )}
                    </div>
                </div>
                <div style={{ flex: 1, overflow: 'auto' }}>
                    <Table
                        dataSource={keys}
                        columns={columns}
                        rowKey="key"
                        size="small"
                        loading={loading}
                        pagination={false}
                        components={{
                            header: {
                                cell: ResizableTitle
                            }
                        }}
                        rowSelection={{
                            selectedRowKeys: selectedKeys,
                            onChange: (keys) => setSelectedKeys(keys as string[])
                        }}
                        onRow={(record) => ({
                            onClick: () => loadKeyValue(record.key),
                            style: { cursor: 'pointer', background: selectedKey === record.key ? '#e6f7ff' : undefined }
                        })}
                        style={{ width: '100%' }}
                    />
                    {hasMore && (
                        <div style={{ padding: 8, textAlign: 'center' }}>
                            <Button onClick={handleLoadMore} loading={loading}>加载更多</Button>
                        </div>
                    )}
                </div>
            </div>

            {/* Resizable Divider */}
            <ResizableDivider targetRef={leftPanelRef} onResizeEnd={setLeftPanelWidth} />

            {/* Right: Value Viewer */}
            <div style={{ flex: 1, overflow: 'hidden', minWidth: 300 }}>
                {valueLoading ? (
                    <div style={{ padding: 20, textAlign: 'center' }}>加载中...</div>
                ) : (
                    renderValueEditor()
                )}
            </div>

            {/* Edit String Modal */}
            <Modal
                title="编辑值"
                open={editModalOpen}
                onOk={handleSaveString}
                onCancel={() => setEditModalOpen(false)}
                width={800}
                styles={{ body: { height: 500 } }}
            >
                <Editor
                    height="450px"
                    language={tryFormatJson(editValue).isJson ? 'json' : 'plaintext'}
                    value={editValue}
                    onChange={(value) => setEditValue(value || '')}
                    options={{
                        minimap: { enabled: false },
                        lineNumbers: 'on',
                        wordWrap: 'on',
                        scrollBeyondLastLine: false,
                        automaticLayout: true,
                        folding: true
                    }}
                />
            </Modal>

            {/* New Key Modal */}
            <Modal
                title="新建 Key"
                open={newKeyModalOpen}
                onOk={handleCreateKey}
                onCancel={() => setNewKeyModalOpen(false)}
            >
                <Form form={newKeyForm} layout="vertical" initialValues={{ ttl: -1 }}>
                    <Form.Item name="key" label="Key" rules={[{ required: true, message: '请输入 Key' }]}>
                        <Input placeholder="key name" />
                    </Form.Item>
                    <Form.Item name="value" label="值" rules={[{ required: true, message: '请输入值' }]}>
                        <Input.TextArea rows={4} placeholder="value" />
                    </Form.Item>
                    <Form.Item name="ttl" label="TTL (秒)" help="-1 表示永不过期">
                        <InputNumber style={{ width: '100%' }} min={-1} />
                    </Form.Item>
                </Form>
            </Modal>

            {/* TTL Modal */}
            <Modal
                title="设置 TTL"
                open={ttlModalOpen}
                onOk={handleSetTTL}
                onCancel={() => setTtlModalOpen(false)}
            >
                <Form form={ttlForm} layout="vertical">
                    <Form.Item name="ttl" label="TTL (秒)" help="-1 表示永不过期">
                        <InputNumber style={{ width: '100%' }} min={-1} />
                    </Form.Item>
                </Form>
            </Modal>

            {/* JSON Edit Modal with Monaco Editor */}
            <Modal
                title={jsonEditConfig?.title || '编辑'}
                open={jsonEditModalOpen}
                onOk={async () => {
                    if (jsonEditConfig?.onSave) {
                        await jsonEditConfig.onSave(jsonEditValueRef.current);
                    }
                    setJsonEditModalOpen(false);
                }}
                onCancel={() => setJsonEditModalOpen(false)}
                width={800}
                styles={{ body: { height: 500 } }}
            >
                <Editor
                    height="450px"
                    language={jsonEditConfig?.isJson ? 'json' : 'plaintext'}
                    defaultValue={jsonEditConfig?.value || ''}
                    onChange={(value) => { jsonEditValueRef.current = value || ''; }}
                    onMount={(editor) => { jsonEditValueRef.current = jsonEditConfig?.value || ''; }}
                    options={{
                        minimap: { enabled: false },
                        lineNumbers: 'on',
                        wordWrap: 'on',
                        scrollBeyondLastLine: false,
                        automaticLayout: true,
                        folding: true,
                        formatOnPaste: true
                    }}
                />
            </Modal>
        </div>
    );
};

export default RedisViewer;
