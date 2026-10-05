import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { message, Button, Form, Input, Tooltip, Space, Popconfirm } from 'antd';
import {
    PlusOutlined,
    SearchOutlined,
    CopyOutlined,
    EditOutlined,
    DeleteOutlined,
} from '@ant-design/icons';
import Modal from '../common/ResizableDraggableModal';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import { RedisValueTable } from './RedisValueTable';
import type { RedisViewerStateApi } from './useRedisViewerState';
import type { RedisViewerStylesApi } from './useRedisViewerStyles';
import type { RedisViewerKeyLoadingApi } from './useRedisViewerKeyLoading';
import type { RedisViewerKeyActionsApi } from './useRedisViewerKeyActions';
import type { RedisValueFormatterApi } from './redisValueFormatter';
import type { RedisViewerProps } from '../RedisViewer';

export interface CreateRedisHashValueViewInput {
    hashFieldFilter: RedisViewerStateApi['hashFieldFilter'];
    hashValueFilter: RedisViewerStateApi['hashValueFilter'];
    keyValue: NonNullable<RedisViewerStateApi['keyValue']>;
    getConfig: RedisViewerStylesApi['getConfig'];
    confirmRedisMutation: RedisViewerKeyLoadingApi['confirmRedisMutation'];
    redisDB: RedisViewerProps['redisDB'];
    selectedKey: NonNullable<RedisViewerStateApi['selectedKey']>;
    loadKeyValue: RedisViewerKeyActionsApi['loadKeyValue'];
    tr: RedisViewerStateApi['tr'];
    actionButtonStyle: RedisViewerStylesApi['actionButtonStyle'];
    setHashFieldFilter: RedisViewerStateApi['setHashFieldFilter'];
    setHashValueFilter: RedisViewerStateApi['setHashValueFilter'];
    jsonAccentColor: RedisViewerStateApi['jsonAccentColor'];
    jsonEditValueRef: RedisViewerStateApi['jsonEditValueRef'];
    setJsonEditConfig: RedisViewerStateApi['setJsonEditConfig'];
    setJsonEditModalOpen: RedisViewerStateApi['setJsonEditModalOpen'];
    processValueForCurrentView: RedisValueFormatterApi['processValueForCurrentView'];
}

export const createRedisHashValueView = ({
    hashFieldFilter,
    hashValueFilter,
    keyValue,
    getConfig,
    confirmRedisMutation,
    redisDB,
    selectedKey,
    loadKeyValue,
    tr,
    actionButtonStyle,
    setHashFieldFilter,
    setHashValueFilter,
    jsonAccentColor,
    jsonEditValueRef,
    setJsonEditConfig,
    setJsonEditModalOpen,
    processValueForCurrentView,
}: CreateRedisHashValueViewInput) => {
    const renderHashValue = () => {
        const fieldQuery = hashFieldFilter.trim().toLowerCase();
        const valueQuery = hashValueFilter.trim().toLowerCase();
        const hasFilter = fieldQuery !== '' || valueQuery !== '';
        const allEntries = Object.entries(keyValue.value as Record<string, string>);
        const filteredEntries = hasFilter
            ? allEntries.filter(([field, value]) => (
                (fieldQuery === '' || field.toLowerCase().includes(fieldQuery))
                && (valueQuery === '' || value.toLowerCase().includes(valueQuery))
            ))
            : allEntries;
        const data = filteredEntries.map(([field, value]) => {
            const { displayValue, isBinary, isJson, encoding } = processValueForCurrentView(value);
            return { field, value, displayValue, isBinary, isJson, encoding };
        });

        const handleEditHashField = async (field: string, newValue: string) => {
            const config = getConfig();
            if (!config) return;
            if (!await confirmRedisMutation(`db${redisDB} / ${selectedKey} / ${field}`)) return;
            try {
                const res = await (window as any).go.app.App.RedisSetHashField(buildRpcConnectionConfig(config), selectedKey, field, newValue);
                if (res.success) {
                    await loadKeyValue(selectedKey);
                    message.success(tr('redis_viewer.message.update_success'));
                } else {
                    message.error(tr('redis_viewer.message.update_failed', { detail: res.message }));
                }
            } catch (e: any) {
                message.error(tr('redis_viewer.message.update_failed', { detail: e?.message || String(e) }));
            }
        };

        const handleDeleteHashField = async (field: string) => {
            const config = getConfig();
            if (!config) return;
            if (!await confirmRedisMutation(`db${redisDB} / ${selectedKey} / ${field}`)) return;
            try {
                const res = await (window as any).go.app.App.RedisDeleteHashField(buildRpcConnectionConfig(config), selectedKey, [field]);
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
                <div className={'gn-v2-redis-value-actionbar'} style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Button size="small" style={actionButtonStyle} icon={<PlusOutlined />} onClick={() => {
                        Modal.confirm({
                            title: tr('redis_viewer.modal.add_field'),
                            content: (
                                <Form id="add-hash-field-form" layout="vertical">
	                                        <Form.Item label={tr('redis_viewer.field.field_name')} name="field" rules={[{ required: true }]}>
	                                            <Input id="new-hash-field" {...noAutoCapInputProps} />
	                                        </Form.Item>
                                    <Form.Item label={tr('redis_viewer.field.value')} name="value" rules={[{ required: true }]}>
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
                    }}>{tr('redis_viewer.action.add_field')}</Button>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flex: '1 1 420px', minWidth: 0, flexWrap: 'wrap' }}>
                        <Input
                            {...noAutoCapInputProps}
                            data-redis-hash-field-filter="true"
                            size="small"
                            allowClear
                            prefix={<SearchOutlined />}
                            value={hashFieldFilter}
                            aria-label={tr('redis_viewer.placeholder.filter_field')}
                            placeholder={tr('redis_viewer.placeholder.filter_field')}
                            onChange={(event) => setHashFieldFilter(event.target.value)}
                            style={{ flex: '1 1 180px', maxWidth: 260 }}
                        />
                        <Input
                            {...noAutoCapInputProps}
                            data-redis-hash-value-filter="true"
                            size="small"
                            allowClear
                            prefix={<SearchOutlined />}
                            value={hashValueFilter}
                            aria-label={tr('redis_viewer.placeholder.filter_value')}
                            placeholder={tr('redis_viewer.placeholder.filter_value')}
                            onChange={(event) => setHashValueFilter(event.target.value)}
                            style={{ flex: '1 1 180px', maxWidth: 320 }}
                        />
                    </div>
                </div>
                <RedisValueTable
                    totalCount={data.length}
                    totalLabel={hasFilter
                        ? tr('redis_viewer.pagination.filtered_total', { matched: data.length, total: allEntries.length })
                        : tr('redis_viewer.pagination.total', { count: allEntries.length })}
                    paginationResetKey={`${selectedKey}\u0000${hashFieldFilter}\u0000${hashValueFilter}`}
                    dataSource={data}
                    columns={[
                        { title: tr('redis_viewer.table.field'), dataIndex: 'field', key: 'field', width: 200, ellipsis: true },
                        {
                            title: tr('redis_viewer.table.value'),
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
                                            navigator.clipboard.writeText(record.value).then(() => {
                                                message.success(tr('redis_viewer.message.copied'));
                                            }).catch(() => {
                                                message.error(tr('redis_viewer.message.copy_failed'));
                                            });
                                        }} />
                                    </Tooltip>
                                    {!record.isBinary && (
                                        <Button type="text" size="small" icon={<EditOutlined />} onClick={() => {
                                            const editContent = record.isJson ? record.displayValue : record.value;
                                            jsonEditValueRef.current = editContent;
                                            setJsonEditConfig({
                                                mode: 'edit',
                                                title: tr('redis_viewer.modal.edit_field', { field: record.field }),
                                                value: editContent,
                                                isJson: record.isJson,
                                                onSave: async (newValue: string) => {
                                                    await handleEditHashField(record.field, newValue);
                                                }
                                            });
                                            setJsonEditModalOpen(true);
                                        }} />
                                    )}
                                    <Popconfirm title={tr('redis_viewer.confirm.delete_field')} onConfirm={() => handleDeleteHashField(record.field)}>
                                        <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                                    </Popconfirm>
                                </Space>
                            )
                        }
                    ]}
                    rowKey="field"
                />
            </div>
        );
    };
    return { renderHashValue };
};

export type RedisHashValueViewApi = ReturnType<typeof createRedisHashValueView>;
