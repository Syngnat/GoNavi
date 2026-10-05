import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { message, Space, Button, Input, Tooltip, Popconfirm } from 'antd';
import { RedisListPush, RedisListRemove } from '../../../wailsjs/go/app/App';
import {
    PlusOutlined,
    CopyOutlined,
    EyeOutlined,
    EditOutlined,
    DeleteOutlined,
} from '@ant-design/icons';
import Modal from '../common/ResizableDraggableModal';
import { RedisValueTable } from './RedisValueTable';
import type { RedisListSortOrder } from './redisViewerHelpers';
import type { RedisViewerStateApi } from './useRedisViewerState';
import type { RedisViewerStylesApi } from './useRedisViewerStyles';
import type { RedisViewerKeyLoadingApi } from './useRedisViewerKeyLoading';
import type { RedisViewerKeyActionsApi } from './useRedisViewerKeyActions';
import type { RedisValueFormatterApi } from './redisValueFormatter';
import type { RedisViewerProps } from '../RedisViewer';

export interface CreateRedisListValueViewInput {
    keyValue: NonNullable<RedisViewerStateApi['keyValue']>;
    listSortOrder: RedisViewerStateApi['listSortOrder'];
    getConfig: RedisViewerStylesApi['getConfig'];
    confirmRedisMutation: RedisViewerKeyLoadingApi['confirmRedisMutation'];
    redisDB: RedisViewerProps['redisDB'];
    selectedKey: NonNullable<RedisViewerStateApi['selectedKey']>;
    loadKeyValue: RedisViewerKeyActionsApi['loadKeyValue'];
    tr: RedisViewerStateApi['tr'];
    actionButtonStyle: RedisViewerStylesApi['actionButtonStyle'];
    jsonAccentColor: RedisViewerStateApi['jsonAccentColor'];
    jsonEditValueRef: RedisViewerStateApi['jsonEditValueRef'];
    setJsonEditConfig: RedisViewerStateApi['setJsonEditConfig'];
    setJsonEditModalOpen: RedisViewerStateApi['setJsonEditModalOpen'];
    processValueForCurrentView: RedisValueFormatterApi['processValueForCurrentView'];
}

export const createRedisListValueView = ({
    keyValue,
    listSortOrder,
    getConfig,
    confirmRedisMutation,
    redisDB,
    selectedKey,
    loadKeyValue,
    tr,
    actionButtonStyle,
    jsonAccentColor,
    jsonEditValueRef,
    setJsonEditConfig,
    setJsonEditModalOpen,
    processValueForCurrentView,
}: CreateRedisListValueViewInput) => {
    const renderListValue = () => {
        const data = (keyValue.value as string[]).map((value, position) => {
            const index = listSortOrder === 'descend'
                ? keyValue.length - position - 1
                : position;
            const { displayValue, isBinary, isJson, encoding } = processValueForCurrentView(value);
            return { index, value, displayValue, isBinary, isJson, encoding };
        });

        const handleEditListItem = async (index: number, newValue: string) => {
            const config = getConfig();
            if (!config) return;
            if (!await confirmRedisMutation(`db${redisDB} / ${selectedKey} / ${index}`)) return;
            try {
                const res = await (window as any).go.app.App.RedisListSet(buildRpcConnectionConfig(config), selectedKey, index, newValue);
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

        const handleAddListItem = async (value: string, position: 'left' | 'right') => {
            const config = getConfig();
            if (!config) return;
            if (!await confirmRedisMutation(`db${redisDB} / ${selectedKey}`)) return;
            try {
                const res = await RedisListPush(buildRpcConnectionConfig(config), selectedKey, { values: [value], position });
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

        const handleDeleteListItem = async (index: number, value: string) => {
            const config = getConfig();
            if (!config) return;
            if (!await confirmRedisMutation(`db${redisDB} / ${selectedKey} / ${index}`)) return;
            try {
                const res = await RedisListRemove(buildRpcConnectionConfig(config), selectedKey, index, value);
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
                    <Space>
                        <Button size="small" style={actionButtonStyle} icon={<PlusOutlined />} onClick={() => {
                            Modal.confirm({
                                title: tr('redis_viewer.modal.add_element'),
                                content: (
                                    <div>
                                        <Input.TextArea id="new-list-value" rows={4} placeholder={tr('redis_viewer.placeholder.new_element_value')} />
                                    </div>
                                ),
                                onOk: async () => {
                                    const value = (document.getElementById('new-list-value') as HTMLTextAreaElement)?.value;
                                    if (value) {
                                        await handleAddListItem(value, 'right');
                                    }
                                }
                            });
                        }}>{tr('redis_viewer.action.add_list_tail')}</Button>
                        <Button size="small" style={actionButtonStyle} onClick={() => {
                            Modal.confirm({
                                title: tr('redis_viewer.modal.add_element_head'),
                                content: (
                                    <div>
                                        <Input.TextArea id="new-list-value-left" rows={4} placeholder={tr('redis_viewer.placeholder.new_element_value')} />
                                    </div>
                                ),
                                onOk: async () => {
                                    const value = (document.getElementById('new-list-value-left') as HTMLTextAreaElement)?.value;
                                    if (value) {
                                        await handleAddListItem(value, 'left');
                                    }
                                }
                            });
                        }}>{tr('redis_viewer.action.add_list_head')}</Button>
                    </Space>
                </div>
                <RedisValueTable
                    totalCount={keyValue.length}
                    totalLabel={tr('redis_viewer.pagination.total', { count: keyValue.length })}
                    dataSource={data}
                    columns={[
                        {
                            title: tr('redis_viewer.table.index'),
                            dataIndex: 'index',
                            key: 'index',
                            width: 80,
                            sorter: (left: { index: number }, right: { index: number }) => left.index - right.index,
                            sortDirections: ['descend', 'ascend'],
                            sortOrder: listSortOrder,
                        },
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
                            width: 160,
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
                                    <Tooltip title={tr('redis_viewer.tooltip.view_value')}>
                                        <Button
                                            type="text"
                                            size="small"
                                            aria-label={tr('redis_viewer.tooltip.view_value')}
                                            icon={<EyeOutlined />}
                                            onClick={() => {
                                                const viewContent = record.isJson ? record.displayValue : record.value;
                                                jsonEditValueRef.current = viewContent;
                                                setJsonEditConfig({
                                                    mode: 'view',
                                                    title: tr('redis_viewer.modal.view_index', { index: record.index }),
                                                    value: viewContent,
                                                    isJson: record.isJson,
                                                });
                                                setJsonEditModalOpen(true);
                                            }}
                                        />
                                    </Tooltip>
                                    {!record.isBinary && (
                                        <Button type="text" size="small" icon={<EditOutlined />} onClick={() => {
                                            const editContent = record.isJson ? record.displayValue : record.value;
                                            jsonEditValueRef.current = editContent;
                                            setJsonEditConfig({
                                                mode: 'edit',
                                                title: tr('redis_viewer.modal.edit_index', { index: record.index }),
                                                value: editContent,
                                                isJson: record.isJson,
                                                onSave: async (newValue: string) => {
                                                    await handleEditListItem(record.index, newValue);
                                                }
                                            });
                                            setJsonEditModalOpen(true);
                                        }} />
                                    )}
                                    <Popconfirm title={tr('redis_viewer.confirm.delete_list_item')} onConfirm={() => handleDeleteListItem(record.index, record.value)}>
                                        <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                                    </Popconfirm>
                                </Space>
                            )
                        }
                    ]}
                    rowKey="index"
                    onChange={(_pagination, _filters, sorter) => {
                        const nextOrder = Array.isArray(sorter)
                            ? null
                            : (sorter.order || null) as RedisListSortOrder;
                        if (nextOrder !== listSortOrder) {
                            void loadKeyValue(selectedKey, nextOrder);
                        }
                    }}
                />
            </div>
        );
    };
    return { renderListValue };
};

export type RedisListValueViewApi = ReturnType<typeof createRedisListValueView>;
