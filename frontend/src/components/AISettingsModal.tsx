import React, { useCallback, useRef } from 'react';
import Modal from './common/ResizableDraggableModal';
import AiSparkOutlined from './icons/AiSparkOutlined';
import { withAISettingsLeaveGuard, type AISettingsLeaveGuard } from '../utils/aiSettingsLeaveGuard';
import { APP_STATIC_FEEDBACK_Z_INDEX_BASE } from '../utils/overlayZIndex';
import type { OverlayWorkbenchTheme } from '../utils/overlayWorkbenchTheme';
import { useI18n } from '../i18n/provider';
import AIBuiltinToolsCatalog from './ai/AIBuiltinToolsCatalog';
import AISettingsMCPSection from './ai/AISettingsMCPSection';
import AISettingsSidebar, { type AISettingsSectionKey } from './ai/AISettingsSidebar';
import AISettingsSafetySection from './ai/AISettingsSafetySection';
import AISettingsContextSection from './ai/AISettingsContextSection';
import AISettingsRunPolicySection from './ai/AISettingsRunPolicySection';
import AISettingsProvidersSection from './ai/AISettingsProvidersSection';
import AISettingsInsightSection from './ai/AISettingsInsightSection';
import AISettingsPromptsSection from './ai/AISettingsPromptsSection';
import AISettingsSkillsSection from './ai/AISettingsSkillsSection';
import { useAISettingsState } from './aiSettings/hooks/useAISettingsState';
import { useAISettingsProviderEditing } from './aiSettings/hooks/useAISettingsProviderEditing';
import { useAISettingsMcpAndPresets } from './aiSettings/hooks/useAISettingsMcpAndPresets';

interface AISettingsModalProps {
    open: boolean;
    onClose: () => void;
    darkMode: boolean;
    overlayTheme: OverlayWorkbenchTheme;
    focusProviderId?: string;
    onBeforeExternalMCPUse?: () => Promise<void>;
}

export interface AISettingsContentProps {
    active: boolean;
    darkMode: boolean;
    overlayTheme: OverlayWorkbenchTheme;
    focusProviderId?: string;
    hideSidebar?: boolean;
    section?: AISettingsSectionKey;
    onSectionChange?: (section: AISettingsSectionKey) => void;
    providersView?: 'workspace' | 'connected';
    onProvidersViewChange?: (view: 'workspace' | 'connected') => void;
    onCloseHost?: () => void;
    onBeforeExternalMCPUse?: () => Promise<void>;
    onLeaveGuardChange?: (guard: AISettingsLeaveGuard | null) => void;
    confirmationZIndex?: number;
}

export const AISettingsContent: React.FC<AISettingsContentProps> = ({ active, darkMode, overlayTheme, focusProviderId, hideSidebar = false, section, onSectionChange, providersView = 'workspace', onProvidersViewChange, onCloseHost, onBeforeExternalMCPUse, onLeaveGuardChange, confirmationZIndex = APP_STATIC_FEEDBACK_Z_INDEX_BASE }) => {
    const {
      t, defaultMCPHTTPServerStatus, providers, activeProviderId, setActiveProviderId,
      pendingProviderId, setPendingProviderId, providersLoading, setProvidersLoading,
      providersLoadError, safetyLevel, setSafetyLevel, resultMaskingSettings,
      setResultMaskingSettings, resultMaskingLoading, resultMaskingSaving, setResultMaskingSaving,
      resultMaskingLoadError, resultMaskingSaveError, setResultMaskingSaveError, contextLevel,
      setContextLevel, runPolicy, setRunPolicy, runRuntime, setRunRuntime, runPolicyRevision,
      setRunPolicyRevision, runPolicyLoading, runPolicySaving, setRunPolicySaving, runPolicyError,
      setRunPolicyError, ledgerState, mcpServers, setMCPServers, mcpTools, setMCPTools,
      mcpHTTPServerStatus, setMCPHTTPServerStatus, mcpHTTPServerDraft, setMCPHTTPServerDraft,
      mcpHTTPServerLoading, setMCPHTTPServerLoading, skills, setSkills, editingProvider,
      setEditingProvider, isEditing, loading, setLoading, testStatus, setTestStatus, testResult,
      setTestResult, providerTesting, setProviderTesting, providerSaving, setProviderSaving,
      providerSaveMode, setProviderSaveMode, providerDirty, builtinPrompts, userPromptSettings,
      setUserPromptSettings, activeSection, applySection, primaryPasswordVisible,
      setPrimaryPasswordVisible, form, modalBodyRef, settingsContentScrollRef, mountedRef,
      activeRef, committedProviderRef, switchTargetRef, switchRunningRef, providerLoadSequenceRef,
      editorSessionRef, openedFocusProviderRef, configRevisionRef, testRequestRef, saveRunningRef,
      editedFieldsRef, providerDirtyRef, providerBaselineRef, discardConfirmationRef,
      cancelDiscardRef, invalidateProviderTest, refreshProviderDirty, handleProviderValuesChange,
      handleCLIDefaults, aiChatOpenMode, setAIChatOpenMode, messageApi, messageContextHolder,
      modalApi, modalContextHolder, cardBg, cardBorder, inputBg, watchedPresetKey, watchedApiFormat,
      localizedProviderPresets, findLocalizedPreset, matchLocalizedProviderPreset,
      skillRequiredToolOptions, resolveAIService, copyTextToClipboard,
      handleCopySelectedMCPConfigPath, handleCopySelectedMCPLaunchCommand,
      handleInstallSelectedMCPClient, handleUpdateStaleMCPClients, handleSelectMCPClient,
      loadMCPClientStatuses, mcpClientStatusLoading, mcpClientStatuses, selectedMCPClient,
      selectedMCPClientCommandText, selectedMCPClientStatus, loadProviders, loadConfig,
      applyProviderEditorSession, resetProviderEditorSession,
    } = useAISettingsState({ section, onSectionChange, active, darkMode, onBeforeExternalMCPUse });

    const {
      confirmProviderLeave, handleCancelProviderEdit, handleAddProvider, handleApplyPartnerBaseUrl,
      handleEditProvider, handleDeleteProvider, buildProviderPayload, handleSaveProvider,
      handleSetActive, handleSafetyChange, handleSaveResultMasking, handleContextChange,
      handleReloadRunPolicy,
    } = useAISettingsProviderEditing({
      confirmationZIndex, saveRunningRef, messageApi, t, providerDirtyRef, discardConfirmationRef,
      mountedRef, activeRef, resetProviderEditorSession, cancelDiscardRef, modalApi,
      onLeaveGuardChange, active, providers, applyProviderEditorSession, editorSessionRef,
      invalidateProviderTest, resolveAIService, focusProviderId, openedFocusProviderRef,
      applySection, committedProviderRef, editingProvider, loadProviders, form, configRevisionRef,
      setProviderSaveMode, setProviderSaving, setEditingProvider, providerBaselineRef,
      refreshProviderDirty, switchRunningRef, switchTargetRef, setPendingProviderId,
      providerLoadSequenceRef, setProvidersLoading, setActiveProviderId, setSafetyLevel,
      resultMaskingLoadError, resultMaskingSaving, setResultMaskingSaving,
      setResultMaskingSaveError, resultMaskingSettings, setContextLevel, setRunPolicyError,
      loadConfig,
    });

    const {
      handleSaveRunPolicy, handleSaveUserPromptSettings, updateMCPServerDraft, handleAddMCPServer,
      handleSaveMCPServer, handleDeleteMCPServer, handleTestMCPServer, handleToggleMCPHTTPServer,
      handleUpdateMCPHTTPServerDraft, handleCopyMCPHTTPServerURL,
      handleCopyMCPHTTPServerAuthorization, updateSkillDraft, handleAddSkill, handleSaveSkill,
      handleDeleteSkill, handleTestProvider, handleSyncProviderModels, handlePresetChange,
      handleProviderConnectionModeChange, handleProviderAuthModeChange, renderSectionPanel,
    } = useAISettingsMcpAndPresets({
      runPolicySaving, setRunPolicySaving, setRunPolicyError, resolveAIService, t,
      runPolicyRevision, setRunPolicyRevision, runRuntime, setRunRuntime, runPolicy, setRunPolicy,
      mountedRef, activeRef, messageApi, setLoading, userPromptSettings, setUserPromptSettings,
      setMCPServers, loadConfig, setMCPTools, onBeforeExternalMCPUse, setMCPHTTPServerLoading,
      mcpHTTPServerDraft, setMCPHTTPServerDraft, defaultMCPHTTPServerStatus, setMCPHTTPServerStatus,
      mcpHTTPServerStatus, copyTextToClipboard, setSkills, editorSessionRef, configRevisionRef,
      testRequestRef, setProviderTesting, setTestStatus, setTestResult, form, buildProviderPayload,
      editingProvider, providers, invalidateProviderTest, refreshProviderDirty, editedFieldsRef,
      hideSidebar, overlayTheme, activeSection,
    });

    return (
        <div ref={modalBodyRef} className="ai-settings-body gonavi-ai-settings-flat" style={{ display: 'flex', gap: 16, padding: '0', height: '100%', minHeight: 0, overflow: 'hidden', position: 'relative', boxSizing: 'border-box' }}>
            {messageContextHolder}
            {modalContextHolder}
            {hideSidebar ? null : (
            <AISettingsSidebar
                activeSection={activeSection}
                darkMode={darkMode}
                overlayTheme={overlayTheme}
                onSelectSection={(nextSection) => {
                    if (nextSection !== activeSection) withAISettingsLeaveGuard(confirmProviderLeave, () => applySection(nextSection));
                }}
            />
            )}
            <div
                ref={settingsContentScrollRef}
                className="gonavi-ai-settings-content"
                style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: activeSection === 'providers' || activeSection === 'request_events' ? 'hidden' : 'auto', overflowX: 'hidden', overscrollBehavior: 'contain', padding: '0 6px 8px 0' }}
            >
                {renderSectionPanel('providers', (
                    <AISettingsProvidersSection
                        treeHostedView={hideSidebar ? providersView : undefined}
                        onOpenWorkspaceView={hideSidebar ? () => onProvidersViewChange?.('workspace') : undefined}
                        onCloseHost={hideSidebar ? onCloseHost : undefined}
                        providers={providers}
                        activeProviderId={activeProviderId}
                        pendingProviderId={pendingProviderId}
                        providersLoading={providersLoading}
                        loadError={providersLoadError}
                        onReloadProviders={() => void loadProviders()}
                        editingProvider={editingProvider}
                        editorSessionKey={editorSessionRef.current}
                        isEditing={isEditing}
                        form={form}
                        providerPresets={localizedProviderPresets}
                        watchedPresetKey={watchedPresetKey}
                        watchedApiFormat={watchedApiFormat}
                        loading={providerSaving}
                        testing={providerTesting}
                        testStatus={testStatus}
                        testResult={testResult}
                        onValuesChange={handleProviderValuesChange}
                        onCLIDefaults={handleCLIDefaults}
                        primaryPasswordVisible={primaryPasswordVisible}
                        darkMode={darkMode}
                        overlayTheme={overlayTheme}
                        cardBg={cardBg}
                        cardBorder={cardBorder}
                        onPrimaryPasswordVisibleChange={setPrimaryPasswordVisible}
                        resolveProviderPreset={matchLocalizedProviderPreset}
                        resolvePresetByKey={findLocalizedPreset}
                        onAddProvider={handleAddProvider}
                        onEditProvider={handleEditProvider}
                        onDeleteProvider={handleDeleteProvider}
                        onSetActiveProvider={handleSetActive}
                        onCancelEdit={handleCancelProviderEdit}
                        onPresetChange={handlePresetChange}
                        onConnectionModeChange={handleProviderConnectionModeChange}
                        onCopyPartnerCode={(code) => copyTextToClipboard(code)}
                        onApplyPartnerBaseUrl={handleApplyPartnerBaseUrl}
                        onSyncProviderModels={handleSyncProviderModels}
                        onAuthModeChange={handleProviderAuthModeChange}
                        onTestProvider={handleTestProvider}
                        onSaveProvider={() => handleSaveProvider()}
                        onSaveProviderAsCopy={() => handleSaveProvider('copy')}
                        saveMode={providerSaveMode}
                        dirty={providerDirty}
                    />
                ))}
                {(['analysis', 'request_events', 'image_recognition'] as const).map((section) => renderSectionPanel(section, (
                    <AISettingsInsightSection
                        section={section}
                        active={active && activeSection === section}
                        providers={providers}
                        overlayTheme={overlayTheme}
                        cardBg={cardBg}
                        cardBorder={cardBorder}
                    />
                )))}
                {renderSectionPanel('safety', (
                    <AISettingsSafetySection
                        safetyLevel={safetyLevel}
                        darkMode={darkMode}
                        overlayTheme={overlayTheme}
                        cardBg={cardBg}
                        cardBorder={cardBorder}
                        onChange={handleSafetyChange}
                        resultMaskingSettings={resultMaskingSettings}
                        resultMaskingLoading={resultMaskingLoading}
                        resultMaskingSaving={resultMaskingSaving}
                        resultMaskingLoadError={resultMaskingLoadError}
                        resultMaskingSaveError={resultMaskingSaveError}
                        onResultMaskingChange={setResultMaskingSettings}
                        onSaveResultMasking={() => void handleSaveResultMasking()}
                        onReloadResultMasking={() => void loadConfig()}
                    />
                ))}
                {renderSectionPanel('context', (
                    <AISettingsContextSection
                        contextLevel={contextLevel}
                        openMode={aiChatOpenMode}
                        darkMode={darkMode}
                        overlayTheme={overlayTheme}
                        cardBg={cardBg}
                        cardBorder={cardBorder}
                        onChange={handleContextChange}
                        onOpenModeChange={(mode) => {
                            setAIChatOpenMode(mode);
                            void messageApi.success(
                                mode === 'detached'
                                    ? t('ai_settings.open_mode.message.detached')
                                    : t('ai_settings.open_mode.message.dock'),
                            );
                        }}
                    />
                ))}
                {renderSectionPanel('run_policy', (
                    <AISettingsRunPolicySection
                        policy={runPolicy}
                        runtime={runRuntime}
                        loading={runPolicyLoading}
                        saving={runPolicySaving}
                        error={runPolicyError}
                        ledgerState={ledgerState}
                        overlayTheme={overlayTheme}
                        inputBg={inputBg}
                        onChange={setRunPolicy}
                        onRuntimeChange={setRunRuntime}
                        onReload={handleReloadRunPolicy}
                        onSave={() => void handleSaveRunPolicy()}
                    />
                ))}
                {renderSectionPanel('mcp', (
                    <AISettingsMCPSection
                        mcpClientStatuses={mcpClientStatuses}
                        selectedMCPClient={selectedMCPClient}
                        selectedMCPClientStatus={selectedMCPClientStatus}
                        selectedMCPClientCommandText={selectedMCPClientCommandText}
                        mcpHTTPServerStatus={mcpHTTPServerStatus}
                        mcpHTTPServerDraft={mcpHTTPServerDraft}
                        safetyLevel={safetyLevel}
                        mcpServers={mcpServers}
                        mcpTools={mcpTools}
                        darkMode={darkMode}
                        overlayTheme={overlayTheme}
                        cardBg={cardBg}
                        cardBorder={cardBorder}
                        inputBg={inputBg}
                        loading={loading}
                        mcpClientStatusLoading={mcpClientStatusLoading}
                        mcpHTTPServerLoading={mcpHTTPServerLoading}
                        onUpdateHTTPServerDraft={handleUpdateMCPHTTPServerDraft}
                        onToggleHTTPServer={handleToggleMCPHTTPServer}
                        onCopyHTTPServerURL={() => void handleCopyMCPHTTPServerURL()}
                        onCopyHTTPServerAuthorization={() => void handleCopyMCPHTTPServerAuthorization()}
                        onSelectClient={handleSelectMCPClient}
                        onRefreshStatus={() => void loadMCPClientStatuses()}
                        onCopyConfigPath={() => void handleCopySelectedMCPConfigPath()}
                        onCopyLaunchCommand={() => void handleCopySelectedMCPLaunchCommand()}
                        onInstallSelectedClient={handleInstallSelectedMCPClient}
                        onUpdateStaleClients={handleUpdateStaleMCPClients}
                        onAddServer={handleAddMCPServer}
                        onUpdateServerDraft={updateMCPServerDraft}
                        onTestServer={handleTestMCPServer}
                        onSaveServer={handleSaveMCPServer}
                        onDeleteServer={handleDeleteMCPServer}
                    />
                ))}
                {renderSectionPanel('skills', (
                    <AISettingsSkillsSection
                        skills={skills}
                        skillRequiredToolOptions={skillRequiredToolOptions}
                        overlayTheme={overlayTheme}
                        cardBg={cardBg}
                        cardBorder={cardBorder}
                        inputBg={inputBg}
                        loading={loading}
                        onAddSkill={handleAddSkill}
                        onUpdateSkillDraft={updateSkillDraft}
                        onSaveSkill={handleSaveSkill}
                        onDeleteSkill={handleDeleteSkill}
                    />
                ))}
                {renderSectionPanel('tools', (
                    <AIBuiltinToolsCatalog
                        darkMode={darkMode}
                        overlayTheme={overlayTheme}
                        cardBg={cardBg}
                        cardBorder={cardBorder}
                    />
                ))}
                {renderSectionPanel('prompts', (
                    <AISettingsPromptsSection
                        builtinPrompts={builtinPrompts}
                        userPromptSettings={userPromptSettings}
                        overlayTheme={overlayTheme}
                        cardBg={cardBg}
                        cardBorder={cardBorder}
                        inputBg={inputBg}
                        darkMode={darkMode}
                        loading={loading}
                        onChangeUserPrompt={(key, value) => setUserPromptSettings((prev) => ({
                            ...prev,
                            [key]: value,
                        }))}
                        onSave={handleSaveUserPromptSettings}
                    />
                ))}
            </div>
        </div>
    );
};

const AISettingsModal: React.FC<AISettingsModalProps> = ({ open, onClose, darkMode, overlayTheme, focusProviderId, onBeforeExternalMCPUse }) => {
    const { t } = useI18n();
    const leaveGuardRef = useRef<AISettingsLeaveGuard | null>(null);
    const registerLeaveGuard = useCallback((guard: AISettingsLeaveGuard | null) => { leaveGuardRef.current = guard; }, []);
    const modalShellStyle = {
        background: overlayTheme.shellBg, border: overlayTheme.shellBorder,
        boxShadow: overlayTheme.shellShadow, backdropFilter: overlayTheme.shellBackdropFilter,
    };

    return (
        <Modal
            title={
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                    <div style={{
                        width: 38, height: 38, borderRadius: 12, display: 'grid', placeItems: 'center',
                        background: overlayTheme.iconBg, color: overlayTheme.iconColor, fontSize: 18, flexShrink: 0,
                    }}>
                        <AiSparkOutlined />
                    </div>
                    <div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: overlayTheme.titleText }}>{t('ai_settings.title')}</div>
                        <div style={{ marginTop: 3, color: overlayTheme.mutedText, fontSize: 12 }}>
                            {t('ai_settings.subtitle')}
                        </div>
                    </div>
                </div>
            }
            open={open}
            onCancel={() => { void withAISettingsLeaveGuard(leaveGuardRef.current, onClose); }}
            footer={null}
            width={1080}
            styles={{
                content: modalShellStyle,
                header: { background: 'transparent', borderBottom: 'none', paddingBottom: 8 },
                body: { paddingTop: 8, height: 620, overflow: 'hidden' },
            }}
        >
              <AISettingsContent
                active={open}
                darkMode={darkMode}
                overlayTheme={overlayTheme}
                focusProviderId={focusProviderId}
                onBeforeExternalMCPUse={onBeforeExternalMCPUse}
                onLeaveGuardChange={registerLeaveGuard}
              />
        </Modal>
    );
};

export default AISettingsModal;
