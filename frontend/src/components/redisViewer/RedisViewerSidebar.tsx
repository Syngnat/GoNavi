import { Tag, Space, Radio, Input, Button, Popconfirm, Tooltip, Spin, Tree } from 'antd';
import {
    getRedisTopologyTagLabel,
    REDIS_LARGE_KEYSPACE_MAX_EXPANDED_GROUPS,
} from './redisViewerHelpers';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import { SearchOutlined, ReloadOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import type { RedisViewerStateApi } from './useRedisViewerState';
import type { RedisViewerStylesApi } from './useRedisViewerStyles';
import type { RedisViewerKeyLoadingApi } from './useRedisViewerKeyLoading';
import type { RedisViewerImportExportApi } from './useRedisViewerImportExport';
import type { RedisViewerKeyActionsApi } from './useRedisViewerKeyActions';
import type { RedisKeyViewLabelsApi } from './redisKeyViewLabels';
import type { RedisViewerKeyTreeApi } from './useRedisViewerKeyTree';
import type { RedisViewerProps } from '../RedisViewer';

const { Search } = Input;

export interface RedisViewerSidebarProps {
    leftPanelRef: RedisViewerStateApi['leftPanelRef'];
    leftPanelWidth: RedisViewerStateApi['leftPanelWidth'];
    workbenchCardStyle: RedisViewerStylesApi['workbenchCardStyle'];
    workbenchTheme: RedisViewerStateApi['workbenchTheme'];
    tr: RedisViewerStateApi['tr'];
    redisDB: RedisViewerProps['redisDB'];
    mutedPillTagStyle: RedisViewerStylesApi['mutedPillTagStyle'];
    redisTopology: RedisViewerStateApi['redisTopology'];
    redisSeedAddresses: RedisViewerStateApi['redisSeedAddresses'];
    redisSentinelMaster: RedisViewerStateApi['redisSentinelMaster'];
    keys: RedisViewerStateApi['keys'];
    searchMode: RedisViewerStateApi['searchMode'];
    handleSearchModeChange: RedisViewerKeyLoadingApi['handleSearchModeChange'];
    searchInput: RedisViewerStateApi['searchInput'];
    handleSearchInputChange: RedisViewerKeyLoadingApi['handleSearchInputChange'];
    handleSearch: RedisViewerKeyLoadingApi['handleSearch'];
    actionButtonStyle: RedisViewerStylesApi['actionButtonStyle'];
    handleRefresh: RedisViewerKeyLoadingApi['handleRefresh'];
    setNewKeyModalOpen: RedisViewerStateApi['setNewKeyModalOpen'];
    primaryActionButtonStyle: RedisViewerStylesApi['primaryActionButtonStyle'];
    handleSelectAllLoadedKeys: RedisViewerKeyLoadingApi['handleSelectAllLoadedKeys'];
    handleLoadAllKeys: RedisViewerKeyLoadingApi['handleLoadAllKeys'];
    hasMore: RedisViewerStateApi['hasMore'];
    loading: RedisViewerStateApi['loading'];
    loadingAllKeys: RedisViewerStateApi['loadingAllKeys'];
    handleClearAllSelectedKeys: RedisViewerKeyLoadingApi['handleClearAllSelectedKeys'];
    selectedKeys: RedisViewerStateApi['selectedKeys'];
    handleExportKeys: RedisViewerImportExportApi['handleExportKeys'];
    exportingScope: RedisViewerStateApi['exportingScope'];
    handleOpenImportModal: RedisViewerImportExportApi['handleOpenImportModal'];
    importRestricted: RedisViewerStateApi['importRestricted'];
    importingKeys: RedisViewerStateApi['importingKeys'];
    handleDeleteKeys: RedisViewerKeyActionsApi['handleDeleteKeys'];
    dangerActionButtonStyle: RedisViewerStylesApi['dangerActionButtonStyle'];
    keyViewOptions: RedisKeyViewLabelsApi['keyViewOptions'];
    keyViewMode: RedisViewerStateApi['keyViewMode'];
    handleKeyViewModeChange: RedisViewerKeyTreeApi['handleKeyViewModeChange'];
    isLargeKeyspace: RedisViewerKeyTreeApi['isLargeKeyspace'];
    keyColumnTitle: RedisKeyViewLabelsApi['keyColumnTitle'];
    keyMetaColumnTitle: RedisKeyViewLabelsApi['keyMetaColumnTitle'];
    treeContainerRef: RedisViewerStateApi['treeContainerRef'];
    workbenchSubCardStyle: RedisViewerStylesApi['workbenchSubCardStyle'];
    shouldVirtualizeKeyTree: RedisViewerKeyTreeApi['shouldVirtualizeKeyTree'];
    treeHeight: RedisViewerStateApi['treeHeight'];
    keyTree: RedisViewerKeyTreeApi['keyTree'];
    renderTreeNodeTitle: RedisViewerKeyTreeApi['renderTreeNodeTitle'];
    selectedTreeNodeKeys: RedisViewerKeyTreeApi['selectedTreeNodeKeys'];
    checkedTreeNodeKeys: RedisViewerKeyTreeApi['checkedTreeNodeKeys'];
    expandedGroupKeys: RedisViewerKeyTreeApi['expandedGroupKeys'];
    handleTreeExpand: RedisViewerKeyTreeApi['handleTreeExpand'];
    handleTreeSelect: RedisViewerKeyTreeApi['handleTreeSelect'];
    handleTreeCheck: RedisViewerKeyTreeApi['handleTreeCheck'];
    handleTreeRightClick: RedisViewerKeyTreeApi['handleTreeRightClick'];
    handleLoadMore: RedisViewerKeyLoadingApi['handleLoadMore'];
}

export const RedisViewerSidebar = ({
    leftPanelRef,
    leftPanelWidth,
    workbenchCardStyle,
    workbenchTheme,
    tr,
    redisDB,
    mutedPillTagStyle,
    redisTopology,
    redisSeedAddresses,
    redisSentinelMaster,
    keys,
    searchMode,
    handleSearchModeChange,
    searchInput,
    handleSearchInputChange,
    handleSearch,
    actionButtonStyle,
    handleRefresh,
    setNewKeyModalOpen,
    primaryActionButtonStyle,
    handleSelectAllLoadedKeys,
    handleLoadAllKeys,
    hasMore,
    loading,
    loadingAllKeys,
    handleClearAllSelectedKeys,
    selectedKeys,
    handleExportKeys,
    exportingScope,
    handleOpenImportModal,
    importRestricted,
    importingKeys,
    handleDeleteKeys,
    dangerActionButtonStyle,
    keyViewOptions,
    keyViewMode,
    handleKeyViewModeChange,
    isLargeKeyspace,
    keyColumnTitle,
    keyMetaColumnTitle,
    treeContainerRef,
    workbenchSubCardStyle,
    shouldVirtualizeKeyTree,
    treeHeight,
    keyTree,
    renderTreeNodeTitle,
    selectedTreeNodeKeys,
    checkedTreeNodeKeys,
    expandedGroupKeys,
    handleTreeExpand,
    handleTreeSelect,
    handleTreeCheck,
    handleTreeRightClick,
    handleLoadMore,
}: RedisViewerSidebarProps) => (
    <div ref={leftPanelRef} className={'gn-v2-redis-sidebar'} style={{ width: leftPanelWidth, minWidth: 300, display: 'flex', flexDirection: 'column', flexShrink: 0, gap: 12 }}>
        <div className={'gn-v2-redis-header'} style={{ ...workbenchCardStyle, padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
                <div>
                    <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.08em', color: workbenchTheme.textMuted, fontWeight: 600 }}>{tr('redis_viewer.title.key_explorer')}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                        <div style={{ fontSize: 24, fontWeight: 700, color: workbenchTheme.textPrimary }}>db{redisDB}</div>
                        <Tag style={mutedPillTagStyle}>{getRedisTopologyTagLabel(redisTopology)}</Tag>
                        {redisTopology !== 'single' && (
                            <Tag style={mutedPillTagStyle}>{Math.max(redisSeedAddresses.length, 1)} nodes</Tag>
                        )}
                        {redisSentinelMaster && (
                            <Tag style={mutedPillTagStyle}>master: {redisSentinelMaster}</Tag>
                        )}
                    </div>
                </div>
                <Tag style={mutedPillTagStyle}>{tr('redis_viewer.label.keys_count', { count: keys.length })}</Tag>
            </div>
            <Space.Compact style={{ width: '100%' }}>
                <Radio.Group
                    value={searchMode}
                    onChange={handleSearchModeChange}
                    buttonStyle="solid"
                    style={{ flexShrink: 0 }}
                >
                    <Radio.Button value="prefix">{tr('redis_viewer.search.prefix')}</Radio.Button>
                    <Radio.Button value="fuzzy">{tr('redis_viewer.search.fuzzy')}</Radio.Button>
                    <Radio.Button value="exact">{tr('redis_viewer.search.exact')}</Radio.Button>
                </Radio.Group>
                <Search
                    {...noAutoCapInputProps}
                    style={{ flex: 1 }}
                    placeholder={searchMode === 'exact'
                        ? tr('redis_viewer.placeholder.search_exact')
                        : searchMode === 'fuzzy'
                            ? tr('redis_viewer.placeholder.search_fuzzy')
                            : tr('redis_viewer.placeholder.search_prefix')}
                    value={searchInput}
                    onChange={handleSearchInputChange}
                    onSearch={handleSearch}
                    allowClear
                    enterButton={<SearchOutlined />}
                />
            </Space.Compact>
            <div className={'gn-v2-redis-toolbar'} style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <Space wrap size={8}>
                    <Button size="small" style={actionButtonStyle} icon={<ReloadOutlined />} onClick={handleRefresh}>{tr('redis_viewer.action.refresh')}</Button>
                    <Button size="small" style={actionButtonStyle} icon={<PlusOutlined />} onClick={() => setNewKeyModalOpen(true)}>{tr('redis_viewer.action.new_key')}</Button>
                    <Button size="small" style={primaryActionButtonStyle} onClick={handleSelectAllLoadedKeys} disabled={keys.length === 0}>{tr('redis_viewer.action.select_all_loaded')}</Button>
                    <Button size="small" style={actionButtonStyle} onClick={handleLoadAllKeys} disabled={!hasMore || loading} loading={loadingAllKeys}>{tr('redis_viewer.action.load_all')}</Button>
                    <Button size="small" style={actionButtonStyle} onClick={handleClearAllSelectedKeys} disabled={selectedKeys.length === 0}>{tr('redis_viewer.action.clear_selection')}</Button>
                    <Button
                        size="small"
                        style={actionButtonStyle}
                        onClick={() => void handleExportKeys('all')}
                        loading={exportingScope === 'all'}
                    >
                        {tr('redis_viewer.action.export_all')}
                    </Button>
                    <Button
                        size="small"
                        style={actionButtonStyle}
                        onClick={() => void handleExportKeys('selected')}
                        disabled={selectedKeys.length === 0}
                        loading={exportingScope === 'selected'}
                    >
                        {tr('redis_viewer.action.export_selected')}
                    </Button>
                    <Button
                        size="small"
                        style={primaryActionButtonStyle}
                        onClick={handleOpenImportModal}
                        disabled={importRestricted}
                        loading={importingKeys}
                    >
                        {tr('redis_viewer.action.import')}
                    </Button>
                </Space>
                <Popconfirm
                    title={tr('redis_viewer.confirm.delete_selected', { count: selectedKeys.length })}
                    onConfirm={() => handleDeleteKeys(selectedKeys)}
                    disabled={selectedKeys.length === 0}
                >
                    <Button size="small" style={dangerActionButtonStyle} icon={<DeleteOutlined />} disabled={selectedKeys.length === 0}>
                        {tr('redis_viewer.action.delete_selected', { count: selectedKeys.length })}
                    </Button>
                </Popconfirm>
            </div>
        </div>
        <div className={'gn-v2-redis-tree-card'} style={{ ...workbenchCardStyle, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 10 }}>
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: '0 4px 8px',
                }}
            >
                <span style={{ color: workbenchTheme.textMuted, fontSize: 12, fontWeight: 600 }}>
                    {tr('redis_viewer.key_view.title')}
                </span>
                <div
                    role="group"
                    aria-label={tr('redis_viewer.key_view.title')}
                    className="gn-v2-redis-key-view-switch"
                    style={undefined}
                >
                    {keyViewOptions.map(({ mode, label, icon }) => (
                        <Tooltip title={label} key={mode}>
                            <button
                                type="button"
                                className={`gn-v2-redis-key-view-switch-btn${keyViewMode === mode ? ' is-active' : ''}`}
                                data-redis-key-view-mode={mode}
                                aria-label={label}
                                aria-pressed={keyViewMode === mode}
                                onClick={() => handleKeyViewModeChange(mode)}
                                style={undefined}
                            >
                                {icon}
                            </button>
                        </Tooltip>
                    ))}
                </div>
            </div>
            {isLargeKeyspace && keyViewMode !== 'list' && (
                <div style={{ padding: '8px 10px', fontSize: 12, color: workbenchTheme.textMuted, marginBottom: 8, borderRadius: 12, background: workbenchTheme.panelBgSubtle, border: workbenchTheme.panelBorder }}>
                    {tr('redis_viewer.notice.large_keyspace_mode', { count: REDIS_LARGE_KEYSPACE_MAX_EXPANDED_GROUPS })}
                </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 8px 10px 8px', color: workbenchTheme.textMuted, fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                <span>{keyColumnTitle}</span>
                <span>{keyMetaColumnTitle}</span>
            </div>
            <div ref={treeContainerRef} className={'gn-v2-redis-tree-shell'} style={{ ...workbenchSubCardStyle, flex: 1, minHeight: 0, overflow: 'hidden', padding: 6 }}>
                <Spin spinning={loading} size="small" style={{ width: '100%' }}>
                    <Tree
                        blockNode
                        showIcon={false}
                        switcherIcon={() => null}
                        checkable
                        checkStrictly
                        selectable
                        virtual={shouldVirtualizeKeyTree}
                        height={Math.max(treeHeight - 8, 220)}
                        treeData={keyTree.treeData}
                        titleRender={renderTreeNodeTitle}
                        selectedKeys={selectedTreeNodeKeys}
                        checkedKeys={checkedTreeNodeKeys}
                        expandedKeys={expandedGroupKeys}
                        onExpand={handleTreeExpand}
                        onSelect={(nodeKeys) => handleTreeSelect(nodeKeys)}
                        onCheck={(checked, info) => handleTreeCheck(checked, info)}
                        onRightClick={handleTreeRightClick}
                        style={{ padding: '8px 6px' }}
                    />
                </Spin>
            </div>
            {hasMore && (
                <div style={{ padding: 10, textAlign: 'center' }}>
                    <Button style={actionButtonStyle} onClick={handleLoadMore} loading={loading} disabled={!hasMore || loading}>{tr('redis_viewer.action.load_more')}</Button>
                </div>
            )}
        </div>
    </div>
);
