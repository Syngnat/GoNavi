import { StreamEntry } from '../../types';
import { message, Button, Input, Tooltip, Space, Popconfirm } from 'antd';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { PlusOutlined, CopyOutlined, DeleteOutlined } from '@ant-design/icons';
import Modal from '../common/ResizableDraggableModal';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import { RedisValueTable } from './RedisValueTable';
import type { RedisViewerStateApi } from './useRedisViewerState';
import type { RedisViewerStylesApi } from './useRedisViewerStyles';
import type { RedisViewerKeyLoadingApi } from './useRedisViewerKeyLoading';
import type { RedisViewerKeyActionsApi } from './useRedisViewerKeyActions';
import type { RedisValueFormatterApi } from './redisValueFormatter';
import type { RedisViewerProps } from '../RedisViewer';

export interface CreateRedisStreamValueViewInput {
    keyValue: NonNullable<RedisViewerStateApi['keyValue']>;
    getConfig: RedisViewerStylesApi['getConfig'];
    tr: RedisViewerStateApi['tr'];
    confirmRedisMutation: RedisViewerKeyLoadingApi['confirmRedisMutation'];
    redisDB: RedisViewerProps['redisDB'];
    selectedKey: NonNullable<RedisViewerStateApi['selectedKey']>;
    loadKeyValue: RedisViewerKeyActionsApi['loadKeyValue'];
    actionButtonStyle: RedisViewerStylesApi['actionButtonStyle'];
    jsonAccentColor: RedisViewerStateApi['jsonAccentColor'];
    processValueForCurrentView: RedisValueFormatterApi['processValueForCurrentView'];
}

export const createRedisStreamValueView = ({
    keyValue,
    getConfig,
    tr,
    confirmRedisMutation,
    redisDB,
    selectedKey,
    loadKeyValue,
    actionButtonStyle,
    jsonAccentColor,
    processValueForCurrentView,
}: CreateRedisStreamValueViewInput) => {
    const renderStreamValue = () => {
        const data = (keyValue.value as StreamEntry[]).map((item, index) => {
            const rawFieldsText = JSON.stringify(item.fields ?? {}, null, 2);
            const { displayValue, isBinary, isJson, encoding } = processValueForCurrentView(rawFieldsText);
            return {
                index,
                id: item.id,
                rawFieldsText,
                displayFields: displayValue,
                isBinary,
                isJson,
                encoding,
            };
        });

        const handleAddStreamEntry = async (fieldsText: string, id: string) => {
            const config = getConfig();
            if (!config) return;

            let parsed: unknown;
            try {
                parsed = JSON.parse(fieldsText);
            } catch (e) {
                message.error(tr('redis_viewer.message.fields_json_invalid'));
                return;
            }

            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                message.error(tr('redis_viewer.message.fields_must_be_json_object'));
                return;
            }

            const fieldMap: Record<string, string> = {};
            Object.entries(parsed as Record<string, unknown>).forEach(([field, value]) => {
                fieldMap[field] = value == null ? '' : String(value);
            });

            if (Object.keys(fieldMap).length === 0) {
                message.error(tr('redis_viewer.message.fields_required'));
                return;
            }
            if (!await confirmRedisMutation(`db${redisDB} / ${selectedKey}`)) return;

            try {
                const res = await (window as any).go.app.App.RedisStreamAdd(buildRpcConnectionConfig(config), selectedKey, fieldMap, id || '*');
                if (res.success) {
                    const newID = res.data?.id ? ` (${res.data.id})` : '';
                    await loadKeyValue(selectedKey);
                    message.success(tr('redis_viewer.message.add_success_with_id', { id: newID }));
                } else {
                    message.error(tr('redis_viewer.message.add_failed', { detail: res.message }));
                }
            } catch (e: any) {
                message.error(tr('redis_viewer.message.add_failed', { detail: e?.message || String(e) }));
            }
        };

        const handleDeleteStreamEntry = async (id: string) => {
            const config = getConfig();
            if (!config) return;
            if (!await confirmRedisMutation(`db${redisDB} / ${selectedKey} / ${id}`)) return;

            try {
                const res = await (window as any).go.app.App.RedisStreamDelete(buildRpcConnectionConfig(config), selectedKey, [id]);
                if (res.success) {
                    const deleted = Number(res.data?.deleted ?? 0);
                    await loadKeyValue(selectedKey);
                    if (deleted > 0) {
                        message.success(tr('redis_viewer.message.delete_success'));
                    } else {
                        message.warning(tr('redis_viewer.message.stream_entry_not_deleted'));
                    }
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
                            title: tr('redis_viewer.modal.add_stream_entry'),
                            width: 680,
                            content: (
                                <div>
                                    <div style={{ marginBottom: 8 }}>
                                        <label>{tr('redis_viewer.field.stream_id')}</label>
	                                            <Input id="new-stream-id" {...noAutoCapInputProps} placeholder={tr('redis_viewer.placeholder.stream_id')} />
                                    </div>
                                    <div>
                                        <label>{tr('redis_viewer.field.fields_json')}</label>
                                        <Input.TextArea id="new-stream-fields" rows={8} defaultValue={'{\n  "field": "value"\n}'} />
                                    </div>
                                </div>
                            ),
                            onOk: async () => {
                                const id = (document.getElementById('new-stream-id') as HTMLInputElement)?.value?.trim() || '*';
                                const fieldsText = (document.getElementById('new-stream-fields') as HTMLTextAreaElement)?.value || '{}';
                                await handleAddStreamEntry(fieldsText, id);
                            }
                        });
                    }}>{tr('redis_viewer.action.add_stream_entry')}</Button>
                </div>
                <RedisValueTable
                    totalCount={keyValue.length}
                    totalLabel={tr('redis_viewer.pagination.total', { count: keyValue.length })}
                    dataSource={data}
                    columns={[
                        {
                            title: 'ID',
                            dataIndex: 'id',
                            key: 'id',
                            width: 240,
                            ellipsis: true,
                        },
                        {
                            title: tr('redis_viewer.table.fields'),
                            dataIndex: 'displayFields',
                            key: 'fields',
                            ellipsis: true,
                            render: (text: string, record: any) => {
                                const tooltipContent = record.encoding && record.encoding !== 'UTF-8'
                                    ? `[${record.encoding}]\n${text}`
                                    : text;

                                return (
                                    <Tooltip title={<pre style={{ maxHeight: 300, overflow: 'auto', margin: 0, fontSize: 12 }}>{tooltipContent}</pre>} styles={{ root: { maxWidth: 720 } }}>
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
                            width: 140,
                            render: (_: any, record: any) => (
                                <Space size="small">
                                    <Tooltip title={tr('redis_viewer.tooltip.copy_id')}>
                                        <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => {
                                            navigator.clipboard.writeText(record.id).then(() => {
                                                message.success(tr('redis_viewer.message.copied'));
                                            }).catch(() => {
                                                message.error(tr('redis_viewer.message.copy_failed'));
                                            });
                                        }} />
                                    </Tooltip>
                                    <Tooltip title={tr('redis_viewer.tooltip.copy_fields_json')}>
                                        <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => {
                                            navigator.clipboard.writeText(record.rawFieldsText).then(() => {
                                                message.success(tr('redis_viewer.message.copied'));
                                            }).catch(() => {
                                                message.error(tr('redis_viewer.message.copy_failed'));
                                            });
                                        }} />
                                    </Tooltip>
                                    <Popconfirm title={tr('redis_viewer.confirm.delete_stream_entry')} onConfirm={() => handleDeleteStreamEntry(record.id)}>
                                        <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                                    </Popconfirm>
                                </Space>
                            )
                        }
                    ]}
                    rowKey="id"
                />
            </div>
        );
    };
    return { renderStreamValue };
};

export type RedisStreamValueViewApi = ReturnType<typeof createRedisStreamValueView>;
