import {
  HddOutlined,
  DownloadOutlined,
  SyncOutlined,
  SkinOutlined,
  BgColorsOutlined,
  AppstoreOutlined,
  GlobalOutlined,
} from '@ant-design/icons';
import { Button } from 'antd';
import React from 'react';
import Modal from '../../components/common/ResizableDraggableModal';
import SecurityUpdateIntroModal from '../../components/SecurityUpdateIntroModal';
import SecurityUpdateProgressModal from '../../components/SecurityUpdateProgressModal';
import ConnectionPackagePasswordModal from '../../components/ConnectionPackagePasswordModal';
import { isConnectionPackageSettingsPaneKey } from '../settingsCenterPanes';
import UpdateReleaseNotesModal from '../../components/UpdateReleaseNotesModal';
import { BrowserOpenURL } from '../../../wailsjs/runtime';
import type { AppProxySettingsApi } from '../hooks/useAppProxySettings';
import type { AppSecurityUpdateApi } from '../hooks/useAppSecurityUpdate';
import type { AppCoreStateApi } from '../hooks/useAppCoreState';
import type { AppSettingsNavigationApi } from '../hooks/useAppSettingsNavigation';
import type { AppDirectorySettingsRenderApi } from '../hooks/useAppDirectorySettingsRender';
import type { AppShellStateApi } from '../hooks/useAppShellState';
import type { AppQuitAndUpdateApi } from '../hooks/useAppQuitAndUpdate';
import type { AppConnectionImportExportApi } from '../hooks/useAppConnectionImportExport';
import type { AppUpdateAndDiagnosticsApi } from '../hooks/useAppUpdateAndDiagnostics';
import type { AppSettingsPanesRenderApi } from '../hooks/useAppSettingsPanesRender';
import type { AppThemeSettingsRenderApi } from '../hooks/useAppThemeSettingsRender';
import type { AppWorkbenchActionsApi } from '../hooks/useAppWorkbenchActions';

export interface AppGlobalDialogsProps {
  isDataRootModalOpen: AppProxySettingsApi['isDataRootModalOpen'];
  renderUtilityModalTitle: AppSecurityUpdateApi['renderUtilityModalTitle'];
  t: AppCoreStateApi['t'];
  setIsDataRootModalOpen: AppProxySettingsApi['setIsDataRootModalOpen'];
  setToolCenterBackGroupKey: AppProxySettingsApi['setToolCenterBackGroupKey'];
  toolCenterBackGroupKey: AppProxySettingsApi['toolCenterBackGroupKey'];
  handleReturnToToolCenter: AppSettingsNavigationApi['handleReturnToToolCenter'];
  utilityModalShellStyle: AppSecurityUpdateApi['utilityModalShellStyle'];
  renderDataDirectorySettings: AppDirectorySettingsRenderApi['renderDataDirectorySettings'];
  isSecurityUpdateIntroOpen: AppShellStateApi['isSecurityUpdateIntroOpen'];
  isSecurityUpdateProgressOpen: AppShellStateApi['isSecurityUpdateProgressOpen'];
  darkMode: AppCoreStateApi['darkMode'];
  overlayTheme: AppSecurityUpdateApi['overlayTheme'];
  effectiveOpacity: AppShellStateApi['effectiveOpacity'];
  handleStartSecurityUpdate: AppSecurityUpdateApi['handleStartSecurityUpdate'];
  handlePostponeSecurityUpdate: AppSecurityUpdateApi['handlePostponeSecurityUpdate'];
  handleOpenSecurityUpdateSettings: AppSecurityUpdateApi['handleOpenSecurityUpdateSettings'];
  settingsChildModalZIndex: AppShellStateApi['settingsChildModalZIndex'];
  securityUpdateProgressStage: AppShellStateApi['securityUpdateProgressStage'];
  connectionPackageDialog: AppShellStateApi['connectionPackageDialog'];
  isSettingsModalOpen: AppShellStateApi['isSettingsModalOpen'];
  activeSettingsCenterPane: AppShellStateApi['activeSettingsCenterPane'];
  connections: AppSecurityUpdateApi['connections'];
  setConnectionPackageDialog: AppShellStateApi['setConnectionPackageDialog'];
  closeConnectionPackageDialog: AppQuitAndUpdateApi['closeConnectionPackageDialog'];
  handleConfirmConnectionPackageDialog: AppConnectionImportExportApi['handleConfirmConnectionPackageDialog'];
  releaseNotesModalVisible: AppUpdateAndDiagnosticsApi['releaseNotesModalVisible'];
  closeReleaseNotesModal: AppUpdateAndDiagnosticsApi['closeReleaseNotesModal'];
  handleReleaseNotesModalOpen: AppUpdateAndDiagnosticsApi['handleReleaseNotesModalOpen'];
  lastUpdateInfo: AppUpdateAndDiagnosticsApi['lastUpdateInfo'];
  updateDownloadProgress: AppUpdateAndDiagnosticsApi['updateDownloadProgress'];
  aboutInfo: AppUpdateAndDiagnosticsApi['aboutInfo'];
  formatBytes: AppUpdateAndDiagnosticsApi['formatBytes'];
  updateInstallAction: AppUpdateAndDiagnosticsApi['updateInstallAction'];
  markUpdateProgressDismissed: AppUpdateAndDiagnosticsApi['markUpdateProgressDismissed'];
  isLatestUpdateDownloaded: AppUpdateAndDiagnosticsApi['isLatestUpdateDownloaded'];
  handleDownloadUpdateWithNotes: AppUpdateAndDiagnosticsApi['handleDownloadUpdateWithNotes'];
  updateDownloadActionLabel: AppSettingsPanesRenderApi['updateDownloadActionLabel'];
  openDownloadedUpdateDirectory: AppUpdateAndDiagnosticsApi['openDownloadedUpdateDirectory'];
  handleInstallUpdateRequest: AppQuitAndUpdateApi['handleInstallUpdateRequest'];
  updateInstallActionLabel: AppSettingsPanesRenderApi['updateInstallActionLabel'];
  isThemeModalOpen: AppProxySettingsApi['isThemeModalOpen'];
  themeModalSection: AppProxySettingsApi['themeModalSection'];
  setIsThemeModalOpen: AppProxySettingsApi['setIsThemeModalOpen'];
  renderThemeSettingsContent: AppThemeSettingsRenderApi['renderThemeSettingsContent'];
  isProxyModalOpen: AppProxySettingsApi['isProxyModalOpen'];
  handleCloseGlobalProxySettings: AppWorkbenchActionsApi['handleCloseGlobalProxySettings'];
  renderProxySettingsContent: AppSettingsPanesRenderApi['renderProxySettingsContent'];
}

export const AppGlobalDialogs = ({
  isDataRootModalOpen, renderUtilityModalTitle, t, setIsDataRootModalOpen,
  setToolCenterBackGroupKey, toolCenterBackGroupKey, handleReturnToToolCenter,
  utilityModalShellStyle, renderDataDirectorySettings, isSecurityUpdateIntroOpen,
  isSecurityUpdateProgressOpen, darkMode, overlayTheme, effectiveOpacity, handleStartSecurityUpdate,
  handlePostponeSecurityUpdate, handleOpenSecurityUpdateSettings, settingsChildModalZIndex,
  securityUpdateProgressStage, connectionPackageDialog, isSettingsModalOpen,
  activeSettingsCenterPane, connections, setConnectionPackageDialog, closeConnectionPackageDialog,
  handleConfirmConnectionPackageDialog, releaseNotesModalVisible, closeReleaseNotesModal,
  handleReleaseNotesModalOpen, lastUpdateInfo, updateDownloadProgress, aboutInfo, formatBytes,
  updateInstallAction, markUpdateProgressDismissed, isLatestUpdateDownloaded,
  handleDownloadUpdateWithNotes, updateDownloadActionLabel, openDownloadedUpdateDirectory,
  handleInstallUpdateRequest, updateInstallActionLabel, isThemeModalOpen, themeModalSection,
  setIsThemeModalOpen, renderThemeSettingsContent, isProxyModalOpen, handleCloseGlobalProxySettings,
  renderProxySettingsContent,
}: AppGlobalDialogsProps) => (
  <>
    {isDataRootModalOpen && (
    <Modal
      title={renderUtilityModalTitle(
        <HddOutlined />,
        t('app.data_root.title'),
        t('app.data_root.description'),
      )}
      open={isDataRootModalOpen}
      onCancel={() => {
        setIsDataRootModalOpen(false);
        setToolCenterBackGroupKey(null);
      }}
      footer={[
        <Button
          key="close"
          onClick={() => {
            setIsDataRootModalOpen(false);
            setToolCenterBackGroupKey(null);
          }}
        >
          {t('common.close')}
        </Button>,
        toolCenterBackGroupKey === 'config' ? (
          <Button
            key="back"
            onClick={() => handleReturnToToolCenter(() => setIsDataRootModalOpen(false))}
          >
            {t('common.back_to_previous')}
          </Button>
        ) : null,
      ]}
      width={720}
      styles={{ content: utilityModalShellStyle, header: { background: 'transparent', borderBottom: 'none', paddingBottom: 8 }, body: { paddingTop: 8 }, footer: { background: 'transparent', borderTop: 'none', paddingTop: 10 } }}
    >
      {renderDataDirectorySettings()}
    </Modal>
    )}
    <SecurityUpdateIntroModal
      open={isSecurityUpdateIntroOpen}
      loading={isSecurityUpdateProgressOpen}
      darkMode={darkMode}
      overlayTheme={overlayTheme}
      surfaceOpacity={effectiveOpacity}
      onStart={handleStartSecurityUpdate}
      onPostpone={handlePostponeSecurityUpdate}
      onViewDetails={() => handleOpenSecurityUpdateSettings()}
    />
    <SecurityUpdateProgressModal
      open={isSecurityUpdateProgressOpen}
      zIndex={settingsChildModalZIndex}
      stageText={securityUpdateProgressStage}
      overlayTheme={overlayTheme}
      surfaceOpacity={effectiveOpacity}
    />
    <ConnectionPackagePasswordModal
      open={connectionPackageDialog.open && !(isSettingsModalOpen && isConnectionPackageSettingsPaneKey(activeSettingsCenterPane?.key))}
      title={connectionPackageDialog.mode === 'export'
          ? t('app.connection_package.dialog.export_title')
          : t('app.connection_package.dialog.import_password_title')}
      mode={connectionPackageDialog.mode}
      includeSecrets={connectionPackageDialog.includeSecrets}
      useFilePassword={connectionPackageDialog.useFilePassword}
      password={connectionPackageDialog.password}
      error={connectionPackageDialog.error}
      confirmLoading={connectionPackageDialog.confirmLoading}
      connectionOptions={connections.map((item) => ({ value: item.id, label: item.name || item.id }))}
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
      onBack={toolCenterBackGroupKey === 'config' ? () => handleReturnToToolCenter(closeConnectionPackageDialog) : undefined}
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
    <UpdateReleaseNotesModal
        open={releaseNotesModalVisible}
        onClose={closeReleaseNotesModal}
        onOpen={handleReleaseNotesModalOpen}
        darkMode={darkMode}
        version={lastUpdateInfo?.latestVersion || updateDownloadProgress.version}
        channel={lastUpdateInfo?.channel}
        releaseName={lastUpdateInfo?.releaseName}
        releasePublishedAt={lastUpdateInfo?.releasePublishedAt}
        releaseNotes={lastUpdateInfo?.releaseNotes}
        releaseNotesUrl={lastUpdateInfo?.releaseNotesUrl || aboutInfo?.releaseUrl}
        zIndex={settingsChildModalZIndex}
        downloadProgress={
            updateDownloadProgress.status === 'idle'
                ? null
                : {
                    status: updateDownloadProgress.status,
                    percent: updateDownloadProgress.percent,
                    downloaded: updateDownloadProgress.downloaded,
                    total: updateDownloadProgress.total,
                    message: updateDownloadProgress.message,
                }
        }
        formatBytes={formatBytes}
        progressHint={
            updateInstallAction === 'restart'
                ? t('app.about.download_progress.complete_hint')
                : t('app.about.download_progress.installer_complete_hint')
        }
        footerActions={[
            lastUpdateInfo?.releaseNotesUrl || aboutInfo?.releaseUrl ? (
                <Button
                    key="github"
                    onClick={() => {
                        const url = lastUpdateInfo?.releaseNotesUrl || aboutInfo?.releaseUrl;
                        if (!url) return;
                        try { BrowserOpenURL(url); } catch { window.open(url, '_blank', 'noopener,noreferrer'); }
                    }}
                >
                    {t('app.about.release_notes.modal.open_github')}
                </Button>
            ) : null,
            (updateDownloadProgress.status === 'start' || updateDownloadProgress.status === 'downloading') ? (
                <Button
                    key="background"
                    onClick={() => {
                        markUpdateProgressDismissed();
                        closeReleaseNotesModal();
                    }}
                >
                    {t('app.about.action.hide_to_background')}
                </Button>
            ) : null,
            lastUpdateInfo?.hasUpdate
                && !isLatestUpdateDownloaded
                && updateDownloadProgress.status !== 'start'
                && updateDownloadProgress.status !== 'downloading' ? (
                <Button
                    key="download"
                    type="primary"
                    icon={<DownloadOutlined />}
                    onClick={handleDownloadUpdateWithNotes}
                >
                    {updateDownloadActionLabel}
                </Button>
            ) : null,
            isLatestUpdateDownloaded || updateDownloadProgress.status === 'done' ? (
                <Button key="open-install-directory" onClick={openDownloadedUpdateDirectory}>
                    {t('app.about.action.open_install_directory')}
                </Button>
            ) : null,
            isLatestUpdateDownloaded || updateDownloadProgress.status === 'done' ? (
                <Button
                    key="restart"
                    type="primary"
                    icon={<SyncOutlined />}
                    onClick={() => { void handleInstallUpdateRequest(); }}
                >
                    {updateInstallActionLabel}
                </Button>
            ) : null,
            (updateDownloadProgress.status !== 'start' && updateDownloadProgress.status !== 'downloading') ? (
                <Button key="close" onClick={closeReleaseNotesModal}>
                    {t('common.close')}
                </Button>
            ) : null,
        ].filter(Boolean) as React.ReactNode[]}
    />

    {isThemeModalOpen && (
    <Modal
        title={renderUtilityModalTitle(
            themeModalSection === 'theme'
                ? <SkinOutlined />
                : themeModalSection === 'appearance'
                    ? <BgColorsOutlined />
                    : <AppstoreOutlined />,
            themeModalSection === 'theme'
                ? t('app.theme.theme_settings_title')
                : themeModalSection === 'appearance'
                    ? t('app.theme.appearance_settings_title')
                    : t('app.theme.workspace_settings_title'),
            themeModalSection === 'theme'
                ? t('app.theme.theme_settings_description')
                : themeModalSection === 'appearance'
                    ? t('app.theme.appearance_settings_description')
                    : t('app.theme.workspace_settings_description')
        )}
        open={isThemeModalOpen}
        onCancel={() => { setIsThemeModalOpen(false); }}
        footer={null}
        width={820}
        styles={{ content: utilityModalShellStyle, header: { background: 'transparent', borderBottom: 'none', paddingBottom: 8 }, body: { paddingTop: 8, height: 620, overflow: 'hidden' }, footer: { background: 'transparent', borderTop: 'none', paddingTop: 10 } }}
    >
        {renderThemeSettingsContent()}
    </Modal>
    )}

    {isProxyModalOpen && (
    <Modal
        title={renderUtilityModalTitle(<GlobalOutlined />, t('app.proxy.title'), t('app.proxy.description'))}
        open={isProxyModalOpen}
        zIndex={settingsChildModalZIndex}
        onCancel={handleCloseGlobalProxySettings}
        footer={null}
        width={680}
        styles={{ content: utilityModalShellStyle, header: { background: 'transparent', borderBottom: 'none', paddingBottom: 8 }, body: { paddingTop: 8 }, footer: { background: 'transparent', borderTop: 'none', paddingTop: 10 } }}
    >
        {renderProxySettingsContent()}
    </Modal>
    )}
  </>
);
