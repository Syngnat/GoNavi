import { Button } from 'antd';
import { isToolCenterGroupKey } from '../settingsCenterPanes';
import Modal from '../../components/common/ResizableDraggableModal';
import SecurityUpdateSettingsModal from '../../components/SecurityUpdateSettingsModal';
import DriverManagerModal from '../../components/DriverManagerModal';
import SnippetSettingsModal from '../../components/SnippetSettingsModal';
import type { RenderAppSettingsCenterModalInput } from './renderAppSettingsCenterModal';

export interface CreateToolCenterPaneRendererInput {
  activeSettingsCenterPane: RenderAppSettingsCenterModalInput['activeSettingsCenterPane'];
  utilityPanelStyle: RenderAppSettingsCenterModalInput['utilityPanelStyle'];
  utilityMutedTextStyle: RenderAppSettingsCenterModalInput['utilityMutedTextStyle'];
  t: RenderAppSettingsCenterModalInput['t'];
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
}

export const createToolCenterPaneRenderer = ({
  activeSettingsCenterPane,
  utilityPanelStyle, utilityMutedTextStyle, t, isWebRuntime,
  renderDataDirectorySettings, handleCancelSettingsCenterPane, darkMode, overlayTheme,
  effectiveOpacity, securityUpdateStatus, securityUpdateSettingsFocusTarget,
  securityUpdateSettingsFocusRequest, handleStartSecurityUpdate, handleRetrySecurityUpdate,
  handleRestartSecurityUpdate, handleSecurityUpdateIssueAction, handleOpenSettingsCenterPane,
  handleDownloadSourceChange, downloadSourceSaving, downloadSource,
}: CreateToolCenterPaneRendererInput) => {
  const renderToolCenterPane = () => {
    if (!activeSettingsCenterPane || !isToolCenterGroupKey(activeSettingsCenterPane.group)) {
      return null;
    }

    // 插件管理不在此渲染：它作为独立工作台 Tab 打开（SETTINGS_WORKBENCH_TAB_BUILDERS.plugins）。

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

    return null;
  };
  return { renderToolCenterPane };
};
