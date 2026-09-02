import React from 'react';
import { Input, Tooltip } from 'antd';
import { DatabaseOutlined } from '@ant-design/icons';
import { useStore } from '../../store';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import type { AIComposerNotice, AIComposerNoticeAction } from '../../utils/aiComposerNotice';
import type { AIProviderConfig } from '../../types';
import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import { DEFAULT_SHORTCUT_OPTIONS, getShortcutDisplayLabel, type ShortcutPlatform, type ShortcutPlatformBinding } from '../../utils/shortcuts';
import AIContextSelectorModal from './AIContextSelectorModal';
import AISlashCommandMenu from './AISlashCommandMenu';
import AIChatComposerNotice from './AIChatComposerNotice';
import AIChatComposerStatus from './AIChatComposerStatus';
import AIChatComposerActions from './AIChatComposerActions';
import AIChatAttachmentStrip from './AIChatAttachmentStrip';
import AIChatContextPreview from './AIChatContextPreview';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import AIChatProviderModelSelect from './AIChatProviderModelSelect';
import AIChatThinkingIntensitySelect from './AIChatThinkingIntensitySelect';
import { buildAIChatReadinessSnapshot } from './aiChatReadiness';
import { useAIChatContextBinding } from './useAIChatContextBinding';
import { useAIChatDraftAttachments } from './useAIChatDraftAttachments';
import { useAISlashCommandMenu } from './useAISlashCommandMenu';
import type { AIChatAttachment } from '../../types';
import type { AIRunDispatchMode } from './aiRunHarnessClient';

interface AIChatInputProps {
    input: string;
    setInput: (val: string) => void;
    draftAttachments: AIChatAttachment[];
    setDraftAttachments: React.Dispatch<React.SetStateAction<AIChatAttachment[]>>;
    sending: boolean;
    dispatchMode?: AIRunDispatchMode;
    hasActiveRun?: boolean;
    onDispatchModeChange?: (mode: AIRunDispatchMode) => void;
    onSend: () => void;
    onStop: () => void;
    handleKeyDown: (e: React.KeyboardEvent) => void;
    activeConnName: string;
    activeContext: { connectionId?: string | null; dbName?: string | null } | null;
    activeProvider: AIProviderConfig | null;
    dynamicModels: string[];
    loadingModels: boolean;
    sendShortcutBinding: ShortcutPlatformBinding;
    shortcutPlatform?: ShortcutPlatform;
    composerNotice?: AIComposerNotice | null;
    onComposerAction?: (actionKey: AIComposerNoticeAction) => void;
    onModelChange: (val: string) => void;
    onFetchModels: () => void;
    thinkingIntensity: string;
    onThinkingIntensityChange: (val: string) => void;
    textareaRef: React.RefObject<HTMLTextAreaElement>;
    darkMode: boolean;
    textColor: string;
    mutedColor: string;
    overlayTheme: OverlayWorkbenchTheme;
    contextUsageChars?: number;
    maxContextChars?: number;
    isV2Ui?: boolean;
}

export const AIChatInput: React.FC<AIChatInputProps> = ({
    input, setInput, draftAttachments, setDraftAttachments, sending, dispatchMode = 'queue', hasActiveRun = false,
    onDispatchModeChange, onSend, onStop, handleKeyDown,
    activeConnName, activeContext, activeProvider, dynamicModels, loadingModels,
    sendShortcutBinding, shortcutPlatform = 'windows', composerNotice, onComposerAction,
    onModelChange, onFetchModels, thinkingIntensity, onThinkingIntensityChange,
    textareaRef, darkMode, textColor, mutedColor, overlayTheme,
    contextUsageChars, maxContextChars, isV2Ui = false
}) => {
    const i18n = useOptionalI18n();
    const t = i18n?.t ?? ((key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
        catalogTranslate('en-US', key, params));
    const aiContexts = useStore(state => state.aiContexts);
    const addAIContext = useStore(state => state.addAIContext);
    const removeAIContext = useStore(state => state.removeAIContext);

    const connectionKey = activeContext?.connectionId ? `${activeContext.connectionId}:${activeContext.dbName || ''}` : 'default';
    const activeContextItems = aiContexts[connectionKey] || [];
    const composerReadiness = React.useMemo(() => buildAIChatReadinessSnapshot({
        activeProvider,
        dynamicModels,
        loadingModels,
        activeContext,
        activeContextItems,
        translate: t,
    }), [activeProvider, dynamicModels, loadingModels, activeContext, activeContextItems, t]);
    const composerStatusKey = React.useMemo(() => [
        composerReadiness.status,
        composerReadiness.activeProvider?.id || '',
        composerReadiness.activeProvider?.model || '',
        activeContext?.connectionId || '',
        activeContext?.dbName || '',
        composerReadiness.contextAttachedCount,
        composerReadiness.selectableModelCount,
    ].join('|'), [
        composerReadiness.status,
        composerReadiness.activeProvider?.id,
        composerReadiness.activeProvider?.model,
        activeContext?.connectionId,
        activeContext?.dbName,
        composerReadiness.contextAttachedCount,
        composerReadiness.selectableModelCount,
    ]);
    const [dismissedComposerStatusKey, setDismissedComposerStatusKey] = React.useState<string | null>(null);
    React.useEffect(() => {
        setDismissedComposerStatusKey(null);
    }, [composerStatusKey]);
    const isComposerStatusDismissed = composerReadiness.ready && dismissedComposerStatusKey === composerStatusKey;
    const handleDismissComposerStatus = React.useCallback(() => {
        if (composerReadiness.ready) {
            setDismissedComposerStatusKey(composerStatusKey);
        }
    }, [composerReadiness.ready, composerStatusKey]);
    const {
        appendingContext,
        contextExpanded,
        contextLoading,
        contextOpen,
        dbList,
        filteredTables,
        handleAppendContext,
        handleDbChange,
        handleOpenContext,
        handleRemoveContextItem,
        searchText,
        selectedDbName,
        selectedTableKeys,
        setContextExpanded,
        setContextOpen,
        setSearchText,
        setSelectedTableKeys,
    } = useAIChatContextBinding({
        activeContext,
        activeContextItems,
        connectionKey,
        addAIContext,
        removeAIContext,
        translate: t,
    });

    const {
        fileInputRef,
        handleAttachmentUpload,
        handlePasteImages,
        handleRemoveDraftAttachment,
    } = useAIChatDraftAttachments({
        setDraftAttachments,
        translate: t,
    });

    const {
        filteredSlashCmds,
        handleComposerInputChange,
        handleOpenSlashMenu,
        handleSelectSlashCommand,
        showSlashMenu,
    } = useAISlashCommandMenu({
        setInput,
        textareaRef,
        translate: t,
    });

    const handleComposerNoticeAction = React.useCallback(() => {
        if (composerNotice?.action?.key && typeof onComposerAction === 'function') {
            onComposerAction(composerNotice.action.key);
        }
    }, [composerNotice?.action?.key, onComposerAction]);
    const sendShortcutLabel = React.useMemo(() => {
        if (sendShortcutBinding?.enabled === false) {
            return t('ai_chat.input.shortcut.disabled');
        }
        const combo = sendShortcutBinding?.combo || DEFAULT_SHORTCUT_OPTIONS.sendAIChatMessage.windows.combo;
        return t('ai_chat.input.shortcut.send_with_combo', {
            shortcut: getShortcutDisplayLabel(combo, shortcutPlatform),
        });
    }, [sendShortcutBinding?.combo, sendShortcutBinding?.enabled, shortcutPlatform, t]);
    const connectionTooltipLabel = t('ai_chat.input.context.connection_tooltip');
    const memoryLimitLabel = maxContextChars !== undefined
        ? `${(maxContextChars / 1000).toFixed(0)}k`
        : '';
    const memoryTooltipLabel = memoryLimitLabel
        ? t('ai_chat.input.context.memory_tooltip', { limit: memoryLimitLabel })
        : '';
    const composerActionHandler = typeof onComposerAction === 'function' ? onComposerAction : undefined;
    const composerNoticeActionHandler = composerNotice?.action?.key && composerActionHandler
        ? handleComposerNoticeAction
        : undefined;

    if (!isV2Ui) {
        return (
            <div className="ai-chat-input-area" style={{ borderTop: 'none', padding: '12px 16px 20px' }}>
                <div className="ai-chat-input-wrapper" style={{
                    borderColor: 'transparent',
                    background: 'transparent',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'stretch',
                    gap: 8,
                    padding: '8px 4px 8px'
                }}>
                    <div className="ai-chat-input-preview-area" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <AIChatContextPreview
                            variant="legacy"
                            activeContextItems={activeContextItems}
                            contextExpanded={contextExpanded}
                            darkMode={darkMode}
                            textColor={textColor}
                            onToggleExpanded={() => setContextExpanded(!contextExpanded)}
                            onOpenContext={handleOpenContext}
                            onRemoveContext={handleRemoveContextItem}
                        />
                        <AIChatAttachmentStrip
                            variant="legacy"
                            attachments={draftAttachments}
                            overlayTheme={overlayTheme}
                            onRemove={handleRemoveDraftAttachment}
                        />
                    </div>
                    <AIChatComposerNotice
                        composerNotice={composerNotice}
                        darkMode={darkMode}
                        textColor={textColor}
                        mutedColor={mutedColor}
                        onComposerNoticeAction={composerNoticeActionHandler}
                    />
                    {!composerNotice && !isComposerStatusDismissed && (
                        <AIChatComposerStatus
                            snapshot={composerReadiness}
                            darkMode={darkMode}
                            overlayTheme={overlayTheme}
                            onAction={composerActionHandler}
                            onDismiss={composerReadiness.ready ? handleDismissComposerStatus : undefined}
                        />
                    )}
                    <div data-ai-chat-composer-input="true" style={{ position: 'relative' }}>
                        <AISlashCommandMenu
                            visible={showSlashMenu}
                            commands={filteredSlashCmds}
                            darkMode={darkMode}
                            textColor={textColor}
                            mutedColor={mutedColor}
                            onSelect={handleSelectSlashCommand}
                            style={{
                                position: 'absolute', bottom: '100%', left: 0, right: 0, marginBottom: 4,
                                background: darkMode ? '#2a2a2a' : '#fff',
                                border: `1px solid ${darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'}`,
                                borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.15)', zIndex: 100,
                                maxHeight: 220, overflowY: 'auto', padding: 4
                            }}
                        />
                        <Input.TextArea
                            onPaste={handlePasteImages}
                            ref={textareaRef as any}
                            value={input}
                            onChange={(e) => handleComposerInputChange(e.target.value)}
                            onKeyDown={handleKeyDown as any}
                            placeholder={t('ai_chat.input.placeholder', { shortcut: sendShortcutLabel })}
                            variant="borderless"
                            autoSize={{ minRows: 3, maxRows: 8 }}
                            autoComplete="off"
                            {...noAutoCapInputProps}
                            style={{ color: textColor, width: '100%', padding: 0, resize: 'none' }}
                        />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                            {activeConnName && (
                                <Tooltip title={connectionTooltipLabel}>
                                    <div style={{
                                        display: 'flex', alignItems: 'center', gap: 4,
                                        fontSize: 11, padding: '2px 8px', borderRadius: 12,
                                        background: darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                                        color: overlayTheme.mutedText, cursor: 'default',
                                        minWidth: 96, maxWidth: 200, overflow: 'hidden', flex: '1 1 auto',
                                    }}>
                                        <DatabaseOutlined style={{ fontSize: 10, flex: '0 0 auto' }} />
                                        <span style={{ minWidth: 0, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {activeConnName}{activeContext?.dbName ? ` / ${activeContext.dbName}` : ''}
                                        </span>
                                    </div>
                                </Tooltip>
                            )}

                            <AIChatProviderModelSelect
                                activeProvider={activeProvider}
                                dynamicModels={dynamicModels}
                                loadingModels={loadingModels}
                                variant="legacy"
                                onModelChange={onModelChange}
                                onFetchModels={onFetchModels}
                            />

                            <AIChatThinkingIntensitySelect
                                activeProvider={activeProvider}
                                value={thinkingIntensity}
                                variant="legacy"
                                onChange={onThinkingIntensityChange}
                            />

                            {contextUsageChars !== undefined && maxContextChars !== undefined && (
                                <Tooltip title={memoryTooltipLabel}>
                                    <div style={{
                                        display: 'flex', alignItems: 'center', gap: 4,
                                        fontSize: 10, padding: '2px 6px', borderRadius: 12, border: '1px solid transparent',
                                        background: contextUsageChars > maxContextChars * 0.8 ? (darkMode ? 'rgba(250, 173, 20, 0.1)' : 'rgba(250, 173, 20, 0.08)') : (darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'),
                                        borderColor: contextUsageChars > maxContextChars * 0.8 ? 'rgba(250, 173, 20, 0.3)' : 'transparent',
                                        color: contextUsageChars > maxContextChars * 0.8 ? '#faad14' : overlayTheme.mutedText, cursor: 'default',
                                        transition: 'all 0.3s'
                                    }}>
                                        <span>🧠 {(contextUsageChars / 1000).toFixed(1)}k / {(maxContextChars / 1000).toFixed(0)}k</span>
                                    </div>
                                </Tooltip>
                            )}
                        </div>

                        <AIChatComposerActions
                            variant="legacy"
                            input={input}
                            draftAttachmentCount={draftAttachments.length}
                            sending={sending}
                            dispatchMode={dispatchMode}
                            hasActiveRun={hasActiveRun}
                            onDispatchModeChange={onDispatchModeChange}
                            darkMode={darkMode}
                            textColor={textColor}
                            mutedColor={mutedColor}
                            overlayTheme={overlayTheme}
                            fileInputRef={fileInputRef}
                            onAttachmentUpload={handleAttachmentUpload}
                            onOpenContext={handleOpenContext}
                            onSend={onSend}
                            onStop={onStop}
                        />
                    </div>
                </div>

                <AIContextSelectorModal
                    open={contextOpen}
                    loading={contextLoading}
                    confirmLoading={appendingContext}
                    darkMode={darkMode}
                    textColor={textColor}
                    overlayTheme={overlayTheme}
                    dbList={dbList}
                    selectedDbName={selectedDbName}
                    searchText={searchText}
                    filteredTables={filteredTables}
                    selectedTableKeys={selectedTableKeys}
                    onCancel={() => setContextOpen(false)}
                    onConfirm={handleAppendContext}
                    onDbChange={handleDbChange}
                    onSearchTextChange={setSearchText}
                    onSelectedTableKeysChange={setSelectedTableKeys}
                />
            </div>
        );
    }

    return (
        <div className="ai-chat-input-area gn-v2-ai-composer" style={{ borderTop: 'none', padding: '12px 16px 20px' }}>
            <div className="ai-chat-input-wrapper" style={{
                borderColor: 'transparent',
                background: 'transparent',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'stretch',
                gap: 8,
                padding: '8px 4px 8px'
            }}>
                <AIChatContextPreview
                    variant="v2"
                    activeContextItems={activeContextItems}
                    contextExpanded={contextExpanded}
                    darkMode={darkMode}
                    textColor={textColor}
                    onToggleExpanded={() => setContextExpanded(!contextExpanded)}
                    onOpenContext={handleOpenContext}
                    onRemoveContext={handleRemoveContextItem}
                />
                <AIChatAttachmentStrip
                    variant="v2"
                    attachments={draftAttachments}
                    overlayTheme={overlayTheme}
                    onRemove={handleRemoveDraftAttachment}
                />
                <AIChatComposerNotice
                    composerNotice={composerNotice}
                    darkMode={darkMode}
                    textColor={textColor}
                    mutedColor={mutedColor}
                    onComposerNoticeAction={composerNoticeActionHandler}
                />
                {!composerNotice && !isComposerStatusDismissed && (
                    <AIChatComposerStatus
                        snapshot={composerReadiness}
                        darkMode={darkMode}
                        overlayTheme={overlayTheme}
                        onAction={composerActionHandler}
                        onDismiss={composerReadiness.ready ? handleDismissComposerStatus : undefined}
                    />
                )}
                <div className="gn-v2-ai-input-box" data-ai-chat-composer-input="true" style={{ position: 'relative' }}>
                    <AISlashCommandMenu
                        visible={showSlashMenu}
                        commands={filteredSlashCmds}
                        darkMode={darkMode}
                        textColor={textColor}
                        mutedColor={mutedColor}
                        className="gn-v2-ai-slash-menu"
                        style={{
                            background: darkMode ? '#2a2a2a' : '#fff',
                            border: `1px solid ${darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'}`,
                        }}
                        onSelect={handleSelectSlashCommand}
                    />
                    <div className="gn-v2-ai-input-surface">
                        <Input.TextArea
                            onPaste={handlePasteImages}
                            ref={textareaRef as any}
                            value={input}
                            onChange={(e) => handleComposerInputChange(e.target.value)}
                            onKeyDown={handleKeyDown as any}
                            placeholder={t('ai_chat.input.placeholder_compact', { shortcut: sendShortcutLabel })}
                            variant="borderless"
                            autoSize={{ minRows: 3, maxRows: 8 }}
                            autoComplete="off"
                            {...noAutoCapInputProps}
                            style={{ color: textColor, width: '100%', padding: 0, resize: 'none' }}
                        />
                        <AIChatComposerActions
                            variant="v2"
                            input={input}
                            draftAttachmentCount={draftAttachments.length}
                            sending={sending}
                            dispatchMode={dispatchMode}
                            hasActiveRun={hasActiveRun}
                            onDispatchModeChange={onDispatchModeChange}
                            darkMode={darkMode}
                            textColor={textColor}
                            mutedColor={mutedColor}
                            overlayTheme={overlayTheme}
                            fileInputRef={fileInputRef}
                            onAttachmentUpload={handleAttachmentUpload}
                            onOpenContext={handleOpenContext}
                            onOpenSlashMenu={handleOpenSlashMenu}
                            onSend={onSend}
                            onStop={onStop}
                        />
                    </div>
                </div>
                <div className="gn-v2-ai-model-bar">
                    {/* 单行紧凑：连接 | 模型 | 思考 | 用量；模型固定宽，不撑满 */}
                    {activeConnName && (
                        <Tooltip title={connectionTooltipLabel}>
                            <div className="gn-v2-ai-context-chip">
                                <span className="gn-v2-ai-context-live-dot" />
                                <DatabaseOutlined />
                                <span className="gn-v2-ai-context-chip-text">
                                    {activeConnName}{activeContext?.dbName ? ` / ${activeContext.dbName}` : ''}
                                </span>
                            </div>
                        </Tooltip>
                    )}
                    <AIChatProviderModelSelect
                        activeProvider={activeProvider}
                        dynamicModels={dynamicModels}
                        loadingModels={loadingModels}
                        variant="v2"
                        onModelChange={onModelChange}
                        onFetchModels={onFetchModels}
                    />
                    <AIChatThinkingIntensitySelect
                        activeProvider={activeProvider}
                        value={thinkingIntensity}
                        variant="v2"
                        onChange={onThinkingIntensityChange}
                    />
                    {contextUsageChars !== undefined && maxContextChars !== undefined && (
                        <Tooltip title={memoryTooltipLabel}>
                            <div className={`gn-v2-ai-token-meter${contextUsageChars > maxContextChars * 0.8 ? ' is-warn' : ''}`}>
                                <span className="gn-v2-ai-token-bar" aria-hidden="true">
                                    <span style={{ width: `${Math.min(100, (contextUsageChars / Math.max(1, maxContextChars)) * 100)}%` }} />
                                </span>
                                <span className="gn-v2-ai-token-meter-text">
                                    {(contextUsageChars / 1000).toFixed(1)}k/{(maxContextChars / 1000).toFixed(0)}k
                                </span>
                            </div>
                        </Tooltip>
                    )}
                </div>
            </div>

            <AIContextSelectorModal
                open={contextOpen}
                loading={contextLoading}
                confirmLoading={appendingContext}
                darkMode={darkMode}
                textColor={textColor}
                overlayTheme={overlayTheme}
                dbList={dbList}
                selectedDbName={selectedDbName}
                searchText={searchText}
                filteredTables={filteredTables}
                selectedTableKeys={selectedTableKeys}
                onCancel={() => setContextOpen(false)}
                onConfirm={handleAppendContext}
                onDbChange={handleDbChange}
                onSearchTextChange={setSearchText}
                onSelectedTableKeysChange={setSelectedTableKeys}
            />
        </div>
    );
};
