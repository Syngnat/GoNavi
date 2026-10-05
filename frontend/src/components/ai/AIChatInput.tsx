import React from 'react';
import { Input, Tooltip } from 'antd';
import { GnDatabaseIcon } from '../icons/gnIcons';
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
import type { AIChatAttachment, AIEditorSelection } from '../../types';
import type { AIRunDispatchMode } from './aiRunHarnessClient';
import { AIContextRing } from './AIContextRing';
import { useAIContextBreakdown } from './useAIContextBreakdown';
import type { AIHistoryMeasure } from './aiContextBreakdown';
import { isAIEditorSelectionContext, isAITableSchemaContext } from './aiEditorSelectionContext';
import { isTransientContextItem } from './aiContextChips';
import AIComposerBoundChips from './AIComposerBoundChips';
import { useAIImageOcr } from './ocr/useAIImageOcr';
import AIOcrInstallModal from './ocr/AIOcrInstallModal';
import BuiltinAITermsModal from './builtinTerms/BuiltinAITermsModal';

interface AIChatInputProps {
    input: string;
    setInput: (val: string) => void;
    draftAttachments: AIChatAttachment[];
    setDraftAttachments: React.Dispatch<React.SetStateAction<AIChatAttachment[]>>;
    sending: boolean;
    dispatchMode?: AIRunDispatchMode;
    hasActiveRun?: boolean;
    stopRequestPending?: boolean;
    onDispatchModeChange?: (mode: AIRunDispatchMode) => void;
    onSend: () => void;
    onStop: () => void;
    handleKeyDown: (e: React.KeyboardEvent) => void;
    activeConnName: string;
    activeContext: { connectionId?: string | null; dbName?: string | null } | null;
    activeEditorSelection?: AIEditorSelection | null;
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
    /** What the conversation so far takes, by role; the composer adds what is being typed. */
    contextHistory?: AIHistoryMeasure;
    contextWindow?: number;
    /** The conversation the next message goes into (none before the first message). */
    contextSessionId?: string;
}

export const AIChatInput: React.FC<AIChatInputProps> = ({
    input, setInput, draftAttachments, setDraftAttachments, sending, dispatchMode = 'queue', hasActiveRun = false,
    stopRequestPending = false,
    onDispatchModeChange, onSend, onStop, handleKeyDown,
    activeConnName, activeContext, activeEditorSelection, activeProvider, providers, providerModels, dynamicModels, loadingModels,
    sendShortcutBinding, shortcutPlatform = 'windows', composerNotice, onComposerAction,
    onModelChange, onProviderModelChange, onManageProvider, onFetchModels, onFetchProviderModels, thinkingIntensity, onThinkingIntensityChange,
    cliCapability, cliCatalog,
    textareaRef, darkMode, textColor, mutedColor, overlayTheme,
    contextHistory, contextWindow, contextSessionId,
}) => {
    const i18n = useOptionalI18n();
    const t = i18n?.t ?? ((key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
        catalogTranslate('en-US', key, params));
    const aiContexts = useStore(state => state.aiContexts);
    const addAIContext = useStore(state => state.addAIContext);
    const removeAIContext = useStore(state => state.removeAIContext);

    const connectionKey = activeContext?.connectionId ? `${activeContext.connectionId}:${activeContext.dbName || ''}` : 'default';
    const editorSelectionForContext = activeEditorSelection
        && (!activeContext?.connectionId || !activeEditorSelection.connectionId
            || activeEditorSelection.connectionId === activeContext.connectionId)
        && (!activeContext?.dbName || !activeEditorSelection.dbName
            || activeEditorSelection.dbName === activeContext.dbName)
        ? activeEditorSelection
        : null;
    const activeContextItems = aiContexts[connectionKey] || [];
    const contextBreakdown = useAIContextBreakdown({
        history: contextHistory, contextWindow, activeProvider, contextItems: activeContextItems, input, draftAttachments,
        sessionId: contextSessionId,
    });
    const composerReadiness = React.useMemo(() => buildAIChatReadinessSnapshot({
        activeProvider,
        dynamicModels,
        loadingModels,
        activeContext,
        activeContextItems,
        translate: t,
    }), [activeProvider, dynamicModels, loadingModels, activeContext, activeContextItems, t]);
    const {
        appendingContext,
        contextExpanded,
        contextLoading,
        contextOpen,
        dbList,
        filteredTables,
        handleAppendContext,
        handleBindEditorSelection,
        handleDbChange,
        handleOpenContext,
        handleRemoveContextItem,
        searchText,
        selectedDbName,
        selectedEditorSelection,
        selectedTableKeys,
        setContextExpanded,
        setContextOpen,
        setSearchText,
        setSelectedEditorSelection,
        setSelectedTableKeys,
    } = useAIChatContextBinding({
        activeContext,
        activeEditorSelection: editorSelectionForContext,
        activeContextItems,
        connectionKey,
        addAIContext,
        removeAIContext,
        translate: t,
    });
    const editorSelectionBound = Boolean(editorSelectionForContext)
        && activeContextItems.some((item) => isAIEditorSelectionContext(item)
            && item.source?.tabId === editorSelectionForContext?.tabId
            && String(item.content || item.ddl || '') === editorSelectionForContext?.text);

    // A model that cannot see images is given the text in them instead.
    const imageOcr = useAIImageOcr({ provider: activeProvider, draftAttachments, setDraftAttachments });
    const {
        fileInputRef,
        handleAttachmentUpload,
        handlePasteImages,
        handleRemoveDraftAttachment,
    } = useAIChatDraftAttachments({
        setDraftAttachments,
        translate: t,
        onAttachmentAdded: imageOcr.onAttachmentAdded,
    });

    const {
        activeSlashCmd,
        filteredSlashCmds,
        handleComposerInputChange,
        handleOpenSlashMenu,
        handleSelectSlashCommand,
        handleSlashKeyDown,
        setActiveSlashCmd,
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
                    activeContextItems={activeContextItems.filter(isAITableSchemaContext)}
                    contextExpanded={contextExpanded}
                    onToggleExpanded={() => setContextExpanded(!contextExpanded)}
                    onOpenContext={handleOpenContext}
                    onRemoveContext={handleRemoveContextItem}
                    activeEditorSelection={editorSelectionForContext}
                    editorSelectionBound={editorSelectionBound}
                    onBindEditorSelection={handleBindEditorSelection}
                />
                <AIChatAttachmentStrip
                    attachments={draftAttachments}
                    onRemove={handleRemoveDraftAttachment}
                    onReadImage={imageOcr.readNow}
                />
                <AIChatComposerNotice
                    composerNotice={composerNotice}
                    darkMode={darkMode}
                    textColor={textColor}
                    mutedColor={mutedColor}
                    onComposerNoticeAction={composerNoticeActionHandler}
                />
                {!composerNotice && !composerReadiness.ready && (
                    <AIChatComposerStatus
                        snapshot={composerReadiness}
                        darkMode={darkMode}
                        overlayTheme={overlayTheme}
                        onAction={composerActionHandler}
                    />
                )}
                <div className="gn-v2-ai-input-box" data-ai-chat-composer-input="true" style={{ position: 'relative' }}>
                    <AISlashCommandMenu
                        visible={showSlashMenu}
                        commands={filteredSlashCmds}
                        darkMode={darkMode}
                        textColor={textColor}
                        mutedColor={mutedColor}
                        activeCmd={activeSlashCmd}
                        onActiveChange={setActiveSlashCmd}
                        className="gn-v2-ai-slash-menu"
                        style={{
                            background: darkMode ? '#2a2a2a' : '#fff',
                            border: `1px solid ${darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'}`,
                        }}
                        onSelect={handleSelectSlashCommand}
                    />
                    <div className="gn-v2-ai-input-surface">
                        <AIComposerBoundChips items={activeContextItems} copy={t} onRemove={handleRemoveContextItem} />
                        <Input.TextArea
                            onPaste={handlePasteImages}
                            ref={textareaRef as any}
                            value={input}
                            onChange={(e) => handleComposerInputChange(e.target.value)}
                            onKeyDown={(event) => { if (!handleSlashKeyDown(event)) handleKeyDown(event); }}
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
                            hasBoundSelection={activeContextItems.some(isTransientContextItem)}
                            recognizingImages={imageOcr.recognizing}
                            sending={sending}
                            dispatchMode={dispatchMode}
                            hasActiveRun={hasActiveRun}
                            stopRequestPending={stopRequestPending}
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
                                <GnDatabaseIcon />
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
                    {contextBreakdown && <AIContextRing breakdown={contextBreakdown} copy={t} />}
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
                activeEditorSelection={editorSelectionForContext}
                selectedEditorSelection={selectedEditorSelection}
                onCancel={() => setContextOpen(false)}
                onConfirm={handleAppendContext}
                onDbChange={handleDbChange}
                onSearchTextChange={setSearchText}
                onSelectedTableKeysChange={setSelectedTableKeys}
                onSelectedEditorSelectionChange={setSelectedEditorSelection}
            />
            <AIOcrInstallModal />
            <BuiltinAITermsModal />
        </div>
    );
};
