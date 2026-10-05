import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { message, Button, Input, Tooltip, Space, Popconfirm } from 'antd';
import { PlusOutlined, CopyOutlined, DeleteOutlined } from '@ant-design/icons';
import Modal from '../common/ResizableDraggableModal';
import { RedisValueTable } from './RedisValueTable';
import type { RedisViewerStateApi } from './useRedisViewerState';
import type { RedisViewerStylesApi } from './useRedisViewerStyles';
import type { RedisViewerKeyLoadingApi } from './useRedisViewerKeyLoading';
import type { RedisViewerKeyActionsApi } from './useRedisViewerKeyActions';
import type { RedisValueFormatterApi } from './redisValueFormatter';
import type { RedisViewerProps } from '../RedisViewer';

export interface CreateRedisSetValueViewInput {
    keyValue: NonNullable<RedisViewerStateApi['keyValue']>;
    getConfig: RedisViewerStylesApi['getConfig'];
    confirmRedisMutation: RedisViewerKeyLoadingApi['confirmRedisMutation'];
    redisDB: RedisViewerProps['redisDB'];
    selectedKey: NonNullable<RedisViewerStateApi['selectedKey']>;
    loadKeyValue: RedisViewerKeyActionsApi['loadKeyValue'];
    tr: RedisViewerStateApi['tr'];
    actionButtonStyle: RedisViewerStylesApi['actionButtonStyle'];
    jsonAccentColor: RedisViewerStateApi['jsonAccentColor'];
    processValueForCurrentView: RedisValueFormatterApi['processValueForCurrentView'];
}

export const createRedisSetValueView = ({
    keyValue,
    getConfig,
    confirmRedisMutation,
    redisDB,
    selectedKey,
    loadKeyValue,
    tr,
    actionButtonStyle,
    jsonAccentColor,
    processValueForCurrentView,
}: CreateRedisSetValueViewInput) => {
    const renderSetValue = () => {
        const data = (keyValue.value as string[]).map((member, index) => {
            const { displayValue, isBinary, isJson, encoding } = processValueForCurrentView(member);
            return { index, member, displayValue, isBinary, isJson, encoding };
        });

        const handleAddSetMember = async (member: string) => {
            const config = getConfig();
            if (!config) return;
            if (!await confirmRedisMutation(`db${redisDB} / ${selectedKey}`)) return;
            try {
                const res = await (window as any).go.app.App.RedisSetAdd(buildRpcConnectionConfig(config), selectedKey, [member]);
                if (res.success) {
                    await loadKeyValue(selectedKey);
                    message.success(tr('redis_viewer.message.add_success'));
                } else {
                    message.error(tr('redis_viewer.message.add_failed', { detail: res.message }));
                }
            } catch (e: any) {
                message.error(tr('redis_viewer.message.add_failed', { detail: e?.message || String(e) }));
            }
        };

        const handleRemoveSetMember = async (member: string) => {
            const config = getConfig();
            if (!config) return;
            if (!await confirmRedisMutation(`db${redisDB} / ${selectedKey}`)) return;
            try {
                const res = await (window as any).go.app.App.RedisSetRemove(buildRpcConnectionConfig(config), selectedKey, [member]);
                if (res.success) {
                    await loadKeyValue(selectedKey);
                    message.success(tr('redis_viewer.message.delete_success'));
                } else {
                    message.error(tr('redis_viewer.message.delete_failed', { detail: res.message }));
                }
            } catch (e: any) {
                message.error(tr('redis_viewer.message.delete_failed', { detail: e?.message || String(e) }));
            }
        };

        return (
            <div className={'gn-v2-redis-data-section'} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <div className={'gn-v2-redis-value-actionbar'} style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Button size="small" style={actionButtonStyle} icon={<PlusOutlined />} onClick={() => {
                        Modal.confirm({
                            title: tr('redis_viewer.modal.add_member'),
                            content: (
                                <Input.TextArea id="new-set-member" rows={4} placeholder={tr('redis_viewer.placeholder.new_member_value')} />
                            ),
                            onOk: async () => {
                                const member = (document.getElementById('new-set-member') as HTMLTextAreaElement)?.value;
                                if (member) {
                                    await handleAddSetMember(member);
                                }
                            }
                        });
                    }}>{tr('redis_viewer.action.add_member')}</Button>
                </div>
                <RedisValueTable
                    totalCount={keyValue.length}
                    totalLabel={tr('redis_viewer.pagination.total', { count: keyValue.length })}
                    dataSource={data}
                    columns={[
                        {
                            title: tr('redis_viewer.table.member'),
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
                                            color: record.isBinary ? '#d46b08' : (record.isJson ? jsonAccentColor : undefined),
                                            fontFamily: record.isBinary ? 'var(--gn-font-mono)' : undefined,
                                            fontSize: record.isBinary ? 11 : undefined
                                        }}>
                                            {text}
                                        </span>
                                    </Tooltip>
                                );
                            }
                        },
                        {
                            title: tr('redis_viewer.table.action'),
                            key: 'action',
                            width: 80,
                            render: (_: any, record: any) => (
                                <Space size="small">
                                    <Tooltip title={tr('redis_viewer.tooltip.copy_value')}>
                                        <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => {
                                            navigator.clipboard.writeText(record.member).then(() => {
                                                message.success(tr('redis_viewer.message.copied'));
                                            }).catch(() => {
                                                message.error(tr('redis_viewer.message.copy_failed'));
                                            });
                                        }} />
                                    </Tooltip>
                                    <Popconfirm title={tr('redis_viewer.confirm.delete_member')} onConfirm={() => handleRemoveSetMember(record.member)}>
                                        <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                                    </Popconfirm>
                                </Space>
                            )
                        }
                    ]}
                    rowKey="index"
                />
            </div>
        );
    };
    return { renderSetValue };
};

export type RedisSetValueViewApi = ReturnType<typeof createRedisSetValueView>;
