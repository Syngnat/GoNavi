import { Button, message, Input, Switch } from 'antd';
import { isToolCenterGroupKey, isConnectionPackageSettingsPaneKey } from '../settingsCenterPanes';
import ConnectionImportSettingsPanel from '../../components/settings/ConnectionImportSettingsPanel';
import ConnectionPackagePasswordModal from '../../components/ConnectionPackagePasswordModal';
import ConnectionHealthModal from '../../components/ConnectionHealthModal';
import Modal from '../../components/common/ResizableDraggableModal';
import SecurityUpdateSettingsModal from '../../components/SecurityUpdateSettingsModal';
import DriverManagerModal from '../../components/DriverManagerModal';
import SnippetSettingsModal from '../../components/SnippetSettingsModal';
import {
  SHORTCUT_ACTION_ORDER, SHORTCUT_ACTION_META, resolveShortcutBinding, splitConflictsByContext,
  getShortcutDisplayLabel,
} from '../../utils/shortcuts';
import type { RenderAppSettingsCenterModalInput } from './renderAppSettingsCenterModal';

export interface CreateToolCenterPaneRendererInput {
  activeSettingsCenterPane: RenderAppSettingsCenterModalInput['activeSettingsCenterPane'];
  connectionImportGroupOptions: RenderAppSettingsCenterModalInput['connectionImportGroupOptions'];
  connectionImportTargetTagId: RenderAppSettingsCenterModalInput['connectionImportTargetTagId'];
  connectionPackageDialog: RenderAppSettingsCenterModalInput['connectionPackageDialog'];
  pendingConnectionImportPayload: RenderAppSettingsCenterModalInput['pendingConnectionImportPayload'];
  connectionImportNotice: RenderAppSettingsCenterModalInput['connectionImportNotice'];
  setConnectionImportTargetTagId: RenderAppSettingsCenterModalInput['setConnectionImportTargetTagId'];
  setConnectionImportNotice: RenderAppSettingsCenterModalInput['setConnectionImportNotice'];
  setConnectionPackageDialog: RenderAppSettingsCenterModalInput['setConnectionPackageDialog'];
  handleImportConnections: RenderAppSettingsCenterModalInput['handleImportConnections'];
  handleConfirmConnectionPackageDialog: RenderAppSettingsCenterModalInput['handleConfirmConnectionPackageDialog'];
  setPendingConnectionImportPayload: RenderAppSettingsCenterModalInput['setPendingConnectionImportPayload'];
  utilityPanelStyle: RenderAppSettingsCenterModalInput['utilityPanelStyle'];
  utilityMutedTextStyle: RenderAppSettingsCenterModalInput['utilityMutedTextStyle'];
  t: RenderAppSettingsCenterModalInput['t'];
  connections: RenderAppSettingsCenterModalInput['connections'];
  closeConnectionPackageDialog: RenderAppSettingsCenterModalInput['closeConnectionPackageDialog'];
  connectionHealthTargetIds: RenderAppSettingsCenterModalInput['connectionHealthTargetIds'];
  closeConnectionHealthSettingsPane: RenderAppSettingsCenterModalInput['closeConnectionHealthSettingsPane'];
  isWebRuntime: RenderAppSettingsCenterModalInput['isWebRuntime'];
  renderDataDirectorySettings: RenderAppSettingsCenterModalInput['renderDataDirectorySettings'];
  handleCancelSettingsCenterPane: RenderAppSettingsCenterModalInput['handleCancelSettingsCenterPane'];
  darkMode: RenderAppSettingsCenterModalInput['darkMode'];
  overlayTheme: RenderAppSettingsCenterModalInput['overlayTheme'];
  effectiveOpacity: RenderAppSettingsCenterModalInput['effectiveOpacity'];
  securityUpdateStatus: RenderAppSettingsCenterModalInput['securityUpdateStatus'];
  securityUpdateSettingsFocusTarget: RenderAppSettingsCenterModalInput['securityUpdateSettingsFocusTarget'];
  securityUpdateSettingsFocusRequest: RenderAppSettingsCenterModalInput['securityUpdateSettingsFocusRequest'];
  handleStartSecurityUpdate: RenderAppSettingsCenterModalInput['handleStartSecurityUpdate'];
  handleRetrySecurityUpdate: RenderAppSettingsCenterModalInput['handleRetrySecurityUpdate'];
  handleRestartSecurityUpdate: RenderAppSettingsCenterModalInput['handleRestartSecurityUpdate'];
  handleSecurityUpdateIssueAction: RenderAppSettingsCenterModalInput['handleSecurityUpdateIssueAction'];
  handleOpenSettingsCenterPane: RenderAppSettingsCenterModalInput['handleOpenSettingsCenterPane'];
  handleDownloadSourceChange: RenderAppSettingsCenterModalInput['handleDownloadSourceChange'];
  downloadSourceSaving: RenderAppSettingsCenterModalInput['downloadSourceSaving'];
  downloadSource: RenderAppSettingsCenterModalInput['downloadSource'];
  setCapturingShortcutAction: RenderAppSettingsCenterModalInput['setCapturingShortcutAction'];
  resetShortcutOptions: RenderAppSettingsCenterModalInput['resetShortcutOptions'];
  isMacRuntime: RenderAppSettingsCenterModalInput['isMacRuntime'];
  shortcutOptions: RenderAppSettingsCenterModalInput['shortcutOptions'];
  activeShortcutPlatform: RenderAppSettingsCenterModalInput['activeShortcutPlatform'];
  capturingShortcutAction: RenderAppSettingsCenterModalInput['capturingShortcutAction'];
  shortcutConflictMap: RenderAppSettingsCenterModalInput['shortcutConflictMap'];
  resolvedMonoFontFamily: RenderAppSettingsCenterModalInput['resolvedMonoFontFamily'];
  updateShortcut: RenderAppSettingsCenterModalInput['updateShortcut'];
}

export const createToolCenterPaneRenderer = ({
  activeSettingsCenterPane, connectionImportGroupOptions, connectionImportTargetTagId,
  connectionPackageDialog, pendingConnectionImportPayload, connectionImportNotice,
  setConnectionImportTargetTagId, setConnectionImportNotice, setConnectionPackageDialog,
  handleImportConnections, handleConfirmConnectionPackageDialog, setPendingConnectionImportPayload,
  utilityPanelStyle, utilityMutedTextStyle, t, connections, closeConnectionPackageDialog,
  connectionHealthTargetIds, closeConnectionHealthSettingsPane, isWebRuntime,
  renderDataDirectorySettings, handleCancelSettingsCenterPane, darkMode, overlayTheme,
  effectiveOpacity, securityUpdateStatus, securityUpdateSettingsFocusTarget,
  securityUpdateSettingsFocusRequest, handleStartSecurityUpdate, handleRetrySecurityUpdate,
  handleRestartSecurityUpdate, handleSecurityUpdateIssueAction, handleOpenSettingsCenterPane,
  handleDownloadSourceChange, downloadSourceSaving, downloadSource, setCapturingShortcutAction,
  resetShortcutOptions, isMacRuntime, shortcutOptions, activeShortcutPlatform,
  capturingShortcutAction, shortcutConflictMap, resolvedMonoFontFamily, updateShortcut,
}: CreateToolCenterPaneRendererInput) => {
  const renderToolCenterPane = () => {
    if (!activeSettingsCenterPane || !isToolCenterGroupKey(activeSettingsCenterPane.group)) {
      return null;
    }

    if (activeSettingsCenterPane.key === 'import') {
      return (
        <ConnectionImportSettingsPanel
          groupOptions={connectionImportGroupOptions}
          targetGroupId={connectionImportTargetTagId}
          password={connectionPackageDialog.mode === 'import' ? connectionPackageDialog.password : ''}
          protectedPackageReady={Boolean(pendingConnectionImportPayload)}
          busy={connectionPackageDialog.mode === 'import' && connectionPackageDialog.confirmLoading}
          error={connectionPackageDialog.mode === 'import' ? connectionPackageDialog.error : ''}
          notice={connectionImportNotice}
          onTargetGroupChange={(groupID) => {
              setConnectionImportTargetTagId(groupID);
              setConnectionImportNotice(null);
              setConnectionPackageDialog((current) => ({ ...current, error: '' }));
          }}
          onChooseFile={() => void handleImportConnections('config')}
          onPasswordChange={(value) => {
              setConnectionPackageDialog((current) => ({
                  ...current,
                  password: value,
                  error: '',
              }));
          }}
          onConfirmProtectedPackage={() => void handleConfirmConnectionPackageDialog()}
          onDiscardProtectedPackage={() => {
              setPendingConnectionImportPayload(null);
              setConnectionPackageDialog((current) => ({
                  ...current,
                  open: false,
                  password: '',
                  error: '',
                  confirmLoading: false,
              }));
          }}
        />
      );
    }

    if (isConnectionPackageSettingsPaneKey(activeSettingsCenterPane.key)) {
      if (!connectionPackageDialog.open) {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '12px 0' }}>
            <div style={utilityPanelStyle}>
              <div style={utilityMutedTextStyle}>
                {t('app.tools.entry.export.description')}
              </div>
              <div style={{ marginTop: 12, ...utilityMutedTextStyle }}>
                {t('app.connection_package.message.no_connections_to_export')}
              </div>
            </div>
          </div>
        );
      }
      return (
        <ConnectionPackagePasswordModal
          embedded
          open={connectionPackageDialog.open}
          title={connectionPackageDialog.mode === 'export'
              ? t('app.connection_package.dialog.export_title')
              : t('app.connection_package.dialog.import_password_title')}
          mode={connectionPackageDialog.mode}
          includeSecrets={connectionPackageDialog.includeSecrets}
          useFilePassword={connectionPackageDialog.useFilePassword}
          password={connectionPackageDialog.password}
          error={connectionPackageDialog.error}
          confirmLoading={connectionPackageDialog.confirmLoading}
          connectionOptions={connections.map((item) => ({
            value: item.id,
            label: item.name || item.id,
            type: item.config?.type,
          }))}
          selectedConnectionIds={connectionPackageDialog.selectedConnectionIds}
          onSelectedConnectionIdsChange={(ids) => {
              setConnectionPackageDialog((current) => ({
                  ...current,
                  selectedConnectionIds: ids,
                  error: '',
              }));
          }}
          confirmText={connectionPackageDialog.mode === 'export'
              ? t('app.connection_package.action.start_export')
              : t('app.connection_package.action.start_import')}
          onIncludeSecretsChange={(value) => {
              setConnectionPackageDialog((current) => ({
                  ...current,
                  includeSecrets: value,
                  useFilePassword: value ? current.useFilePassword : false,
                  password: value ? current.password : '',
                  error: '',
              }));
          }}
          onUseFilePasswordChange={(value) => {
              setConnectionPackageDialog((current) => ({
                  ...current,
                  useFilePassword: value,
                  password: value ? current.password : '',
                  error: '',
              }));
          }}
          onPasswordChange={(value) => {
              setConnectionPackageDialog((current) => ({
                  ...current,
                  password: value,
                  error: '',
              }));
          }}
          onConfirm={() => {
              void handleConfirmConnectionPackageDialog();
          }}
          onCancel={closeConnectionPackageDialog}
        />
      );
    }

    if (activeSettingsCenterPane.key === 'connection-health') {
      return (
        <ConnectionHealthModal
          embedded
          open
          targetConnectionIds={connectionHealthTargetIds}
          onClose={closeConnectionHealthSettingsPane}
        />
      );
    }

    if (activeSettingsCenterPane.key.startsWith('data-root')) {
      const dataDirectorySection = activeSettingsCenterPane.key === 'data-root-agent'
        ? 'agent'
        : activeSettingsCenterPane.key === 'data-root-saved-queries'
          ? 'saved-queries'
          : 'application';
      if (isWebRuntime) {
        return renderDataDirectorySettings(dataDirectorySection, true);
      }
      return (
        <Modal
          embedded
          open
          title={null}
          closable={false}
          onCancel={handleCancelSettingsCenterPane}
          footer={[
            <Button key="close" type="primary" onClick={handleCancelSettingsCenterPane}>
              {t('common.close')}
            </Button>,
          ]}
          styles={{
            header: { background: 'transparent', borderBottom: 'none', paddingBottom: 8 },
            body: { paddingTop: 8 },
            footer: { background: 'transparent', borderTop: 'none', paddingTop: 10 },
          }}
        >
          {renderDataDirectorySettings(dataDirectorySection)}
        </Modal>
      );
    }

    if (activeSettingsCenterPane.key === 'security-update') {
      return (
        <SecurityUpdateSettingsModal
          embedded
          open
          darkMode={darkMode}
          overlayTheme={overlayTheme}
          surfaceOpacity={effectiveOpacity}
          status={securityUpdateStatus}
          focusTarget={securityUpdateSettingsFocusTarget}
          focusRequest={securityUpdateSettingsFocusRequest}
          onClose={handleCancelSettingsCenterPane}
          onStart={handleStartSecurityUpdate}
          onRetry={handleRetrySecurityUpdate}
          onRestart={handleRestartSecurityUpdate}
          onIssueAction={handleSecurityUpdateIssueAction}
        />
      );
    }

    if (activeSettingsCenterPane.key === 'drivers') {
      return (
        <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <DriverManagerModal
            embedded
            open
            onClose={handleCancelSettingsCenterPane}
            onOpenGlobalProxySettings={() => handleOpenSettingsCenterPane('services', 'proxy')}
            onChangeDownloadSource={(source) => void handleDownloadSourceChange(source)}
            downloadSourceSwitching={downloadSourceSaving}
            downloadSource={downloadSource}
          />
        </div>
      );
    }

    if (activeSettingsCenterPane.key === 'snippet-settings') {
      return (
        <SnippetSettingsModal
          embedded
          open
          onClose={handleCancelSettingsCenterPane}
          darkMode={darkMode}
          overlayTheme={overlayTheme}
        />
      );
    }

    if (activeSettingsCenterPane.key === 'shortcut-settings') {
      return (
        <Modal
          embedded
          open
          title={null}
          closable={false}
          onCancel={() => {
            setCapturingShortcutAction(null);
            handleCancelSettingsCenterPane();
          }}
          footer={(
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Button
              key="reset"
              style={{ marginRight: 'auto' }}
              onClick={() => {
                 resetShortcutOptions();
                 setCapturingShortcutAction(null);
                 void message.success(t('app.shortcuts.message.restored_defaults'));
              }}
            >
              {t('app.shortcuts.action.restore_defaults')}
            </Button>
            <Button
              key="close"
              type="primary"
              onClick={() => {
                setCapturingShortcutAction(null);
                handleCancelSettingsCenterPane();
              }}
            >
               {t('common.close')}
            </Button>
            </div>
          )}
          styles={{
            header: { background: 'transparent', borderBottom: 'none', paddingBottom: 8 },
            body: { paddingTop: 8, overflow: 'hidden', flex: 1, minHeight: 0 },
            footer: { background: 'transparent', borderTop: 'none', paddingTop: 10 },
          }}
        >
          <div data-gonavi-shortcut-modal-scroll="true" className="gonavi-settings-center-pane-scroll" style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 8, paddingRight: 4 }}>
            <div style={utilityPanelStyle}>
              <div style={{ fontSize: 12, color: darkMode ? 'rgba(255,255,255,0.5)' : 'rgba(16,24,40,0.55)' }}>
                   {t('app.shortcuts.capture_hint')}
              </div>
            </div>
            {SHORTCUT_ACTION_ORDER.map((action) => {
              const meta = SHORTCUT_ACTION_META[action];
              if (meta.platformOnly === 'mac' && !isMacRuntime) {
                  return null;
              }
              const binding = resolveShortcutBinding(shortcutOptions, action, activeShortcutPlatform);
              const isCapturing = capturingShortcutAction === action;
              const conflicts = shortcutConflictMap[action];
              const conflictInfo = conflicts?.length ? splitConflictsByContext(conflicts) : null;
              return (
                  <div
                      key={action}
                      style={{
                          ...utilityPanelStyle,
                          display: 'grid',
                          gridTemplateColumns: '1fr auto',
                          gap: 12,
                          alignItems: 'center',
                          padding: '10px 12px',
                      }}
                  >
                      <div>
                          <div style={{ fontWeight: 500 }}>{meta.label}</div>
                          <div style={{ fontSize: 12, color: darkMode ? 'rgba(255,255,255,0.5)' : 'rgba(16,24,40,0.55)' }}>{meta.description}</div>
                          {conflictInfo && (
                              <div style={{ fontSize: 11, color: darkMode ? '#faad14' : '#d48806', marginTop: 2 }}>
                                  {conflictInfo.hasMonaco && (
                                      <>⚠ {t('app.shortcuts.message.reserved_conflict_info', { labels: conflictInfo.monacoLabels })}</>
                                   )}
                                   {conflictInfo.hasOther && (
                                      <>⚠ {t('app.shortcuts.message.reserved_conflict_warning', { contexts: conflictInfo.otherContexts, labels: conflictInfo.otherLabels })}</>
                                   )}
                              </div>
                          )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Input
                              readOnly
                              value={isCapturing ? t('app.shortcuts.capture_waiting') : getShortcutDisplayLabel(binding.combo, activeShortcutPlatform)}
                              style={{ width: 180, fontFamily: resolvedMonoFontFamily }}
                          />
                          <Button
                              size="small"
                              onClick={() => setCapturingShortcutAction((prev) => (prev === action ? null : action))}
                          >
                              {isCapturing ? t('common.cancel') : t('app.shortcuts.action.record')}
                          </Button>
                          <Switch
                              checked={binding.enabled}
                              onChange={(checked) => updateShortcut(action, { enabled: checked }, activeShortcutPlatform)}
                          />
                      </div>
                  </div>
              );
            })}
          </div>
        </Modal>
      );
    }

    return null;
  };
  return { renderToolCenterPane };
};
