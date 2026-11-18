import Modal from '../common/ResizableDraggableModal';
import { Form, Space, Button, Tag, Radio, Progress } from 'antd';
import { extractFilenameFromPath, type RedisImportConflictMode } from './redisViewerHelpers';
import type { RedisViewerStateApi } from './useRedisViewerState';
import type { RedisViewerImportExportApi } from './useRedisViewerImportExport';
import type { RedisViewerStylesApi } from './useRedisViewerStyles';
import type { RedisViewerKeyActionsApi } from './useRedisViewerKeyActions';

export interface RedisNewKeyModalProps {
    tr: RedisViewerStateApi['tr'];
    importModalOpen: RedisViewerStateApi['importModalOpen'];
    importPreview: RedisViewerStateApi['importPreview'];
    importSelectedKeys: RedisViewerStateApi['importSelectedKeys'];
    importPreviewLoading: RedisViewerStateApi['importPreviewLoading'];
    importingKeys: RedisViewerStateApi['importingKeys'];
    importProgress: RedisViewerImportExportApi['importProgress'];
    cancellingImport: RedisViewerImportExportApi['cancellingImport'];
    handleConfirmImportKeys: RedisViewerImportExportApi['handleConfirmImportKeys'];
    handleCancelImport: RedisViewerImportExportApi['handleCancelImport'];
    resetImportModalState: RedisViewerImportExportApi['resetImportModalState'];
    redisModalContentStyle: RedisViewerStylesApi['redisModalContentStyle'];
    workbenchTheme: RedisViewerStateApi['workbenchTheme'];
    actionButtonStyle: RedisViewerStylesApi['actionButtonStyle'];
    handleChooseImportFile: RedisViewerImportExportApi['handleChooseImportFile'];
    mutedPillTagStyle: RedisViewerStylesApi['mutedPillTagStyle'];
    primaryActionButtonStyle: RedisViewerStylesApi['primaryActionButtonStyle'];
    handleSelectAllImportPreviewKeys: RedisViewerImportExportApi['handleSelectAllImportPreviewKeys'];
    handleClearImportPreviewSelection: RedisViewerImportExportApi['handleClearImportPreviewSelection'];
    importSelectedKeySet: RedisViewerImportExportApi['importSelectedKeySet'];
    handleToggleImportPreviewKey: RedisViewerImportExportApi['handleToggleImportPreviewKey'];
    getTypeColor: RedisViewerKeyActionsApi['getTypeColor'];
    formatTTL: RedisViewerKeyActionsApi['formatTTL'];
    importConflictMode: RedisViewerStateApi['importConflictMode'];
    setImportConflictMode: RedisViewerStateApi['setImportConflictMode'];
}

export const RedisNewKeyModal = ({
    tr,
    importModalOpen,
    importPreview,
    importSelectedKeys,
    importPreviewLoading,
    importingKeys,
    importProgress,
    cancellingImport,
    handleConfirmImportKeys,
    handleCancelImport,
    resetImportModalState,
    redisModalContentStyle,
    workbenchTheme,
    actionButtonStyle,
    handleChooseImportFile,
    mutedPillTagStyle,
    primaryActionButtonStyle,
    handleSelectAllImportPreviewKeys,
    handleClearImportPreviewSelection,
    importSelectedKeySet,
    handleToggleImportPreviewKey,
    getTypeColor,
    formatTTL,
    importConflictMode,
    setImportConflictMode,
}: RedisNewKeyModalProps) => (
    <Modal
        title={tr('redis_viewer.modal.import_keys')}
        open={importModalOpen}
        okButtonProps={{ disabled: !importPreview || importPreview.keys.length === 0 || importSelectedKeys.length === 0 || importPreviewLoading }}
        confirmLoading={importingKeys}
        onOk={() => void handleConfirmImportKeys()}
        onCancel={() => {
            if (importingKeys || importPreviewLoading) return;
            resetImportModalState();
        }}
        width={760}
        styles={{ content: redisModalContentStyle, header: { background: 'transparent', borderBottom: 'none', color: workbenchTheme.textPrimary }, body: { paddingTop: 8 }, footer: { background: 'transparent', borderTop: 'none' } }}
    >
        <Form layout="vertical">
            {importProgress ? (
                <div
                    data-redis-import-progress="true"
                    style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        marginBottom: 18,
                        padding: 12,
                        border: workbenchTheme.panelBorder,
                        borderRadius: 12,
                        background: workbenchTheme.panelBg,
                    }}
                >
                    <Progress
                        percent={importProgress.total > 0
                            ? Math.min(100, Math.round((importProgress.current / importProgress.total) * 100))
                            : 0}
                        status={importProgress.status === 'error'
                            ? 'exception'
                            : (importProgress.status === 'cancelled' ? 'normal' : 'active')}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                        <span style={{ color: workbenchTheme.textPrimary }}>
                            {tr('redis_viewer.label.import_progress', {
                                current: importProgress.current,
                                total: importProgress.total,
                                success: importProgress.success,
                                skipped: importProgress.skipped,
                            })}
                        </span>
                        {importingKeys ? (
                            <Button
                                danger
                                size="small"
                                loading={cancellingImport}
                                onClick={() => void handleCancelImport()}
                            >
                                {cancellingImport
                                    ? tr('redis_viewer.state.import_cancelling')
                                    : tr('redis_viewer.action.cancel_import')}
                            </Button>
                        ) : null}
                    </div>
                    {importProgress.stage ? (
                        <span style={{ color: workbenchTheme.textMuted, fontSize: 12 }}>
                            {importProgress.stage}
                        </span>
                    ) : null}
                </div>
            ) : null}
            <Form.Item label={tr('redis_viewer.field.import_file')}>
                <Space wrap size={8}>
                    <Button
                        style={actionButtonStyle}
                        onClick={() => void handleChooseImportFile()}
                        loading={importPreviewLoading}
                        disabled={importingKeys}
                    >
                        {importPreview ? tr('redis_viewer.action.change_import_file') : tr('redis_viewer.action.select_import_file')}
                    </Button>
                    {importPreview && (
                        <>
                            <Tag style={mutedPillTagStyle}>{extractFilenameFromPath(importPreview.file)}</Tag>
                            <Tag style={mutedPillTagStyle}>{tr('redis_viewer.label.import_selection', { selected: importSelectedKeys.length, total: importPreview.total })}</Tag>
                        </>
                    )}
                </Space>
            </Form.Item>
            {importPreview ? (
                <Form.Item label={tr('redis_viewer.field.import_keys')}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                        <Space wrap size={8}>
                            <Button
                                size="small"
                                style={primaryActionButtonStyle}
                                onClick={handleSelectAllImportPreviewKeys}
                                disabled={importingKeys || importPreview.keys.length === 0}
                            >
                                {tr('redis_viewer.action.select_all_import_keys')}
                            </Button>
                            <Button
                                size="small"
                                style={actionButtonStyle}
                                onClick={handleClearImportPreviewSelection}
                                disabled={importingKeys || importSelectedKeys.length === 0}
                            >
                                {tr('redis_viewer.action.clear_selection')}
                            </Button>
                        </Space>
                        <div style={{ color: workbenchTheme.textMuted, fontSize: 12 }}>
                            {tr('redis_viewer.label.import_database', { database: importPreview.database })}
                        </div>
                    </div>
                    <div style={{ maxHeight: 320, overflowY: 'auto', border: workbenchTheme.panelBorder, borderRadius: 12, padding: 8, background: workbenchTheme.panelBg }}>
                        {importPreview.keys.map((item) => {
                            const checked = importSelectedKeySet.has(item.key);
                            return (
                                <label
                                    key={item.key}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 10,
                                        padding: '8px 6px',
                                        borderRadius: 10,
                                        cursor: 'pointer',
                                    }}
                                >
                                    <input
                                        data-import-key={item.key}
                                        type="checkbox"
                                        checked={checked}
                                        disabled={importingKeys}
                                        onChange={(event) => handleToggleImportPreviewKey(item.key, event.target.checked)}
                                    />
                                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: workbenchTheme.textPrimary }}>
                                        {item.key}
                                    </span>
                                    <Tag color={getTypeColor(item.type)} style={{ margin: 0 }}>
                                        {item.type}
                                    </Tag>
                                    <span style={{ color: workbenchTheme.textMuted, fontSize: 12, whiteSpace: 'nowrap' }}>
                                        {formatTTL(item.ttl)}
                                    </span>
                                </label>
                            );
                        })}
                    </div>
                </Form.Item>
            ) : (
                <div style={{ marginBottom: 16, color: workbenchTheme.textMuted }}>
                    {tr('redis_viewer.state.import_preview_empty')}
                </div>
            )}
            <Form.Item label={tr('redis_viewer.field.import_conflict_mode')}>
                <Radio.Group
                    value={importConflictMode}
                    disabled={importingKeys}
                    onChange={(event) => setImportConflictMode(event.target.value as RedisImportConflictMode)}
                >
                    <Radio.Button value="overwrite">{tr('redis_viewer.option.import_overwrite')}</Radio.Button>
                    <Radio.Button value="skip">{tr('redis_viewer.option.import_skip_existing')}</Radio.Button>
                </Radio.Group>
            </Form.Item>
        </Form>
    </Modal>
);
