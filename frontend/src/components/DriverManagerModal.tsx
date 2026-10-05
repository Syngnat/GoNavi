import Modal from './common/ResizableDraggableModal';
import React from 'react';
import { Alert, Button, Collapse, Space, Tooltip, message } from 'antd';
import { DownloadOutlined, ImportOutlined, ReloadOutlined } from '@ant-design/icons';
import { t } from '../i18n';
import type { DownloadSourceId } from '../utils/driverManagerTab';
import DownloadSourceSelect from './DownloadSourceSelect';
import DriverPackageExportPicker from './driverManager/DriverPackageExportPicker';
import DriverPackageImportModal from './driverManager/DriverPackageImportModal';
import { DriverBatchProgressBar } from './driverManager/DriverBatchProgressBar';
import DriverPackageExportProgress from './driverManager/DriverPackageExportProgress';
import { dismissDriverNetworkNotice } from './driverManager/driverNetworkNoticeState';
import {
  getDriverLocalImportDirectoryHelp,
  getDriverLocalImportSingleFileHelp,
} from '../utils/driverImportGuidance';
import {
  Text,
  Paragraph,
  sharedInfoAlertIcon,
} from './driverManager/driverManagerModel';
import { resolveDriverErrorMessageText } from './driverManager/driverManagerMessages';
import { useDriverManagerState } from './driverManager/useDriverManagerState';
import { useDriverManagerProgress } from './driverManager/useDriverManagerProgress';
import { useDriverManagerStatusLoading } from './driverManager/useDriverManagerStatusLoading';
import { useDriverManagerInstall } from './driverManager/useDriverManagerInstall';
import { useDriverManagerRemoval } from './driverManager/useDriverManagerRemoval';
import { useDriverManagerRowControls } from './driverManager/useDriverManagerRowControls';
import { useDriverManagerRows } from './driverManager/useDriverManagerRows';
import { useDriverManagerBatch } from './driverManager/useDriverManagerBatch';
import { useDriverManagerDetailView } from './driverManager/useDriverManagerDetailView';
import { buildDriverManagerNetworkSummary } from './driverManager/driverManagerNetworkSummary';
import { DriverManagerNetworkNotice } from './driverManager/DriverManagerNetworkNotice';
import { DriverManagerBulkBar } from './driverManager/DriverManagerBulkBar';
import { DriverManagerColumns } from './driverManager/DriverManagerColumns';
export { resolveDriverErrorMessageText } from './driverManager/driverManagerMessages';

export interface DriverManagerModalProps {
  open: boolean;
  onClose: () => void;
  onBack?: () => void;
  onOpenGlobalProxySettings?: () => void;
  /** 选定某个镜像源；由调用方负责持久化。 */
  onChangeDownloadSource?: (source: DownloadSourceId) => void;
  downloadSourceSwitching?: boolean;
  downloadSource?: string;
  embedded?: boolean;
}

const DriverManagerModal: React.FC<DriverManagerModalProps> = ({
  open,
  onClose,
  onBack,
  onOpenGlobalProxySettings,
  onChangeDownloadSource,
  downloadSourceSwitching = false,
  downloadSource,
  embedded = false,
}) => {
  const {
    darkMode,
    driverManagerTheme,
    loading,
    setLoading,
    downloadDir,
    setDownloadDir,
    networkChecking,
    setNetworkChecking,
    networkStatus,
    setNetworkStatus,
    searchKeyword,
    setSearchKeyword,
    rows,
    setRows,
    actionState,
    setActionState,
    batchAction,
    setBatchAction,
    batchProgress,
    setBatchProgress,
    progressMap,
    operationLogMap,
    setOperationLogMap,
    batchDirectoryImporting,
    setBatchDirectoryImporting,
    versionMap,
    setVersionMap,
    selectedVersionMap,
    setSelectedVersionMap,
    versionLoadingMap,
    setVersionLoadingMap,
    versionSizeLoadingMap,
    setVersionSizeLoadingMap,
    optionalUpdateDismissedRevisions,
    setOptionalUpdateDismissedRevisions,
    dismissedNetworkNotices,
    setDismissedNetworkNotices,
    driverFilter,
    setDriverFilter,
    driverSortKey,
    setDriverSortKey,
    selectedDriverType,
    setSelectedDriverType,
    downloadDirRef,
    progressMapRef,
    progressTaskIdMapRef,
    tasklessProgressOwnerRef,
    cancelIntentsRef,
    versionLoadPromiseMapRef,
    statusRequestGenerationRef,
    networkRequestGenerationRef,
    batchBusy,
    driverMutationBusy,
    canRunDriverDownloadInBackground,
    resolveDriverErrorMessage,
    updateDriverProgress,
    clearDriverDownloadTaskId,
    clearDriverProgress,
    modalBodyStyle,
  } = useDriverManagerState({ open });

  const {
    appendOperationLog,
    applyTaskScopedDriverProgress,
    applyDriverDownloadTaskSnapshot,
    refreshDriverDownloadTasks,
    batchCancellation,
    cancelIntents,
    installSessions,
    cancelDriverDownload,
    cancelDriverDownloadTask,
    cancelAllDriverDownloads,
  } = useDriverManagerProgress({
    setOperationLogMap,
    progressMapRef,
    cancelIntentsRef,
    progressTaskIdMapRef,
    updateDriverProgress,
    resolveDriverErrorMessage,
    setActionState,
  });

  const {
    refreshStatus,
    checkNetworkStatus,
    loadVersionOptions,
    loadVersionPackageSize,
  } = useDriverManagerStatusLoading({
    statusRequestGenerationRef,
    downloadDirRef,
    setLoading,
    resolveDriverErrorMessage,
    setDownloadDir,
    setRows,
    networkRequestGenerationRef,
    setNetworkChecking,
    setNetworkStatus,
    versionLoadPromiseMapRef,
    setVersionLoadingMap,
    setVersionMap,
    setSelectedVersionMap,
    versionMap,
    versionSizeLoadingMap,
    setVersionSizeLoadingMap,
    open,
    refreshDriverDownloadTasks,
    cancelIntentsRef,
    tasklessProgressOwnerRef,
    applyTaskScopedDriverProgress,
    updateDriverProgress,
    appendOperationLog,
  });

  const {
    resolveSelectedVersionOption,
    resolveInstalledDriverVersion,
    isDriverVersionSwitchPending,
    installDriver,
    runAfterDriverInterruptionConfirmation,
    requestInstallDriver,
    requestInstallDriverFromLocalFile,
    requestInstallDriversFromDirectory,
    cancelBatchDirectoryImport,
    batchDirectoryImportProgress,
    driverPackageExporting,
    driverPackageExportJobId,
    driverPackageInspecting,
    driverPackageImporting,
    driverPackageImportProgress,
    driverPackagePending,
    driverPackageForceOverwrite,
    setDriverPackageForceOverwrite,
    installedDriverCount,
    driverPackageExportPickerOpen,
    driverPackageExportDrivers,
    closeDriverPackageExportPicker,
    confirmDriverPackageExport,
    requestExportDriverPackage,
    requestImportDriverPackage,
    confirmImportDriverPackage,
    cancelDriverPackageImport,
    closeDriverPackageImportModal,
    driverBatchOperationBusy,
    isDriverRowActionDisabled,
    packageTransferDisabled,
    packageTransferDisabledReason,
  } = useDriverManagerInstall({
    versionMap,
    selectedVersionMap,
    installSessions,
    cancelIntents,
    batchCancellation,
    cancelDriverDownloadTask,
    setActionState,
    clearDriverDownloadTaskId,
    updateDriverProgress,
    loadVersionOptions,
    downloadDir,
    resolveDriverErrorMessage,
    appendOperationLog,
    applyDriverDownloadTaskSnapshot,
    clearDriverProgress,
    refreshStatus,
    rows,
    tasklessProgressOwnerRef,
    setBatchDirectoryImporting,
    driverMutationBusy,
    batchDirectoryImporting,
    batchBusy,
    actionState,
  });

  const {
    openDriverDirectory,
    removeDriver,
    confirmRemoveDriver,
    resolvePackageSizeText,
    resolveDriverStatusTag,
    resolveDriverProgress,
  } = useDriverManagerRemoval({
    downloadDir,
    resolveDriverErrorMessage,
    setActionState,
    appendOperationLog,
    clearDriverProgress,
    refreshStatus,
    versionMap,
    selectedVersionMap,
    versionSizeLoadingMap,
    progressMap,
    optionalUpdateDismissedRevisions,
  });

  const { renderVersionControl, renderDriverActions } = useDriverManagerRowControls({
    versionMap,
    selectedVersionMap,
    setSelectedVersionMap,
    resolveInstalledDriverVersion,
    isDriverVersionSwitchPending,
    resolveSelectedVersionOption,
    versionLoadingMap,
    isDriverRowActionDisabled,
    loadVersionOptions,
    loadVersionPackageSize,
    embedded,
    actionState,
    optionalUpdateDismissedRevisions,
    setOptionalUpdateDismissedRevisions,
    requestInstallDriver,
    confirmRemoveDriver,
    installDriver,
    requestInstallDriverFromLocalFile,
  });

  const {
    normalizedSearchKeyword,
    visibleRows,
    selectedRow,
    initialStatusLoading,
    statusSummary,
    reinstallableRows,
    installableRows,
    removableRows,
    batchProgressPercent,
    batchProgressMessage,
  } = useDriverManagerRows({
    searchKeyword,
    rows,
    optionalUpdateDismissedRevisions,
    driverFilter,
    driverSortKey,
    selectedDriverType,
    loading,
    batchProgress,
    progressMap,
    batchAction,
  });

  const {
    cancelBatchDownloads,
    reinstallNeededDrivers,
    installAllDrivers,
    removeAllDrivers,
    resolveDriverListTone,
  } = useDriverManagerBatch({
    progressMapRef,
    setBatchAction,
    setBatchProgress,
    batchCancellation,
    appendOperationLog,
    installDriver,
    refreshStatus,
    cancelAllDriverDownloads,
    rows,
    runAfterDriverInterruptionConfirmation,
    reinstallableRows,
    installableRows,
    removableRows,
    removeDriver,
    progressMap,
    optionalUpdateDismissedRevisions,
  });

  const { renderDriverListItem, renderDriverDetail, renderDriverLogSection } = useDriverManagerDetailView({
    selectedRow,
    progressMap,
    resolveDriverProgress,
    resolvePackageSizeText,
    setSelectedDriverType,
    resolveDriverListTone,
    embedded,
    optionalUpdateDismissedRevisions,
    resolveDriverStatusTag,
    cancelDriverDownload,
    isDriverVersionSwitchPending,
    requestInstallDriver,
    renderDriverActions,
    renderVersionControl,
    operationLogMap,
  });

  const {
    downloadSourceMeta,
    proxyEnvEntries,
    showDownloadChainAlert,
    networkUnreachable,
    usingFallback,
    listSeparator,
    downloadRequiredHostText,
    networkSummaryText,
    networkDotTone,
    networkPillText,
    networkTooltipTitle,
  } = buildDriverManagerNetworkSummary({ downloadSource, networkStatus, networkChecking });

  const driverManagerContent = (
    <>
      <div
        className={embedded ? 'driver-manager-embedded-layout' : undefined}
        style={embedded ? undefined : { display: 'contents' }}
      >
        <div className={`driver-manager-shell${embedded ? ' is-embedded' : ''}`} data-driver-theme={driverManagerTheme.isDark ? 'dark' : 'light'}>
        {!embedded ? (
          <div className="driver-manager-page-sub">
            {t('driver.modal.header.description.install')}
            <span className="driver-manager-hero-subtitle-sep"> · </span>
            {t('driver.modal.header.description.agent')}
          </div>
        ) : null}

        {(!embedded || (networkStatus && (networkUnreachable || usingFallback)))
          && !dismissedNetworkNotices.includes(networkUnreachable ? 'unreachable' : 'fallback') ? (
          networkStatus ? (
            networkUnreachable ? (
            <Alert
              className="driver-manager-network-notice"
              type="error"
              showIcon
              closable
              onClose={() => setDismissedNetworkNotices((prev) => dismissDriverNetworkNotice(prev, 'unreachable'))}
              message={showDownloadChainAlert
                ? t('driver_manager.network.alert.download_chain_unreachable')
                : t('driver_manager.network.alert.download_network_unreachable')}
              description={(
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {showDownloadChainAlert ? (
                    <>
                      <Text>{t('driver_manager.network.chain_alert.description')}</Text>
                      {onOpenGlobalProxySettings ? (
                        <Button size="small" onClick={onOpenGlobalProxySettings}>{t('driver_manager.action.open_global_proxy_settings')}</Button>
                      ) : null}
                      <Text>{t('driver_manager.network.chain_alert.allow_hosts', { hosts: downloadRequiredHostText })}</Text>
                    </>
                  ) : (
                    <Text>{networkSummaryText}</Text>
                  )}
                  {proxyEnvEntries.length > 0 ? (
                    <Text type="secondary">
                      {t('driver_manager.network.proxy_env_detected', { keys: proxyEnvEntries.map(([key]) => key).join(listSeparator) })}
                    </Text>
                  ) : null}
                </Space>
              )}
            />
          ) : (
            <DriverManagerNetworkNotice
              usingFallback={usingFallback}
              setDismissedNetworkNotices={setDismissedNetworkNotices}
              networkSummaryText={networkSummaryText}
              networkStatus={networkStatus}
              proxyEnvEntries={proxyEnvEntries}
              listSeparator={listSeparator}
            />
          )
        ) : (
          <Alert
            className="driver-manager-network-notice"
            type="info"
            showIcon
            icon={sharedInfoAlertIcon}
            message={networkChecking ? t('driver_manager.network.checking') : t('driver_manager.network.not_checked')}
          />
          )
        ) : null}

        {!embedded && onChangeDownloadSource ? (
          <div
            className="driver-manager-mirror-chip"
            data-download-source={downloadSource}
          >
            <div className="driver-manager-mirror-chip-copy">
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: darkMode ? downloadSourceMeta.darkDot : downloadSourceMeta.lightDot,
                  flexShrink: 0,
                }}
              />
              <span className="driver-manager-mirror-chip-label" style={{ color: driverManagerTheme.mutedText, fontSize: 13 }}>
                {t('driver_manager.mirror_source.label')}
              </span>
            </div>
            <DownloadSourceSelect
              value={downloadSource}
              darkMode={darkMode}
              saving={downloadSourceSwitching}
              onChange={onChangeDownloadSource}
              size="small"
              borderless
              style={{ minWidth: 180 }}
            />
          </div>
        ) : null}

        {!embedded ? (
        <div className="driver-manager-directory-panel">
          <Collapse
            size="small"
            ghost
            items={[
              {
                key: 'driver-directory',
                label: t('driver_manager.directory_info.title'),
                children: (
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    <Text type="secondary">{t('driver_manager.directory_info.reuse_help')}</Text>
                    <Text type="secondary">{getDriverLocalImportDirectoryHelp()}</Text>
                    <Text type="secondary">{getDriverLocalImportSingleFileHelp()}</Text>
                    <Paragraph copyable={{ text: downloadDir || '-' }} style={{ marginBottom: 0 }}>
                      {t('driver_manager.directory_info.root_dir', { path: downloadDir || '-' })}
                    </Paragraph>
                    {networkStatus?.logPath ? (
                      <Paragraph copyable={{ text: networkStatus.logPath }} style={{ marginBottom: 0 }}>
                        {t('driver_manager.directory_info.log_file', { path: networkStatus.logPath })}
                      </Paragraph>
                    ) : null}
                  </Space>
                ),
              },
            ]}
          />
        </div>
        ) : null}

        <DriverManagerBulkBar
          embedded={embedded}
          driverBatchOperationBusy={driverBatchOperationBusy}
          initialStatusLoading={initialStatusLoading}
          installableRows={installableRows}
          batchAction={batchAction}
          installAllDrivers={installAllDrivers}
          reinstallableRows={reinstallableRows}
          reinstallNeededDrivers={reinstallNeededDrivers}
          removableRows={removableRows}
          removeAllDrivers={removeAllDrivers}
          openDriverDirectory={openDriverDirectory}
          batchDirectoryImporting={batchDirectoryImporting}
          requestInstallDriversFromDirectory={requestInstallDriversFromDirectory}
          packageTransferDisabledReason={packageTransferDisabledReason}
          driverPackageExporting={driverPackageExporting}
          packageTransferDisabled={packageTransferDisabled}
          installedDriverCount={installedDriverCount}
          requestExportDriverPackage={requestExportDriverPackage}
          driverPackageInspecting={driverPackageInspecting}
          requestImportDriverPackage={requestImportDriverPackage}
        />
        {batchProgress ? (
          <DriverBatchProgressBar
            icon={<DownloadOutlined />}
            title={t('driver.modal.batch.compactTitle', { completed: batchProgress.completed, total: batchProgress.total })}
            description={batchProgress.currentDriverName
              ? `${batchProgress.currentDriverName} · ${batchProgressMessage || t('driver.modal.batch.running')}`
              : (batchProgressMessage || t('driver.modal.batch.running'))}
            percent={batchProgressPercent}
            detailLabel={t('driver.modal.batch.detail')}
            details={[
              <Text key="processed" type="secondary">{t('driver.modal.batch.processed', { completed: batchProgress.completed, total: batchProgress.total })}</Text>,
              <Text key="success" type="secondary">{t('driver.modal.batch.success', { count: batchProgress.success })}</Text>,
              batchProgress.failed > 0 ? <Text key="failed" type="danger">{t('driver.modal.batch.failed', { count: batchProgress.failed })}</Text> : null,
              batchProgress.skipped > 0 ? <Text key="skipped" type="secondary">{t('driver.modal.batch.skipped', { count: batchProgress.skipped })}</Text> : null,
            ].filter(Boolean)}
            actions={(
              <Button
                size="small"
                danger
                ghost
                onClick={cancelBatchDownloads}
              >
                {t('driver.modal.batch.cancelAll')}
              </Button>
            )}
          />
        ) : null}
        <DriverPackageExportProgress jobId={driverPackageExportJobId} />
        {batchDirectoryImportProgress ? (
          <DriverBatchProgressBar
            icon={<ImportOutlined />}
            title={t('driver.modal.batch.compactTitle', {
              completed: batchDirectoryImportProgress.completed,
              total: batchDirectoryImportProgress.total,
            })}
            description={batchDirectoryImportProgress.currentName
              ? `${batchDirectoryImportProgress.currentName} · ${t('driver.modal.batch.running')}`
              : t('driver.modal.batch.running')}
            percent={batchDirectoryImportProgress.total > 0
              ? (batchDirectoryImportProgress.completed / batchDirectoryImportProgress.total) * 100
              : 0}
            actions={(
              <Button size="small" danger ghost onClick={cancelBatchDirectoryImport}>
                {t('driver.modal.batch.cancelAll')}
              </Button>
            )}
          />
        ) : null}
        <DriverManagerColumns
          embedded={embedded}
          refreshStatus={refreshStatus}
          loading={loading}
          networkTooltipTitle={networkTooltipTitle}
          networkDotTone={networkDotTone}
          checkNetworkStatus={checkNetworkStatus}
          networkChecking={networkChecking}
          onChangeDownloadSource={onChangeDownloadSource}
          downloadSource={downloadSource}
          darkMode={darkMode}
          downloadSourceMeta={downloadSourceMeta}
          driverManagerTheme={driverManagerTheme}
          downloadSourceSwitching={downloadSourceSwitching}
          statusSummary={statusSummary}
          driverFilter={driverFilter}
          setDriverFilter={setDriverFilter}
          searchKeyword={searchKeyword}
          setSearchKeyword={setSearchKeyword}
          driverSortKey={driverSortKey}
          setDriverSortKey={setDriverSortKey}
          initialStatusLoading={initialStatusLoading}
          visibleRows={visibleRows}
          renderDriverListItem={renderDriverListItem}
          selectedRow={selectedRow}
          renderDriverDetail={renderDriverDetail}
          normalizedSearchKeyword={normalizedSearchKeyword}
          renderDriverLogSection={renderDriverLogSection}
        />
        </div>
        {embedded && onBack ? (
          <div className="driver-manager-footer-actions">
            <Button key="back" onClick={onBack}>
              {t('common.back_to_settings')}
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );

  // 驱动包导入确认弹窗必须挂在两支上：embedded（设置中心内嵌页）此前只返回
  // driverManagerContent，弹窗不在其中 —— 选完 ZIP 后 setPendingPackage 正常执行，
  // 但弹窗永远不会挂载，表现为「点了导入没有任何反应」。
  const driverPackageExportPicker = (
    <DriverPackageExportPicker
      open={driverPackageExportPickerOpen}
      drivers={driverPackageExportDrivers}
      onCancel={closeDriverPackageExportPicker}
      onConfirm={(driverTypes) => { void confirmDriverPackageExport(driverTypes); }}
    />
  );

  const driverPackageImportModal = (
    <DriverPackageImportModal
      open={driverPackagePending !== null}
      importing={driverPackageImporting}
      progress={driverPackageImportProgress ? (
        <DriverBatchProgressBar
          icon={<ImportOutlined />}
          title={t('driver.modal.batch.compactTitle', {
            completed: driverPackageImportProgress.completed,
            total: driverPackageImportProgress.total,
          })}
          description={driverPackageImportProgress.currentName
            ? `${driverPackageImportProgress.currentName} · ${t('driver.modal.batch.running')}`
            : t('driver.modal.batch.running')}
          percent={driverPackageImportProgress.total > 0
            ? (driverPackageImportProgress.completed / driverPackageImportProgress.total) * 100
            : 0}
          // 取消走弹窗底部的「取消导入」：同一弹窗里再放一个同义按钮没有增益。
        />
      ) : null}
      drivers={driverPackagePending?.drivers || []}
      forceOverwrite={driverPackageForceOverwrite}
      onForceOverwriteChange={setDriverPackageForceOverwrite}
      onConfirm={() => void confirmImportDriverPackage()}
      onCancel={closeDriverPackageImportModal}
      onAbort={cancelDriverPackageImport}
    />
  );

  if (embedded) {
    return (
      <>
        {driverManagerContent}
        {driverPackageImportModal}
        {driverPackageExportPicker}
      </>
    );
  }

  return (
      <Modal
      title={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span>{t('driver.modal.title')}</span>
        </div>
      )}
      open={open}
      onCancel={onClose}
      width={1120}
      style={{ top: 24 }}
      className="driver-manager-modal"
      styles={{
        body: modalBodyStyle,
      }}
      destroyOnHidden
      footer={(
        <div className="driver-manager-footer-actions">
          <span className="driver-manager-net-status">
            <span className={`driver-manager-net-dot driver-manager-net-dot-${networkDotTone}`} aria-hidden="true" />
            <span className="driver-manager-net-text">{networkPillText}</span>
          </span>
          <span className="driver-manager-footer-buttons">
            <Button key="refresh" icon={<ReloadOutlined />} onClick={() => refreshStatus(true)} loading={loading}>
              {t('driver.modal.footer.refresh')}
            </Button>
            <Tooltip title={networkTooltipTitle} placement="topRight">
              <Button
                key="network"
                className="driver-manager-network-check-btn"
                icon={<span className={`driver-manager-net-dot driver-manager-net-dot-${networkDotTone}`} aria-hidden="true" />}
                onClick={() => checkNetworkStatus(true)}
                loading={networkChecking}
              >
                {t('driver.modal.footer.networkCheck')}
              </Button>
            </Tooltip>
            <Button key="close" type="primary" onClick={onClose}>
              {canRunDriverDownloadInBackground ? t('driver.modal.footer.background') : t('driver.modal.footer.close')}
            </Button>
            {onBack ? (
              <Button key="back" onClick={onBack}>
                {t('common.back_to_previous')}
              </Button>
            ) : null}
          </span>
        </div>
      )}
    >
      {driverManagerContent}
      {driverPackageImportModal}
      {driverPackageExportPicker}
    </Modal>
  );
};

export default DriverManagerModal;
