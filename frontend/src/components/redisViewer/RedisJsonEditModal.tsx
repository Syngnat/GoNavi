import Modal from '../common/ResizableDraggableModal';
import Editor from '../MonacoEditor';
import type { RedisViewerStateApi } from './useRedisViewerState';
import type { RedisViewerStylesApi } from './useRedisViewerStyles';

export interface RedisJsonEditModalProps {
    jsonEditConfig: RedisViewerStateApi['jsonEditConfig'];
    tr: RedisViewerStateApi['tr'];
    jsonEditModalOpen: RedisViewerStateApi['jsonEditModalOpen'];
    jsonEditValueRef: RedisViewerStateApi['jsonEditValueRef'];
    setJsonEditModalOpen: RedisViewerStateApi['setJsonEditModalOpen'];
    redisModalContentStyle: RedisViewerStylesApi['redisModalContentStyle'];
    workbenchTheme: RedisViewerStateApi['workbenchTheme'];
    darkMode: RedisViewerStateApi['darkMode'];
}

export const RedisJsonEditModal = ({
    jsonEditConfig,
    tr,
    jsonEditModalOpen,
    jsonEditValueRef,
    setJsonEditModalOpen,
    redisModalContentStyle,
    workbenchTheme,
    darkMode,
}: RedisJsonEditModalProps) => (
    <Modal
        title={jsonEditConfig?.title || tr('redis_viewer.action.edit')}
        open={jsonEditModalOpen}
        // Remount editor each open so defaultValue/value cannot stick to the previous field.
        destroyOnHidden
        onOk={async () => {
            if (jsonEditConfig?.mode === 'edit' && jsonEditConfig.onSave) {
                await jsonEditConfig.onSave(jsonEditValueRef.current);
            }
            setJsonEditModalOpen(false);
        }}
        onCancel={() => setJsonEditModalOpen(false)}
        okText={jsonEditConfig?.mode === 'view' ? tr('common.close') : undefined}
        cancelButtonProps={jsonEditConfig?.mode === 'view' ? { style: { display: 'none' } } : undefined}
        width={800}
        styles={{
            content: redisModalContentStyle,
            header: { background: 'transparent', borderBottom: 'none', color: workbenchTheme.textPrimary, flex: '0 0 auto' },
            // Flex body so drag-resize grows Monaco + keeps footer at bottom.
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
        {jsonEditModalOpen && jsonEditConfig ? (
            <div className="gn-modal-fill-body">
                <Editor
                    // Force a fresh Monaco model per field/open (avoids stale 0.01/1 from prior edit).
                    key={`${jsonEditConfig.title}::${jsonEditConfig.mode}::${jsonEditConfig.isJson ? 'json' : 'text'}`}
                    height="100%"
                    gonaviTypography="data"
                    language={jsonEditConfig.isJson ? 'json' : 'plaintext'}
                    theme={darkMode ? 'transparent-dark' : 'transparent-light'}
                    value={jsonEditConfig.value || ''}
                    onChange={(value) => { jsonEditValueRef.current = value || ''; }}
                    onMount={(editor) => {
                        const initial = jsonEditConfig.value || '';
                        jsonEditValueRef.current = initial;
                        if (editor.getValue() !== initial) {
                            editor.setValue(initial);
                        }
                        // Relayout after modal/content size settles (incl. later resize).
                        const layout = () => {
                            try { editor.layout(); } catch { /* ignore */ }
                        };
                        window.requestAnimationFrame(layout);
                        window.setTimeout(layout, 0);
                    }}
                    options={{
                        minimap: { enabled: false },
                        lineNumbers: 'on',
                        wordWrap: 'on',
                        scrollBeyondLastLine: false,
                        automaticLayout: true,
                        folding: true,
                        formatOnPaste: jsonEditConfig.mode !== 'view',
                        readOnly: jsonEditConfig.mode === 'view',
                    }}
                />
            </div>
        ) : null}
    </Modal>
);
