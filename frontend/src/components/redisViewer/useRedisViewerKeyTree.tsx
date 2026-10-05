import React, { useEffect, useMemo, useCallback } from 'react';
import {
    REDIS_TREE_HIDE_TTL_THRESHOLD,
    REDIS_LARGE_KEYSPACE_THRESHOLD,
    REDIS_KEY_VIRTUAL_SCROLL_THRESHOLD,
    REDIS_LARGE_KEYSPACE_MAX_EXPANDED_GROUPS,
    type RedisKeyViewMode,
    REDIS_TREE_KEY_TYPE_WIDTH,
    REDIS_TREE_KEY_TYPE_WIDTH_NARROW,
    REDIS_TREE_KEY_TTL_WIDTH,
} from './redisViewerHelpers';
import {
    buildRedisKeyListView,
    buildRedisKeyTypeView,
    buildRedisKeyTree,
    buildLeafNodeKey,
    buildCheckedTreeNodeState,
    parseRawKeyFromNodeKey,
    type RedisTreeDataNode,
    applyTreeNodeCheck,
    isGroupFullyChecked,
} from '../redisViewerTree';
import type { DataNode } from 'antd/es/tree';
import { Space, Tag, Tooltip, Button } from 'antd';
import {
    DownOutlined,
    RightOutlined,
    TagsOutlined,
    FolderOpenOutlined,
    SearchOutlined,
    KeyOutlined,
} from '@ant-design/icons';
import type { RedisViewerStateApi } from './useRedisViewerState';
import type { RedisViewerKeyActionsApi } from './useRedisViewerKeyActions';
import type { RedisViewerKeyLoadingApi } from './useRedisViewerKeyLoading';

export interface UseRedisViewerKeyTreeInput {
    leftPanelRef: RedisViewerStateApi['leftPanelRef'];
    setShowTreeKeyTTL: RedisViewerStateApi['setShowTreeKeyTTL'];
    treeContainerRef: RedisViewerStateApi['treeContainerRef'];
    setTreeHeight: RedisViewerStateApi['setTreeHeight'];
    keys: RedisViewerStateApi['keys'];
    keyViewMode: RedisViewerStateApi['keyViewMode'];
    expandedTreeGroupKeys: RedisViewerStateApi['expandedTreeGroupKeys'];
    expandedTypeGroupKeys: RedisViewerStateApi['expandedTypeGroupKeys'];
    setExpandedTreeGroupKeys: RedisViewerStateApi['setExpandedTreeGroupKeys'];
    setExpandedTypeGroupKeys: RedisViewerStateApi['setExpandedTypeGroupKeys'];
    selectedKey: RedisViewerStateApi['selectedKey'];
    selectedKeys: RedisViewerStateApi['selectedKeys'];
    setSelectedKeys: RedisViewerStateApi['setSelectedKeys'];
    treeContextMenu: RedisViewerStateApi['treeContextMenu'];
    setTreeContextMenu: RedisViewerStateApi['setTreeContextMenu'];
    loadKeyValue: RedisViewerKeyActionsApi['loadKeyValue'];
    setKeyViewMode: RedisViewerStateApi['setKeyViewMode'];
    setSearchMode: RedisViewerStateApi['setSearchMode'];
    executeSearch: RedisViewerKeyLoadingApi['executeSearch'];
    tr: RedisViewerStateApi['tr'];
    workbenchTheme: RedisViewerStateApi['workbenchTheme'];
    getTypeColor: RedisViewerKeyActionsApi['getTypeColor'];
    showTreeKeyTTL: RedisViewerStateApi['showTreeKeyTTL'];
    formatTTL: RedisViewerKeyActionsApi['formatTTL'];
    keyAccentColor: RedisViewerStateApi['keyAccentColor'];
}

export const useRedisViewerKeyTree = ({
    leftPanelRef,
    setShowTreeKeyTTL,
    treeContainerRef,
    setTreeHeight,
    keys,
    keyViewMode,
    expandedTreeGroupKeys,
    expandedTypeGroupKeys,
    setExpandedTreeGroupKeys,
    setExpandedTypeGroupKeys,
    selectedKey,
    selectedKeys,
    setSelectedKeys,
    treeContextMenu,
    setTreeContextMenu,
    loadKeyValue,
    setKeyViewMode,
    setSearchMode,
    executeSearch,
    tr,
    workbenchTheme,
    getTypeColor,
    showTreeKeyTTL,
    formatTTL,
    keyAccentColor,
}: UseRedisViewerKeyTreeInput) => {
    useEffect(() => {
        const target = leftPanelRef.current;
        if (!target) return;

        const updateTTLVisibility = (width: number) => {
            const nextShowTTL = width > REDIS_TREE_HIDE_TTL_THRESHOLD;
            setShowTreeKeyTTL((prev) => (prev === nextShowTTL ? prev : nextShowTTL));
        };

        updateTTLVisibility(Math.round(target.getBoundingClientRect().width));

        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver((entries) => {
                const width = Math.round(entries[0]?.contentRect.width || target.getBoundingClientRect().width);
                updateTTLVisibility(width);
            });
            observer.observe(target);
            return () => observer.disconnect();
        }

        const handleWindowResize = () => {
            updateTTLVisibility(Math.round(target.getBoundingClientRect().width));
        };
        window.addEventListener('resize', handleWindowResize);
        return () => window.removeEventListener('resize', handleWindowResize);
    }, []);

    useEffect(() => {
        const target = treeContainerRef.current;
        if (!target) return;

        const updateTreeHeight = (nextHeight: number) => {
            if (nextHeight <= 0) return;
            setTreeHeight((prev) => (prev === nextHeight ? prev : nextHeight));
        };

        updateTreeHeight(Math.round(target.getBoundingClientRect().height));

        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver((entries) => {
                const nextHeight = Math.round(entries[0]?.contentRect.height || target.getBoundingClientRect().height);
                updateTreeHeight(nextHeight);
            });
            observer.observe(target);
            return () => observer.disconnect();
        }

        const handleWindowResize = () => {
            updateTreeHeight(Math.round(target.getBoundingClientRect().height));
        };
        window.addEventListener('resize', handleWindowResize);
        return () => window.removeEventListener('resize', handleWindowResize);
    }, []);

    const isLargeKeyspace = keys.length >= REDIS_LARGE_KEYSPACE_THRESHOLD;
    const shouldVirtualizeKeyTree = keys.length > REDIS_KEY_VIRTUAL_SCROLL_THRESHOLD;

    const keyTree = useMemo(() => {
        if (keyViewMode === 'list') {
            return buildRedisKeyListView(keys, !isLargeKeyspace);
        }
        if (keyViewMode === 'type') {
            return buildRedisKeyTypeView(keys, !isLargeKeyspace);
        }
        return buildRedisKeyTree(keys, !isLargeKeyspace);
    }, [isLargeKeyspace, keyViewMode, keys]);

    const groupKeySet = useMemo(() => new Set(keyTree.groupKeys), [keyTree.groupKeys]);
    const expandedGroupKeys = keyViewMode === 'tree'
        ? expandedTreeGroupKeys
        : keyViewMode === 'type'
            ? expandedTypeGroupKeys
            : [];

    const updateExpandedGroupKeys = useCallback((updater: (previousKeys: string[]) => string[]) => {
        if (keyViewMode === 'tree') {
            setExpandedTreeGroupKeys(updater);
            return;
        }
        if (keyViewMode === 'type') {
            setExpandedTypeGroupKeys(updater);
        }
    }, [keyViewMode]);

    const selectedTreeNodeKeys = useMemo(() => {
        if (!selectedKey) {
            return [] as string[];
        }
        return [buildLeafNodeKey(selectedKey)];
    }, [selectedKey]);

    const checkedTreeNodeKeys = useMemo(() => {
        return buildCheckedTreeNodeState(selectedKeys, keyTree);
    }, [keyTree, selectedKeys]);

    useEffect(() => {
        const existingKeySet = new Set(keys.map(item => item.key));
        setSelectedKeys(prev => prev.filter(rawKey => existingKeySet.has(rawKey)));
    }, [keys]);

    useEffect(() => {
        if (keyViewMode === 'list') {
            return;
        }
        updateExpandedGroupKeys((prev) => {
            const validKeys = prev.filter(nodeKey => groupKeySet.has(nodeKey));
            if (!isLargeKeyspace) {
                return validKeys;
            }
            return validKeys.slice(0, REDIS_LARGE_KEYSPACE_MAX_EXPANDED_GROUPS);
        });
    }, [groupKeySet, isLargeKeyspace, keyViewMode, updateExpandedGroupKeys]);

    useEffect(() => {
        if (!treeContextMenu) {
            return;
        }
        const handleDismiss = () => setTreeContextMenu(null);
        window.addEventListener('click', handleDismiss);
        window.addEventListener('scroll', handleDismiss, true);
        window.addEventListener('contextmenu', handleDismiss);
        return () => {
            window.removeEventListener('click', handleDismiss);
            window.removeEventListener('scroll', handleDismiss, true);
            window.removeEventListener('contextmenu', handleDismiss);
        };
    }, [treeContextMenu]);

    const handleTreeSelect = (nodeKeys: React.Key[]) => {
        if (nodeKeys.length === 0) {
            return;
        }
        const rawKey = parseRawKeyFromNodeKey(nodeKeys[0]);
        if (!rawKey) {
            return;
        }
        loadKeyValue(rawKey, null);
    };

    const handleTreeCheck = (
        _checked: React.Key[] | { checked: React.Key[]; halfChecked: React.Key[] },
        info: { checked: boolean; node: DataNode }
    ) => {
        const node = info.node as RedisTreeDataNode;
        setSelectedKeys((prev) => applyTreeNodeCheck(prev, node, info.checked));
    };

    const handleTreeRightClick = ({ event, node }: { event: React.MouseEvent; node: DataNode }) => {
        event.preventDefault();
        event.stopPropagation();
        const treeNode = node as RedisTreeDataNode;
        if (treeNode.nodeType !== 'leaf' || !treeNode.rawKey) {
            setTreeContextMenu(null);
            return;
        }

        setTreeContextMenu({
            x: event.clientX,
            y: event.clientY,
            rawKey: treeNode.rawKey,
        });
    };

    const handleSelectGroupDescendants = useCallback((treeNode: RedisTreeDataNode) => {
        setSelectedKeys((prev) => applyTreeNodeCheck(prev, treeNode, !isGroupFullyChecked(treeNode, prev)));
    }, []);

    const handleToggleGroupExpand = useCallback((groupNodeKey: string) => {
        updateExpandedGroupKeys((prev) => {
            const exists = prev.includes(groupNodeKey);
            const nextKeys = exists
                ? prev.filter((nodeKey) => nodeKey !== groupNodeKey)
                : [...prev, groupNodeKey];

            if (isLargeKeyspace) {
                return nextKeys.slice(-REDIS_LARGE_KEYSPACE_MAX_EXPANDED_GROUPS);
            }

            return nextKeys;
        });
    }, [isLargeKeyspace, updateExpandedGroupKeys]);

    const handleKeyViewModeChange = useCallback((nextMode: RedisKeyViewMode) => {
        setTreeContextMenu(null);
        setKeyViewMode(nextMode);
    }, []);

    const handleFilterByGroup = useCallback((treeNode: RedisTreeDataNode) => {
        const groupPath = treeNode.groupPath?.trim();
        if (!groupPath) {
            return;
        }

        setSearchMode('prefix');
        executeSearch(groupPath, 'prefix');
    }, [executeSearch]);

    const stopTreeTitleEvent = (event: React.SyntheticEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
    };

    const renderTreeNodeTitle = useCallback((nodeData: DataNode) => {
        const treeNode = nodeData as RedisTreeDataNode;

        if (treeNode.nodeType === 'group') {
            const groupFullyChecked = isGroupFullyChecked(treeNode, selectedKeys);
            const groupNodeKey = String(treeNode.key ?? '');
            const isExpanded = expandedGroupKeys.includes(groupNodeKey);
            const isTypeGroup = treeNode.groupKind === 'type';
            return (
                <div
                    role="button"
                    tabIndex={0}
                    onMouseDown={stopTreeTitleEvent}
                    onClick={(event) => {
                        stopTreeTitleEvent(event);
                        handleToggleGroupExpand(groupNodeKey);
                    }}
                    onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') {
                            return;
                        }
                        stopTreeTitleEvent(event);
                        handleToggleGroupExpand(groupNodeKey);
                    }}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        width: '100%',
                        minWidth: 0,
                        padding: '2px 0',
                        cursor: 'pointer',
                    }}
                >
                    <Space size={6} style={{ minWidth: 0, overflow: 'hidden' }}>
                        <button
                            type="button"
                            className="redis-tree-expander-button"
                            aria-label={isExpanded ? tr('redis_viewer.aria.collapse_group') : tr('redis_viewer.aria.expand_group')}
                            onMouseDown={stopTreeTitleEvent}
                            onClick={(event) => {
                                stopTreeTitleEvent(event);
                                handleToggleGroupExpand(groupNodeKey);
                            }}
                            style={{
                                width: 18,
                                height: 18,
                                padding: 0,
                                border: 'none',
                                background: 'transparent',
                                color: workbenchTheme.textMuted,
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                borderRadius: 6,
                                cursor: 'pointer',
                                flexShrink: 0,
                            }}
                        >
                            {isExpanded ? <DownOutlined style={{ fontSize: 11 }} /> : <RightOutlined style={{ fontSize: 11 }} />}
                        </button>
                        {isTypeGroup ? (
                            <Tag
                                color={getTypeColor(treeNode.groupName ?? 'unknown')}
                                style={{ marginInlineEnd: 0, borderRadius: 999, fontWeight: 600, flexShrink: 0 }}
                            >
                                <TagsOutlined style={{ marginRight: 4 }} />
                                {treeNode.groupName}
                            </Tag>
                        ) : (
                            <>
                                <FolderOpenOutlined style={{ color: workbenchTheme.textMuted }} />
                                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {treeNode.groupName}
                                </span>
                            </>
                        )}
                        <span style={{ fontSize: 12, color: workbenchTheme.textMuted, flexShrink: 0 }}>({treeNode.groupLeafCount ?? 0})</span>
                    </Space>
                    <Space size={6} style={{ flexShrink: 0 }}>
                        {treeNode.groupKind === 'namespace' && (
                            <Tooltip title={tr('redis_viewer.action.filter_group')}>
                                <Button
                                    size="small"
                                    className="redis-tree-group-filter-button"
                                    aria-label={tr('redis_viewer.action.filter_group')}
                                    icon={<SearchOutlined />}
                                    style={{
                                        width: 26,
                                        height: 26,
                                        padding: 0,
                                        borderRadius: 999,
                                        borderColor: workbenchTheme.actionSecondaryBorder,
                                        background: workbenchTheme.actionSecondaryBg,
                                        color: workbenchTheme.accent,
                                        boxShadow: 'none',
                                    }}
                                    onMouseDown={stopTreeTitleEvent}
                                    onClick={(event) => {
                                        stopTreeTitleEvent(event);
                                        handleFilterByGroup(treeNode);
                                    }}
                                />
                            </Tooltip>
                        )}
                        <Button
                            size="small"
                            style={{
                                paddingInline: 10,
                                height: 26,
                                borderRadius: 999,
                                flexShrink: 0,
                                borderColor: workbenchTheme.accentBorder,
                                background: workbenchTheme.accentSoft,
                                color: workbenchTheme.accent,
                                fontWeight: 600,
                            }}
                            onMouseDown={stopTreeTitleEvent}
                            onClick={(event) => {
                                stopTreeTitleEvent(event);
                                handleSelectGroupDescendants(treeNode);
                            }}
                        >
                            {groupFullyChecked ? tr('redis_viewer.action.clear_group_selection') : tr('redis_viewer.action.select_group')}
                        </Button>
                    </Space>
                </div>
            );
        }

        const leafLabel = treeNode.leafLabel ?? '';
        const rawKey = treeNode.rawKey ?? parseRawKeyFromNodeKey(treeNode.key ?? '') ?? '';
        const keyType = treeNode.keyType ?? 'unknown';
        const ttl = typeof treeNode.ttl === 'number' ? treeNode.ttl : -1;

        if (isLargeKeyspace) {
            return (
                <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: workbenchTheme.textPrimary }}>
                    <span>{leafLabel}</span>
                    {keyViewMode !== 'type' && (
                        <span style={{ marginLeft: 8, color: workbenchTheme.textMuted, fontSize: 12 }}>[{keyType}]</span>
                    )}
                    {showTreeKeyTTL && (
                        <span style={{ marginLeft: 8, color: workbenchTheme.textMuted, fontSize: 12 }}>{formatTTL(ttl)}</span>
                    )}
                </div>
            );
        }

        return (
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    minWidth: 0,
                    width: '100%',
                    overflow: 'hidden',
                }}
            >
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        minWidth: 0,
                        flex: 1,
                        overflow: 'hidden',
                    }}
                >
                    <KeyOutlined style={{ color: keyAccentColor, flexShrink: 0 }} />
                    <Tooltip title={rawKey}>
                        <span
                            style={{
                                minWidth: 0,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                display: 'block',
                            }}
                        >
                            {leafLabel}
                        </span>
                    </Tooltip>
                </div>
                {keyViewMode !== 'type' && (
                    <Tag
                        color={getTypeColor(keyType)}
                        style={{
                            marginInlineEnd: 0,
                            width: showTreeKeyTTL ? REDIS_TREE_KEY_TYPE_WIDTH : REDIS_TREE_KEY_TYPE_WIDTH_NARROW,
                            textAlign: 'center',
                            flexShrink: 0,
                            borderRadius: 999,
                            fontWeight: 600,
                        }}
                    >
                        {keyType}
                    </Tag>
                )}
                {showTreeKeyTTL && (
                    <span
                        style={{
                            width: REDIS_TREE_KEY_TTL_WIDTH,
                            fontSize: 12,
                            color: workbenchTheme.textMuted,
                            textAlign: 'left',
                            whiteSpace: 'nowrap',
                            flexShrink: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                        }}
                    >
                        {formatTTL(ttl)}
                    </span>
                )}
            </div>
        );
    }, [expandedGroupKeys, formatTTL, getTypeColor, handleFilterByGroup, handleSelectGroupDescendants, handleToggleGroupExpand, isLargeKeyspace, keyAccentColor, keyViewMode, selectedKeys, showTreeKeyTTL, tr, workbenchTheme]);

    const handleTreeExpand = (nextExpandedKeys: React.Key[]) => {
        const validGroupKeys = nextExpandedKeys
            .map(key => String(key))
            .filter(nodeKey => groupKeySet.has(nodeKey));
        if (isLargeKeyspace) {
            updateExpandedGroupKeys(() => validGroupKeys.slice(0, REDIS_LARGE_KEYSPACE_MAX_EXPANDED_GROUPS));
            return;
        }
        updateExpandedGroupKeys(() => validGroupKeys);
    };
    return {
        isLargeKeyspace,
        shouldVirtualizeKeyTree,
        keyTree,
        expandedGroupKeys,
        selectedTreeNodeKeys,
        checkedTreeNodeKeys,
        handleTreeSelect,
        handleTreeCheck,
        handleTreeRightClick,
        handleKeyViewModeChange,
        renderTreeNodeTitle,
        handleTreeExpand,
    };
};

export type RedisViewerKeyTreeApi = ReturnType<typeof useRedisViewerKeyTree>;
