import type { RedisKeyViewMode } from './redisViewerHelpers';
import React from 'react';
import { PartitionOutlined, UnorderedListOutlined, TagsOutlined } from '@ant-design/icons';
import type { RedisViewerStateApi } from './useRedisViewerState';

export interface CreateRedisKeyViewLabelsInput {
    tr: RedisViewerStateApi['tr'];
    keyViewMode: RedisViewerStateApi['keyViewMode'];
    showTreeKeyTTL: RedisViewerStateApi['showTreeKeyTTL'];
}

export const createRedisKeyViewLabels = ({ tr, keyViewMode, showTreeKeyTTL }: CreateRedisKeyViewLabelsInput) => {
    const keyViewOptions: Array<{ mode: RedisKeyViewMode; label: string; icon: React.ReactNode }> = [
        { mode: 'tree', label: tr('redis_viewer.key_view.tree'), icon: <PartitionOutlined /> },
        { mode: 'list', label: tr('redis_viewer.key_view.list'), icon: <UnorderedListOutlined /> },
        { mode: 'type', label: tr('redis_viewer.key_view.type'), icon: <TagsOutlined /> },
    ];
    const keyColumnTitle = keyViewMode === 'tree'
        ? tr('redis_viewer.title.namespace_key')
        : keyViewMode === 'type'
            ? tr('redis_viewer.title.type_key')
            : tr('redis_viewer.field.key');
    const keyMetaColumnTitle = keyViewMode === 'type'
        ? (showTreeKeyTTL ? tr('redis_viewer.title.ttl') : '')
        : (showTreeKeyTTL ? tr('redis_viewer.title.type_ttl') : tr('redis_viewer.title.type'));
    return { keyViewOptions, keyColumnTitle, keyMetaColumnTitle };
};

export type RedisKeyViewLabelsApi = ReturnType<typeof createRedisKeyViewLabels>;
