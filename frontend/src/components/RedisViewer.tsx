import Modal from './common/ResizableDraggableModal';
import React from 'react';
import { createPortal } from 'react-dom';
import { Input, Button, Tag, Spin, message, Form, InputNumber, Popconfirm, Tooltip, Radio } from 'antd';
import { ReloadOutlined, DeleteOutlined, ClockCircleOutlined, CopyOutlined } from '@ant-design/icons';
import Editor from './MonacoEditor';
import { noAutoCapInputProps } from '../utils/inputAutoCap';
import { formatRedisStringValue } from '../utils/redisValueDisplay';
import RedisResizableDivider from './RedisResizableDivider';
import { useRedisViewerState } from './redisViewer/useRedisViewerState';
import { useRedisViewerStyles } from './redisViewer/useRedisViewerStyles';
import { useRedisViewerKeyLoading } from './redisViewer/useRedisViewerKeyLoading';
import { useRedisViewerImportExport } from './redisViewer/useRedisViewerImportExport';
import { useRedisViewerKeyActions } from './redisViewer/useRedisViewerKeyActions';
import { useRedisViewerKeyTree } from './redisViewer/useRedisViewerKeyTree';
import { createRedisValueFormatter } from './redisViewer/redisValueFormatter';
import { createRedisStringValueView } from './redisViewer/redisStringValueView';
import { createRedisHashValueView } from './redisViewer/redisHashValueView';
import { createRedisListValueView } from './redisViewer/redisListValueView';
import { createRedisSetValueView } from './redisViewer/redisSetValueView';
import { createRedisZSetValueView } from './redisViewer/redisZSetValueView';
import { createRedisStreamValueView } from './redisViewer/redisStreamValueView';
import { createRedisKeyViewLabels } from './redisViewer/redisKeyViewLabels';
import { RedisViewerSidebar } from './redisViewer/RedisViewerSidebar';
import { RedisNewKeyModal } from './redisViewer/RedisNewKeyModal';
import { RedisJsonEditModal } from './redisViewer/RedisJsonEditModal';
import { RedisKeyContextMenu } from './redisViewer/RedisKeyContextMenu';

export interface RedisViewerProps {
    connectionId: string;
    redisDB: number;
}

const RedisViewer: React.FC<RedisViewerProps> = ({ connectionId, redisDB }) => {
    const {
        tr,
        darkMode,
        connection,
        workbenchTheme,
        workbenchBackdropFilter,
        keyAccentColor,
        jsonAccentColor,
        valueToolbarBg,
        valueToolbarBorder,
        valueToolbarText,
        redisTopology,
        redisSeedAddresses,
        redisSentinelMaster,
        importRestricted,
        keys,
        setKeys,
        loading,
        setLoading,
        searchInput,
        setSearchInput,
        searchPattern,
        setSearchPattern,
        searchMode,
        setSearchMode,
        cursor,
        setCursor,
        hasMore,
        setHasMore,
        loadingAllKeys,
        setLoadingAllKeys,
        exportingScope,
        setExportingScope,
        importingKeys,
        setImportingKeys,
        selectedKey,
        setSelectedKey,
        keyValue,
        setKeyValue,
        listSortOrder,
        setListSortOrder,
        hashFieldFilter,
        setHashFieldFilter,
        hashValueFilter,
        setHashValueFilter,
        valueLoading,
        setValueLoading,
        editModalOpen,
        setEditModalOpen,
        newKeyModalOpen,
        setNewKeyModalOpen,
        newKeyForm,
        renameKeyModalOpen,
        setRenameKeyModalOpen,
        renameKeyForm,
        renameTargetKey,
        setRenameTargetKey,
        ttlModalOpen,
        setTtlModalOpen,
        ttlForm,
        importModalOpen,
        setImportModalOpen,
        importPreviewLoading,
        setImportPreviewLoading,
        importConflictMode,
        setImportConflictMode,
        importPreview,
        setImportPreview,
        importSelectedKeys,
        setImportSelectedKeys,
        selectedKeys,
        setSelectedKeys,
        editValue,
        setEditValue,
        treeContextMenu,
        setTreeContextMenu,
        keyViewMode,
        setKeyViewMode,
        viewMode,
        setViewMode,
        jsonEditModalOpen,
        setJsonEditModalOpen,
        jsonEditConfig,
        setJsonEditConfig,
        jsonEditValueRef,
        latestLoadRequestIdRef,
        leftPanelWidth,
        setLeftPanelWidth,
        leftPanelRef,
        treeContainerRef,
        showTreeKeyTTL,
        setShowTreeKeyTTL,
        treeHeight,
        setTreeHeight,
        expandedTreeGroupKeys,
        setExpandedTreeGroupKeys,
        expandedTypeGroupKeys,
        setExpandedTypeGroupKeys,
    } = useRedisViewerState({ connectionId, redisDB });

    const {
        workbenchCardStyle,
        workbenchSubCardStyle,
        actionButtonStyle,
        primaryActionButtonStyle,
        dangerActionButtonStyle,
        pillTagStyle,
        mutedPillTagStyle,
        redisModalContentStyle,
        getConfig,
    } = useRedisViewerStyles({ workbenchTheme, redisDB, connection });

    const {
        confirmRedisMutation,
        loadKeys,
        executeSearch,
        handleSearch,
        handleSearchInputChange,
        handleSearchModeChange,
        handleLoadMore,
        handleLoadAllKeys,
        handleRefresh,
        handleSelectAllLoadedKeys,
        handleClearAllSelectedKeys,
    } = useRedisViewerKeyLoading({
        connection,
        tr,
        getConfig,
        redisTopology,
        latestLoadRequestIdRef,
        setLoading,
        setLoadingAllKeys,
        setKeys,
        setCursor,
        setHasMore,
        redisDB,
        searchPattern,
        searchMode,
        setSearchInput,
        setSearchPattern,
        setSearchMode,
        searchInput,
        hasMore,
        loading,
        cursor,
        setSelectedKeys,
        keys,
    });

    const {
        handleExportKeys,
        resetImportModalState,
        handleChooseImportFile,
        handleOpenImportModal,
        handleConfirmImportKeys,
        importSelectedKeySet,
        handleToggleImportPreviewKey,
        handleSelectAllImportPreviewKeys,
        handleClearImportPreviewSelection,
        removeMissingKeyFromView,
    } = useRedisViewerImportExport({
        getConfig,
        selectedKeys,
        tr,
        setExportingScope,
        searchPattern,
        setImportModalOpen,
        setImportPreview,
        setImportSelectedKeys,
        setImportPreviewLoading,
        setImportConflictMode,
        redisDB,
        importPreview,
        importSelectedKeys,
        confirmRedisMutation,
        setImportingKeys,
        importConflictMode,
        setSelectedKeys,
        setSelectedKey,
        setKeyValue,
        setListSortOrder,
        setCursor,
        loadKeys,
        redisTopology,
        searchMode,
        setKeys,
    });

    const {
        loadKeyValue,
        handleDeleteKeys,
        handleDeleteCurrentKey,
        handleSetTTL,
        handleSaveString,
        handleCreateKey,
        openRenameKeyModal,
        handleRenameKey,
        getTypeColor,
        formatTTL,
    } = useRedisViewerKeyActions({
        listSortOrder,
        setListSortOrder,
        getConfig,
        setValueLoading,
        setKeyValue,
        setSelectedKey,
        removeMissingKeyFromView,
        tr,
        redisDB,
        confirmRedisMutation,
        setKeys,
        selectedKey,
        setSelectedKeys,
        ttlForm,
        setTtlModalOpen,
        handleRefresh,
        editValue,
        keyValue,
        setEditModalOpen,
        newKeyForm,
        setNewKeyModalOpen,
        setTreeContextMenu,
        setRenameTargetKey,
        renameKeyForm,
        setRenameKeyModalOpen,
        renameTargetKey,
        keys,
        selectedKeys,
    });

    const {
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
    } = useRedisViewerKeyTree({
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
    });

    const renderValueEditor = () => {
        const { processValueForCurrentView } = createRedisValueFormatter({ viewMode });

        if (!keyValue || !selectedKey) {
            return (
                <div
                    className={'gn-v2-redis-empty-value'}
                    style={{
                        ...workbenchCardStyle,
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: workbenchTheme.contentEmptyBg,
                        color: workbenchTheme.textMuted,
                        padding: 24,
                    }}
                >
                    {tr('redis_viewer.state.empty_selection')}
                </div>
            );
        }

        const { renderStringValue } = createRedisStringValueView({
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
        });

        const { renderHashValue } = createRedisHashValueView({
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
        });

        const { renderListValue } = createRedisListValueView({
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
        });

        const { renderSetValue } = createRedisSetValueView({
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
        });

        const { renderZSetValue } = createRedisZSetValueView({
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
        });

        const { renderStreamValue } = createRedisStreamValueView({
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
        });

        return (
            <div className={'gn-v2-redis-value-layout'} style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="redis-key-detail-top gn-v2-redis-value-top" style={{ display: 'flex', flexDirection: 'column', gap: 12, flexShrink: 0 }}>
                    <div className="redis-key-detail-header gn-v2-redis-value-header" style={{ ...workbenchCardStyle, padding: 18, display: 'flex', flexDirection: 'column', gap: 16, flexShrink: 0 }}>
                        <div className="redis-key-detail-summary" style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, width: '100%' }}>
                            <span style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.08em', color: workbenchTheme.textMuted, fontWeight: 600 }}>
                                {tr('redis_viewer.title.active_key')}
                            </span>
                            <div className="redis-key-detail-identity" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, width: '100%' }}>
                                <Tooltip title={selectedKey}>
                                    <strong data-redis-active-key="true" style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 26, color: workbenchTheme.textPrimary }}>
                                        {selectedKey}
                                    </strong>
                                </Tooltip>
                                <Tooltip title={tr('redis_viewer.tooltip.copy_key_name')}>
                                    <Button
                                        type="text"
                                        size="small"
                                        icon={<CopyOutlined />}
                                        style={{ padding: '0 4px', display: 'flex', alignItems: 'center', color: workbenchTheme.textMuted, flex: '0 0 auto' }}
                                        onClick={() => {
                                            navigator.clipboard.writeText(selectedKey).then(() => {
                                                message.success(tr('redis_viewer.message.key_name_copied'));
                                            }).catch(() => {
                                                message.error(tr('redis_viewer.message.copy_failed'));
                                            });
                                        }}
                                    />
                                </Tooltip>
                            </div>
                            <div className="redis-key-detail-metadata" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
                                <Tag color={getTypeColor(keyValue.type)} style={pillTagStyle}>{keyValue.type}</Tag>
                                <Tag icon={<ClockCircleOutlined />} style={mutedPillTagStyle}>{formatTTL(keyValue.ttl)}</Tag>
                                {keyValue.length > 0 && <Tag style={mutedPillTagStyle}>{tr('redis_viewer.label.length', { count: keyValue.length })}</Tag>}
                            </div>
                            <div className="redis-key-detail-actions" style={{ display: 'flex', gap: 4, alignItems: 'center', alignSelf: 'flex-start', flexWrap: 'wrap', maxWidth: '100%' }}>
                                <Button size="small" style={actionButtonStyle} onClick={() => {
                                    ttlForm.setFieldsValue({ ttl: keyValue.ttl > 0 ? keyValue.ttl : -1 });
                                    setTtlModalOpen(true);
                                }}>{tr('redis_viewer.action.set_ttl')}</Button>
                                <Button size="small" style={actionButtonStyle} onClick={() => loadKeyValue(selectedKey)} icon={<ReloadOutlined />}>{tr('redis_viewer.action.refresh')}</Button>
                                <Popconfirm title={tr('redis_viewer.confirm.delete_key', { key: selectedKey })} onConfirm={handleDeleteCurrentKey}>
                                    <Button size="small" style={dangerActionButtonStyle} icon={<DeleteOutlined />}>{tr('redis_viewer.action.delete_key')}</Button>
                                </Popconfirm>
                            </div>
                        </div>
                    </div>
                    <div className="redis-key-view-mode gn-v2-redis-view-mode" style={{ ...workbenchSubCardStyle, padding: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                        <span style={{ paddingInline: 10, fontSize: 12, color: workbenchTheme.textMuted }}>{tr('redis_viewer.view.title')}</span>
                        <Radio.Group size="small" value={viewMode} onChange={(e) => setViewMode(e.target.value)}>
                            <Radio.Button value="auto">{tr('redis_viewer.view.auto')}</Radio.Button>
                            <Radio.Button value="text">{tr('redis_viewer.view.text')}</Radio.Button>
                            <Radio.Button value="utf8">UTF-8</Radio.Button>
                            <Radio.Button value="hex">{tr('redis_viewer.view.hex')}</Radio.Button>
                        </Radio.Group>
                    </div>
                </div>
                <div className={'gn-v2-redis-value-card'} style={{ ...workbenchCardStyle, padding: 14, flex: 1, minHeight: 0, overflow: 'hidden' }}>
                    <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', height: '100%' }}>
                        {keyValue.type === 'string' && renderStringValue()}
                        {keyValue.type === 'hash' && renderHashValue()}
                        {keyValue.type === 'list' && renderListValue()}
                        {keyValue.type === 'set' && renderSetValue()}
                        {keyValue.type === 'zset' && renderZSetValue()}
                        {keyValue.type === 'stream' && renderStreamValue()}
                    </div>
                </div>
            </div>
        );
    };

    if (!connection) {
        return <div style={{ padding: 20 }}>{tr('redis_viewer.state.connection_not_found')}</div>;
    }

    const { keyViewOptions, keyColumnTitle, keyMetaColumnTitle } = createRedisKeyViewLabels({ tr, keyViewMode, showTreeKeyTTL });

    return (
        <div
            className="redis-viewer-workbench gn-v2-redis-workbench"
            style={{
                display: 'flex',
                height: '100%',
                gap: 12,
                padding: 12,
                background: workbenchTheme.appBg,
                backdropFilter: workbenchBackdropFilter,
                WebkitBackdropFilter: workbenchBackdropFilter,
                '--gn-redis-sidebar-width': typeof leftPanelWidth === 'number' ? `${leftPanelWidth}px` : leftPanelWidth,
            } as React.CSSProperties}
        >
            {/* Left: Key List */}
            <RedisViewerSidebar
                leftPanelRef={leftPanelRef}
                leftPanelWidth={leftPanelWidth}
                workbenchCardStyle={workbenchCardStyle}
                workbenchTheme={workbenchTheme}
                tr={tr}
                redisDB={redisDB}
                mutedPillTagStyle={mutedPillTagStyle}
                redisTopology={redisTopology}
                redisSeedAddresses={redisSeedAddresses}
                redisSentinelMaster={redisSentinelMaster}
                keys={keys}
                searchMode={searchMode}
                handleSearchModeChange={handleSearchModeChange}
                searchInput={searchInput}
                handleSearchInputChange={handleSearchInputChange}
                handleSearch={handleSearch}
                actionButtonStyle={actionButtonStyle}
                handleRefresh={handleRefresh}
                setNewKeyModalOpen={setNewKeyModalOpen}
                primaryActionButtonStyle={primaryActionButtonStyle}
                handleSelectAllLoadedKeys={handleSelectAllLoadedKeys}
                handleLoadAllKeys={handleLoadAllKeys}
                hasMore={hasMore}
                loading={loading}
                loadingAllKeys={loadingAllKeys}
                handleClearAllSelectedKeys={handleClearAllSelectedKeys}
                selectedKeys={selectedKeys}
                handleExportKeys={handleExportKeys}
                exportingScope={exportingScope}
                handleOpenImportModal={handleOpenImportModal}
                importRestricted={importRestricted}
                importingKeys={importingKeys}
                handleDeleteKeys={handleDeleteKeys}
                dangerActionButtonStyle={dangerActionButtonStyle}
                keyViewOptions={keyViewOptions}
                keyViewMode={keyViewMode}
                handleKeyViewModeChange={handleKeyViewModeChange}
                isLargeKeyspace={isLargeKeyspace}
                keyColumnTitle={keyColumnTitle}
                keyMetaColumnTitle={keyMetaColumnTitle}
                treeContainerRef={treeContainerRef}
                workbenchSubCardStyle={workbenchSubCardStyle}
                shouldVirtualizeKeyTree={shouldVirtualizeKeyTree}
                treeHeight={treeHeight}
                keyTree={keyTree}
                renderTreeNodeTitle={renderTreeNodeTitle}
                selectedTreeNodeKeys={selectedTreeNodeKeys}
                checkedTreeNodeKeys={checkedTreeNodeKeys}
                expandedGroupKeys={expandedGroupKeys}
                handleTreeExpand={handleTreeExpand}
                handleTreeSelect={handleTreeSelect}
                handleTreeCheck={handleTreeCheck}
                handleTreeRightClick={handleTreeRightClick}
                handleLoadMore={handleLoadMore}
            />

            {/* Resizable Divider */}
            <RedisResizableDivider
                targetRef={leftPanelRef}
                onResizeEnd={setLeftPanelWidth}
                maxReservedWidth={361}
                containerWidthCssVariable={'--gn-redis-sidebar-width'}
                title={tr('redis_viewer.tooltip.resize_panels')}
            />

            {/* Right: Value Viewer */}
            <div
                className={'gn-v2-redis-value-pane'}
                aria-busy={valueLoading}
                style={{ flex: 1, overflow: 'hidden', minWidth: 300, position: 'relative' }}
            >
                {renderValueEditor()}
                {valueLoading && (
                    <div
                        data-redis-value-loading-overlay="true"
                        role="status"
                        aria-live="polite"
                        style={{
                            position: 'absolute',
                            inset: 0,
                            zIndex: 2,
                            minWidth: 0,
                            minHeight: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 8,
                            overflow: 'hidden',
                            cursor: 'progress',
                            background: 'var(--gn-bg-panel)',
                            color: workbenchTheme.textMuted,
                        }}
                    >
                        <Spin size="small" />
                        <span>{tr('common.loading')}...</span>
                    </div>
                )}
            </div>

            {/* Edit String Modal */}
            <Modal
                title={tr('redis_viewer.modal.edit_value')}
                open={editModalOpen}
                onOk={handleSaveString}
                onCancel={() => setEditModalOpen(false)}
                width={800}
                styles={{
                    content: redisModalContentStyle,
                    header: { background: 'transparent', borderBottom: 'none', color: workbenchTheme.textPrimary, flex: '0 0 auto' },
                    body: {
                        flex: '1 1 auto',
                        paddingTop: 8,
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden',
                    },
                    footer: { background: 'transparent', borderTop: 'none', flex: '0 0 auto' },
                }}
            >
                <div className="gn-modal-fill-body">
                    <Editor
                        height="100%"
                        gonaviTypography="data"
                        language={formatRedisStringValue(editValue).isJson ? 'json' : 'plaintext'}
                        theme={darkMode ? 'transparent-dark' : 'transparent-light'}
                        value={editValue}
                        onChange={(value) => setEditValue(value || '')}
                        options={{
                            minimap: { enabled: false },
                            lineNumbers: 'on',
                            wordWrap: 'on',
                            scrollBeyondLastLine: false,
                            automaticLayout: true,
                            folding: true
                        }}
                    />
                </div>
            </Modal>

            {/* New Key Modal */}
            <Modal
                title={tr('redis_viewer.modal.new_key')}
                open={newKeyModalOpen}
                onOk={handleCreateKey}
                onCancel={() => setNewKeyModalOpen(false)}
                styles={{ content: redisModalContentStyle, header: { background: 'transparent', borderBottom: 'none', color: workbenchTheme.textPrimary }, body: { paddingTop: 8 }, footer: { background: 'transparent', borderTop: 'none' } }}
            >
                <Form form={newKeyForm} layout="vertical" initialValues={{ ttl: -1 }}>
                    <Form.Item name="key" label={tr('redis_viewer.field.key')} rules={[{ required: true, message: tr('redis_viewer.validation.key_required') }]}>
                        <Input {...noAutoCapInputProps} placeholder={tr('redis_viewer.placeholder.key_name')} />
                    </Form.Item>
                    <Form.Item name="value" label={tr('redis_viewer.field.value')} rules={[{ required: true, message: tr('redis_viewer.validation.value_required') }]}>
                        <Input.TextArea rows={4} placeholder={tr('redis_viewer.placeholder.value')} />
                    </Form.Item>
                    <Form.Item name="ttl" label={tr('redis_viewer.field.ttl_seconds')} help={tr('redis_viewer.help.ttl_forever')}>
                        <InputNumber style={{ width: '100%' }} min={-1} />
                    </Form.Item>
                </Form>
            </Modal>

            <RedisNewKeyModal
                tr={tr}
                importModalOpen={importModalOpen}
                importPreview={importPreview}
                importSelectedKeys={importSelectedKeys}
                importPreviewLoading={importPreviewLoading}
                importingKeys={importingKeys}
                handleConfirmImportKeys={handleConfirmImportKeys}
                resetImportModalState={resetImportModalState}
                redisModalContentStyle={redisModalContentStyle}
                workbenchTheme={workbenchTheme}
                actionButtonStyle={actionButtonStyle}
                handleChooseImportFile={handleChooseImportFile}
                mutedPillTagStyle={mutedPillTagStyle}
                primaryActionButtonStyle={primaryActionButtonStyle}
                handleSelectAllImportPreviewKeys={handleSelectAllImportPreviewKeys}
                handleClearImportPreviewSelection={handleClearImportPreviewSelection}
                importSelectedKeySet={importSelectedKeySet}
                handleToggleImportPreviewKey={handleToggleImportPreviewKey}
                getTypeColor={getTypeColor}
                formatTTL={formatTTL}
                importConflictMode={importConflictMode}
                setImportConflictMode={setImportConflictMode}
            />

            {/* TTL Modal */}
            <Modal
                title={tr('redis_viewer.modal.rename_key')}
                open={renameKeyModalOpen}
                onOk={handleRenameKey}
                onCancel={() => {
                    setRenameKeyModalOpen(false);
                    setRenameTargetKey(null);
                    renameKeyForm.resetFields();
                }}
                styles={{ content: redisModalContentStyle, header: { background: 'transparent', borderBottom: 'none', color: workbenchTheme.textPrimary }, body: { paddingTop: 8 }, footer: { background: 'transparent', borderTop: 'none' } }}
            >
                <Form form={renameKeyForm} layout="vertical">
                    <Form.Item
                        name="key"
                        label={tr('redis_viewer.field.new_key_name')}
                        rules={[{ required: true, message: tr('redis_viewer.validation.new_key_name_required') }]}
                        extra={renameTargetKey ? tr('redis_viewer.label.original_key', { key: renameTargetKey }) : undefined}
                    >
                        <Input {...noAutoCapInputProps} placeholder={tr('redis_viewer.placeholder.new_key_name')} />
                    </Form.Item>
                </Form>
            </Modal>

            <Modal
                title={tr('redis_viewer.modal.set_ttl')}
                open={ttlModalOpen}
                onOk={handleSetTTL}
                onCancel={() => setTtlModalOpen(false)}
                styles={{ content: redisModalContentStyle, header: { background: 'transparent', borderBottom: 'none', color: workbenchTheme.textPrimary }, body: { paddingTop: 8 }, footer: { background: 'transparent', borderTop: 'none' } }}
            >
                <Form form={ttlForm} layout="vertical">
                    <Form.Item name="ttl" label={tr('redis_viewer.field.ttl_seconds')} help={tr('redis_viewer.help.ttl_forever')}>
                        <InputNumber style={{ width: '100%' }} min={-1} />
                    </Form.Item>
                </Form>
            </Modal>

            {/* JSON / field Edit Modal with Monaco Editor */}
            <RedisJsonEditModal
                jsonEditConfig={jsonEditConfig}
                tr={tr}
                jsonEditModalOpen={jsonEditModalOpen}
                jsonEditValueRef={jsonEditValueRef}
                setJsonEditModalOpen={setJsonEditModalOpen}
                redisModalContentStyle={redisModalContentStyle}
                workbenchTheme={workbenchTheme}
                darkMode={darkMode}
            />
            {treeContextMenu && typeof document !== 'undefined' && createPortal((
                <RedisKeyContextMenu
                    treeContextMenu={treeContextMenu}
                    workbenchTheme={workbenchTheme}
                    openRenameKeyModal={openRenameKeyModal}
                    tr={tr}
                    setTreeContextMenu={setTreeContextMenu}
                />
            ), document.body)}
        </div>
    );
};

export default RedisViewer;
