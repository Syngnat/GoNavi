import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { message, Button, InputNumber, Input, Tooltip, Space, Popconfirm } from 'antd';
import { PlusOutlined, CopyOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import Modal from '../common/ResizableDraggableModal';
import { RedisValueTable } from './RedisValueTable';
import type { RedisViewerStateApi } from './useRedisViewerState';
import type { RedisViewerStylesApi } from './useRedisViewerStyles';
import type { RedisViewerKeyLoadingApi } from './useRedisViewerKeyLoading';
import type { RedisViewerKeyActionsApi } from './useRedisViewerKeyActions';
import type { RedisValueFormatterApi } from './redisValueFormatter';
import type { RedisViewerProps } from '../RedisViewer';

export interface CreateRedisZSetValueViewInput {
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

export const createRedisZSetValueView = ({
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
}: CreateRedisZSetValueViewInput) => {
    const renderZSetValue = () => {
        const data = (keyValue.value as Array<{ member: string; score: number }>).map((item, index) => {
            const { displayValue, isBinary, isJson, encoding } = processValueForCurrentView(item.member);
            return { ...item, index, displayMember: displayValue, isBinary, isJson, encoding };
        });

        const handleAddZSetMember = async (member: string, score: number) => {
            const config = getConfig();
            if (!config) return;
            if (!await confirmRedisMutation(`db${redisDB} / ${selectedKey}`)) return;
            try {
                const res = await (window as any).go.app.App.RedisZSetAdd(buildRpcConnectionConfig(config), selectedKey, [{ member, score }]);
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

        const handleRemoveZSetMember = async (member: string) => {
            const config = getConfig();
            if (!config) return;
            if (!await confirmRedisMutation(`db${redisDB} / ${selectedKey}`)) return;
            try {
                const res = await (window as any).go.app.App.RedisZSetRemove(buildRpcConnectionConfig(config), selectedKey, [member]);
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
                                <div>
                                    <div style={{ marginBottom: 8 }}>
                                        <label>{tr('redis_viewer.field.score')}</label>
                                        <InputNumber id="new-zset-score" defaultValue={0} style={{ width: '100%' }} />
                                    </div>
                                    <div>
                                        <label>{tr('redis_viewer.field.member')}</label>
                                        <Input.TextArea id="new-zset-member" rows={4} placeholder={tr('redis_viewer.placeholder.member_value')} />
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
                    }}>{tr('redis_viewer.action.add_member')}</Button>
                </div>
                <RedisValueTable
                    totalCount={keyValue.length}
                    totalLabel={tr('redis_viewer.pagination.total', { count: keyValue.length })}
                    dataSource={data}
                    columns={[
                        { title: tr('redis_viewer.table.score'), dataIndex: 'score', key: 'score', width: 120 },
                        {
                            title: tr('redis_viewer.table.member'),
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
                            width: 120,
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
                                    {!record.isBinary && (
                                        <Button type="text" size="small" icon={<EditOutlined />} onClick={() => {
                                            Modal.confirm({
                                                title: tr('redis_viewer.modal.update_score'),
                                                content: (
                                                    <div>
                                                        <label>{tr('redis_viewer.field.new_score')}</label>
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
                                    <Popconfirm title={tr('redis_viewer.confirm.delete_member')} onConfirm={() => handleRemoveZSetMember(record.member)}>
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
    return { renderZSetValue };
};

export type RedisZSetValueViewApi = ReturnType<typeof createRedisZSetValueView>;
