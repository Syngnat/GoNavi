import Editor from '../MonacoEditor';
import { Space, Button, message } from 'antd';
import { CopyOutlined, EditOutlined } from '@ant-design/icons';
import type { RedisViewerStateApi } from './useRedisViewerState';
import type { RedisValueFormatterApi } from './redisValueFormatter';

export interface CreateRedisStringValueViewInput {
    keyValue: NonNullable<RedisViewerStateApi['keyValue']>;
    valueToolbarBg: RedisViewerStateApi['valueToolbarBg'];
    valueToolbarBorder: RedisViewerStateApi['valueToolbarBorder'];
    valueToolbarText: RedisViewerStateApi['valueToolbarText'];
    tr: RedisViewerStateApi['tr'];
    darkMode: RedisViewerStateApi['darkMode'];
    viewMode: RedisViewerStateApi['viewMode'];
    setEditValue: RedisViewerStateApi['setEditValue'];
    setEditModalOpen: RedisViewerStateApi['setEditModalOpen'];
    processValueForCurrentView: RedisValueFormatterApi['processValueForCurrentView'];
}

export const createRedisStringValueView = ({
    keyValue,
    valueToolbarBg,
    valueToolbarBorder,
    valueToolbarText,
    tr,
    darkMode,
    viewMode,
    setEditValue,
    setEditModalOpen,
    processValueForCurrentView,
}: CreateRedisStringValueViewInput) => {
    const renderStringValue = () => {
        const strValue = String(keyValue.value);
        const { displayValue, isBinary, isJson, encoding } = processValueForCurrentView(strValue);

        return (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <div className={'gn-v2-redis-value-subtoolbar'} style={{
                    padding: '4px 8px',
                    background: valueToolbarBg,
                    borderBottom: valueToolbarBorder,
                    display: 'flex',
                    alignItems: 'center'
                }}>
                    <span style={{ fontSize: 12, color: valueToolbarText }}>
                        {encoding && tr('redis_viewer.label.encoding', { encoding })}
                    </span>
                </div>
                <Editor
                    height="calc(100% - 72px)"
                    gonaviTypography="data"
                    language={isJson ? 'json' : 'plaintext'}
                    theme={darkMode ? 'transparent-dark' : 'transparent-light'}
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
                    }}
                />
                <div style={{ padding: '8px 0', flexShrink: 0 }}>
                    <Space>
                        <Button icon={<CopyOutlined />} onClick={() => {
                            navigator.clipboard.writeText(strValue).then(() => {
                                message.success(tr('redis_viewer.message.copied'));
                            }).catch(() => {
                                message.error(tr('redis_viewer.message.copy_failed'));
                            });
                        }}>{tr('redis_viewer.action.copy')}</Button>
                        {!isBinary && viewMode === 'auto' && (
                            <Button icon={<EditOutlined />} onClick={() => {
                                setEditValue(displayValue);
                                setEditModalOpen(true);
                            }}>{tr('redis_viewer.action.edit')}</Button>
                        )}
                        {(isBinary || viewMode !== 'auto') && (
                            <span style={{ color: '#999', fontSize: 12 }}>
                                {viewMode !== 'auto' ? tr('redis_viewer.hint.switch_auto_to_edit') : tr('redis_viewer.hint.binary_readonly')}
                            </span>
                        )}
                    </Space>
                </div>
            </div>
        );
    };
    return { renderStringValue };
};

export type RedisStringValueViewApi = ReturnType<typeof createRedisStringValueView>;
