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
import type { CLIModelCatalog } from '../../utils/aiProviderManagement';
import type { CLIThinkingCapability } from './useAIChatRuntimeResources';
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
    providers?: AIProviderConfig[];
    providerModels?: Record<string, string[]>;
    dynamicModels: string[];
    loadingModels: boolean;
    sendShortcutBinding: ShortcutPlatformBinding;
    shortcutPlatform?: ShortcutPlatform;
    composerNotice?: AIComposerNotice | null;
    onComposerAction?: (actionKey: AIComposerNoticeAction) => void;
    onModelChange: (val: string) => void;
    onProviderModelChange?: (providerId: string, model: string) => void;
    onManageProvider?: (providerId: string) => void;
    onFetchModels: () => void;
    onFetchProviderModels?: (providerId: string) => void;
    thinkingIntensity: string;
    onThinkingIntensityChange: (val: string) => void;
    cliCapability?: CLIThinkingCapability;
    cliCatalog?: CLIModelCatalog;
    textareaRef: React.RefObject<HTMLTextAreaElement>;
    darkMode: boolean;
    textColor: string;
    mutedColor: string;
    overlayTheme: OverlayWorkbenchTheme;
    contextUsageChars?: number;
    maxContextChars?: number;
}

export const AIChatInput: React.FC<AIChatInputProps> = ({
    input, setInput, draftAttachments, setDraftAttachments, sending, dispatchMode = 'queue', hasActiveRun = false,
    onDispatchModeChange, onSend, onStop, handleKeyDown,
    activeConnName, activeContext, activeProvider, providers, providerModels, dynamicModels, loadingModels,
    sendShortcutBinding, shortcutPlatform = 'windows', composerNotice, onComposerAction,
    onModelChange, onProviderModelChange, onManageProvider, onFetchModels, onFetchProviderModels, thinkingIntensity, onThinkingIntensityChange,
    cliCapability, cliCatalog,
    textareaRef, darkMode, textColor, mutedColor, overlayTheme,
    contextUsageChars, maxContextChars
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
                    activeContextItems={activeContextItems}
                    contextExpanded={contextExpanded}
                    onToggleExpanded={() => setContextExpanded(!contextExpanded)}
                    onOpenContext={handleOpenContext}
                    onRemoveContext={handleRemoveContextItem}
                />
                <AIChatAttachmentStrip
                    attachments={draftAttachments}
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
                            input={input}
                            draftAttachmentCount={draftAttachments.length}
                            sending={sending}
                            dispatchMode={dispatchMode}
                            hasActiveRun={hasActiveRun}
                            onDispatchModeChange={onDispatchModeChange}
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
                        providers={providers}
                        providerModels={providerModels}
                        dynamicModels={dynamicModels}
                        loadingModels={loadingModels}
                        onModelChange={onModelChange}
                        onProviderModelChange={onProviderModelChange}
                        onManageProvider={onManageProvider}
                        onFetchModels={onFetchModels}
                        onFetchProviderModels={onFetchProviderModels}
                    />
                    <AIChatThinkingIntensitySelect
                        activeProvider={activeProvider}
                        value={thinkingIntensity}
                        onChange={onThinkingIntensityChange}
                        cliCapability={cliCapability}
                        cliCatalog={cliCatalog}
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
