import React, { useRef, useEffect } from 'react';
import { Table, Tag, Button, Tooltip } from 'antd';
import { ClearOutlined, CloseOutlined, CaretRightOutlined, BugOutlined } from '@ant-design/icons';
import { useStore } from '../store';

interface LogPanelProps {
    height: number;
    onClose: () => void;
    onResizeStart: (e: React.MouseEvent) => void;
}

const LogPanel: React.FC<LogPanelProps> = ({ height, onClose, onResizeStart }) => {
    const sqlLogs = useStore(state => state.sqlLogs);
    const clearSqlLogs = useStore(state => state.clearSqlLogs);
    const theme = useStore(state => state.theme);
    const appearance = useStore(state => state.appearance);
    const darkMode = theme === 'dark';

    // Background Helper
    const getBg = (darkHex: string) => {
        if (!darkMode) return `rgba(255, 255, 255, ${appearance.opacity ?? 0.95})`;
        const hex = darkHex.replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${appearance.opacity ?? 0.95})`;
    };
    const bgMain = getBg('#1f1f1f');
    const bgToolbar = getBg('#2a2a2a');

    const columns = [
        {
            title: 'Time',
            dataIndex: 'timestamp',
            width: 80,
            render: (ts: number) => <span style={{ color: '#888', fontSize: '12px' }}>{new Date(ts).toLocaleTimeString()}</span>
        },
        {
            title: 'Status',
            dataIndex: 'status',
            width: 70,
            render: (status: string) => (
                <Tag color={status === 'success' ? 'success' : 'error'} style={{ marginRight: 0 }}>
                    {status === 'success' ? 'OK' : 'ERR'}
                </Tag>
            )
        },
        {
            title: 'Duration',
            dataIndex: 'duration',
            width: 70,
            render: (d: number) => <span style={{ color: d > 1000 ? 'orange' : 'inherit', fontSize: '12px' }}>{d}ms</span>
        },
        {
            title: 'SQL / Message',
            dataIndex: 'sql',
            render: (text: string, record: any) => (
                <div style={{ fontFamily: 'monospace', wordBreak: 'break-all', fontSize: '12px', lineHeight: '1.2' }}>
                    <div style={{ color: darkMode ? '#a6e22e' : '#005cc5' }}>{text}</div>
                    {record.message && <div style={{ color: '#ff4d4f', marginTop: 2 }}>{record.message}</div>}
                    {record.affectedRows !== undefined && <div style={{ color: '#888', marginTop: 1 }}>Affected: {record.affectedRows}</div>}
                </div>
            )
        }
    ];

    return (
        <div style={{ 
            height, 
            borderTop: 'none', 
            background: bgMain,
            backdropFilter: `blur(${appearance.blur ?? 0}px)`,
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
            zIndex: 100 // Ensure above other content
        }}>
            {/* Resize Handle */}
            <div 
                onMouseDown={onResizeStart}
                style={{
                    position: 'absolute',
                    top: -4,
                    left: 0,
                    right: 0,
                    height: 8,
                    cursor: 'row-resize',
                    zIndex: 10
                }}
            />

            {/* Toolbar */}
            <div style={{ 
                padding: '4px 8px', 
                borderBottom: 'none',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                height: 32
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 'bold', fontSize: '12px' }}>
                    <BugOutlined /> SQL 执行日志
                </div>
                <div>
                    <Tooltip title="清空日志">
                        <Button type="text" size="small" icon={<ClearOutlined />} onClick={clearSqlLogs} />
                    </Tooltip>
                    <Tooltip title="关闭面板">
                        <Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose} />
                    </Tooltip>
                </div>
            </div>

            {/* List */}
            <div style={{ flex: 1, overflow: 'auto' }}>
                <Table 
                    dataSource={sqlLogs} 
                    columns={columns} 
                    size="small" 
                    pagination={false} 
                    rowKey="id"
                    showHeader={false}
                    // scroll={{ y: height - 32 }} // Let flex handle it
                />
            </div>
        </div>
    );
};

export default LogPanel;
