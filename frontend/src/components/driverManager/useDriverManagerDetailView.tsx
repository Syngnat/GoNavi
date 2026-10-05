import { type DriverStatusRow, Text, Paragraph } from './driverManagerModel';
import { isDriverDownloadActive } from './driverDownloadCancellation';
import { t } from '../../i18n';
import { formatDriverCardStatusMessage } from './driverManagerMessages';
import { isOptionalUpdateVisible } from './driverOptionalUpdate';
import { Button, Progress } from 'antd';
import type { DriverManagerRowsApi } from './useDriverManagerRows';
import type { DriverManagerStateApi } from './useDriverManagerState';
import type { DriverManagerRemovalApi } from './useDriverManagerRemoval';
import type { DriverManagerBatchApi } from './useDriverManagerBatch';
import type { DriverManagerProgressApi } from './useDriverManagerProgress';
import type { DriverManagerInstallApi } from './useDriverManagerInstall';
import type { DriverManagerRowControlsApi } from './useDriverManagerRowControls';
import type { DriverManagerModalProps } from '../DriverManagerModal';

export interface UseDriverManagerDetailViewInput {
  selectedRow: DriverManagerRowsApi['selectedRow'];
  progressMap: DriverManagerStateApi['progressMap'];
  resolveDriverProgress: DriverManagerRemovalApi['resolveDriverProgress'];
  resolvePackageSizeText: DriverManagerRemovalApi['resolvePackageSizeText'];
  setSelectedDriverType: DriverManagerStateApi['setSelectedDriverType'];
  resolveDriverListTone: DriverManagerBatchApi['resolveDriverListTone'];
  embedded: Exclude<DriverManagerModalProps['embedded'], undefined>;
  optionalUpdateDismissedRevisions: DriverManagerStateApi['optionalUpdateDismissedRevisions'];
  resolveDriverStatusTag: DriverManagerRemovalApi['resolveDriverStatusTag'];
  cancelDriverDownload: DriverManagerProgressApi['cancelDriverDownload'];
  isDriverVersionSwitchPending: DriverManagerInstallApi['isDriverVersionSwitchPending'];
  requestInstallDriver: DriverManagerInstallApi['requestInstallDriver'];
  renderDriverActions: DriverManagerRowControlsApi['renderDriverActions'];
  renderVersionControl: DriverManagerRowControlsApi['renderVersionControl'];
  operationLogMap: DriverManagerStateApi['operationLogMap'];
}

export const useDriverManagerDetailView = ({
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
}: UseDriverManagerDetailViewInput) => {
  const renderDriverListItem = (row: DriverStatusRow) => {
    const selected = selectedRow?.type === row.type;
    const progressState = progressMap[row.type];
    const isDownloading = isDriverDownloadActive(progressState);
    const metaText = row.builtIn
      ? t('driver.modal.card.noInstallNeeded')
      : isDownloading
        ? t('driver.modal.card.installing', { percent: resolveDriverProgress(row).percent })
        : [
          row.installedVersion || row.pinnedVersion,
          resolvePackageSizeText(row),
        ].filter((part) => String(part || '').trim() && part !== '-').join(' · ') || '-';
    return (
      <button
        key={row.type}
        type="button"
        className={`driver-manager-list-item${selected ? ' is-selected' : ''}`}
        onClick={() => setSelectedDriverType(row.type)}
        aria-current={selected ? 'true' : undefined}
      >
        <span className="driver-manager-list-item-main">
          <span className="driver-manager-list-item-name">{row.name}</span>
          <span className="driver-manager-list-item-meta">{metaText}</span>
        </span>
        <span className={`driver-manager-net-dot driver-manager-net-dot-${resolveDriverListTone(row)}`} aria-hidden="true" />
      </button>
    );
  };

  const renderDriverDetail = (row: DriverStatusRow) => {
    const progressState = progressMap[row.type];
    const progress = resolveDriverProgress(row);
    const statusMessage = formatDriverCardStatusMessage(row, optionalUpdateDismissedRevisions);
    const affectedText = row.affectedConnections && row.affectedConnections > 0
      ? t('driver.modal.card.affectedConnections', { count: row.affectedConnections })
      : '';
    const isDownloading = isDriverDownloadActive(progressState);
    const isDownloadDone = progressState?.status === 'done';
    const isDownloadError = progressState?.status === 'error';
    const isDownloadCanceled = progressState?.status === 'canceled';

    return (
      <div key={row.type} className="driver-manager-detail-body">
        <div className="driver-manager-title-row">
          <Text strong className="driver-manager-driver-name">{row.name}</Text>
          {resolveDriverStatusTag(row)}
        </div>
        {!row.builtIn || affectedText ? (
          <div className="driver-manager-meta-row">
            {!row.builtIn ? (
              <Text type="secondary">{t('driver.modal.card.packageSize', { size: resolvePackageSizeText(row) })}</Text>
            ) : null}
            {affectedText ? <Text type="secondary">{affectedText}</Text> : null}
          </div>
        ) : null}
        {(row.needsUpdate || isOptionalUpdateVisible(row, optionalUpdateDismissedRevisions)) && statusMessage ? (
          <div className="driver-manager-update-note">
            <Paragraph
              className="driver-manager-note-text"
              ellipsis={{ rows: 3, expandable: true, symbol: t('driver.modal.card.expandReason') }}
            >
              {statusMessage}
            </Paragraph>
          </div>
        ) : statusMessage && (row.connectable || row.runtimeAvailable || row.packageInstalled || String(row.message || '').trim()) ? (
          <Paragraph
            className="driver-manager-muted-message"
            type="secondary"
            ellipsis={{ rows: 3, expandable: true, symbol: t('driver.modal.card.expand') }}
          >
            {statusMessage}
          </Paragraph>
        ) : null}

        <div className="driver-manager-detail-controls">
          {isDownloading ? (
            <div className="driver-manager-control-block driver-manager-card-progress-active">
              <div className="driver-manager-progress-header">
                <Text type="secondary" className="driver-manager-control-label">
                  {t('driver_manager.progress.status.downloading')}
                </Text>
                <span className="driver-manager-progress-side">
                  <Text className="driver-manager-progress-value">{Math.round(progress.percent)}%</Text>
                  <Button
                    size="small"
                    type="text"
                    danger
                    onClick={() => { void cancelDriverDownload(row.type, row.name); }}
                  >
                    {t('common.action.cancel')}
                  </Button>
                </span>
              </div>
              <Progress
                className="driver-manager-progress driver-manager-progress-lg"
                percent={progress.percent}
                status="active"
                showInfo={false}
              />
            </div>
          ) : isDownloadDone ? (
            <div className="driver-manager-control-block driver-manager-card-progress-done">
              <Text type="success" className="driver-manager-card-ready-text">✓ {t('driver.modal.card.ready')}</Text>
              {isDriverVersionSwitchPending(row) ? (
                <Button
                  size={embedded ? 'small' : undefined}
                  type="primary"
                  onClick={() => requestInstallDriver(row)}
                >
                  {t('driver_manager.action.switch_version')}
                </Button>
              ) : null}
              {/* 「已就绪」是会话内的动作终态，不是永久的 UI 状态。此前该分支直接
                  吞掉了 renderDriverActions，导致刚装好的驱动再也看不到「移除」，
                  只能等 progressMap 清空。这里补回操作按钮，与下方分支同源。 */}
              {renderDriverActions(row)}
            </div>
          ) : (
            <>
              {!row.builtIn ? (
                <div className="driver-manager-control-block driver-manager-version-block">
                  <Text type="secondary" className="driver-manager-control-label">{t('driver.modal.card.versionLabel')}</Text>
                  {renderVersionControl(row)}
                </div>
              ) : null}
              {(isDownloadError || isDownloadCanceled) && progressState?.message ? (
                <Paragraph
                  className="driver-manager-progress-error"
                  type={isDownloadError ? 'danger' : 'warning'}
                  role={isDownloadError ? 'alert' : 'status'}
                  ellipsis={{ rows: 2, expandable: true, symbol: t('driver.modal.card.expand') }}
                  style={{ marginBottom: 0 }}
                >
                  {progressState.message}
                </Paragraph>
              ) : null}
              {renderDriverActions(row)}
            </>
          )}
        </div>

        {!row.builtIn && row.installDir ? (
          <Paragraph
            className="driver-manager-muted-message driver-manager-detail-path"
            type="secondary"
            copyable={{ text: row.installDir }}
          >
            {t('driver_manager.log_modal.install_dir', { path: row.installDir })}
          </Paragraph>
        ) : null}
        {!row.builtIn && row.executablePath ? (
          <Paragraph
            className="driver-manager-muted-message driver-manager-detail-path"
            type="secondary"
            copyable={{ text: row.executablePath }}
          >
            {t('driver_manager.log_modal.executable_path', { path: row.executablePath })}
          </Paragraph>
        ) : null}
      </div>
    );
  };

  const renderDriverLogSection = (row: DriverStatusRow) => {
    const selectedLogEntries = operationLogMap[row.type] || [];
    return (
      <div className="driver-manager-log-section">
        <Text type="secondary" className="driver-manager-control-label">
          {t('driver_manager.action.logs')}
        </Text>
        {selectedLogEntries.length > 0 ? (
          <div className="driver-manager-log-list">
            {selectedLogEntries.map((entry, index) => {
              const rawText = String(entry.text || '');
              const isError = rawText.startsWith('[ERROR]');
              const signatureStatus = entry.signature.startsWith('driver-progress:')
                ? entry.signature.split(':')[1]
                : '';
              const tone = isError || signatureStatus === 'ERROR'
                ? 'error'
                : signatureStatus === 'DONE' ? 'done' : '';
              const displayText = rawText.replace(/^\[[A-Z]+\]\s*/, '');
              return (
                <div
                  key={`${entry.signature}:${index}`}
                  className={`driver-manager-log-line${tone ? ` is-${tone}` : ''}`}
                >
                  <span className="driver-manager-log-time">{entry.time}</span>
                  <span className="driver-manager-log-text">{displayText}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <Text type="secondary" className="driver-manager-log-empty">
            {t('driver_manager.log_modal.empty')}
          </Text>
        )}
      </div>
    );
  };
  return { renderDriverListItem, renderDriverDetail, renderDriverLogSection };
};

export type DriverManagerDetailViewApi = ReturnType<typeof useDriverManagerDetailView>;
