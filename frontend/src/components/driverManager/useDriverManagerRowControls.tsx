import {
  type DriverStatusRow,
  Text,
  buildFallbackVersionOptions,
  resolvePreferredVersionOption,
  buildVersionOptionKey,
} from './driverManagerModel';
import { t } from '../../i18n';
import { buildVersionSelectOptions } from './driverManagerStatusCache';
import { Select, Button, Space } from 'antd';
import { isSlimBuildInstallUnavailable } from './driverLocalInstallPolicy';
import {
  isDriverReinstallTarget,
  isOptionalUpdateVisible,
  OPTIONAL_UPDATE_DISMISS_KEY,
} from './driverOptionalUpdate';
import { DownloadOutlined, DeleteOutlined, FileSearchOutlined } from '@ant-design/icons';
import { getDriverLocalImportButtonLabel } from '../../utils/driverImportGuidance';
import type { DriverManagerStateApi } from './useDriverManagerState';
import type { DriverManagerInstallApi } from './useDriverManagerInstall';
import type { DriverManagerStatusLoadingApi } from './useDriverManagerStatusLoading';
import type { DriverManagerRemovalApi } from './useDriverManagerRemoval';
import type { DriverManagerModalProps } from '../DriverManagerModal';

export interface UseDriverManagerRowControlsInput {
  versionMap: DriverManagerStateApi['versionMap'];
  selectedVersionMap: DriverManagerStateApi['selectedVersionMap'];
  setSelectedVersionMap: DriverManagerStateApi['setSelectedVersionMap'];
  resolveInstalledDriverVersion: DriverManagerInstallApi['resolveInstalledDriverVersion'];
  isDriverVersionSwitchPending: DriverManagerInstallApi['isDriverVersionSwitchPending'];
  resolveSelectedVersionOption: DriverManagerInstallApi['resolveSelectedVersionOption'];
  versionLoadingMap: DriverManagerStateApi['versionLoadingMap'];
  isDriverRowActionDisabled: DriverManagerInstallApi['isDriverRowActionDisabled'];
  loadVersionOptions: DriverManagerStatusLoadingApi['loadVersionOptions'];
  loadVersionPackageSize: DriverManagerStatusLoadingApi['loadVersionPackageSize'];
  embedded: Exclude<DriverManagerModalProps['embedded'], undefined>;
  actionState: DriverManagerStateApi['actionState'];
  optionalUpdateDismissedRevisions: DriverManagerStateApi['optionalUpdateDismissedRevisions'];
  setOptionalUpdateDismissedRevisions: DriverManagerStateApi['setOptionalUpdateDismissedRevisions'];
  requestInstallDriver: DriverManagerInstallApi['requestInstallDriver'];
  confirmRemoveDriver: DriverManagerRemovalApi['confirmRemoveDriver'];
  installDriver: DriverManagerInstallApi['installDriver'];
  requestInstallDriverFromLocalFile: DriverManagerInstallApi['requestInstallDriverFromLocalFile'];
}

export const useDriverManagerRowControls = ({
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
}: UseDriverManagerRowControlsInput) => {
  const renderVersionControl = (row: DriverStatusRow) => {
    if (row.builtIn) {
      return <Text type="secondary">{t('driver.modal.card.noInstallNeeded')}</Text>;
    }

    const loadedOptions = versionMap[row.type] || [];
    const options = loadedOptions.length > 0 ? loadedOptions : buildFallbackVersionOptions(row);
    const preferredOption = resolvePreferredVersionOption(row, options, selectedVersionMap[row.type]);
    const selectedKey = preferredOption ? buildVersionOptionKey(preferredOption) : undefined;
    const selectOptions = buildVersionSelectOptions(options);
    const installedVersion = resolveInstalledDriverVersion(row);
    const versionSwitchPending = isDriverVersionSwitchPending(row);
    const selectedOption = resolveSelectedVersionOption(row);
    const selectedOptionFromKey = selectedKey
      ? options.find((item) => buildVersionOptionKey(item) === selectedKey)
      : undefined;
    const selectedVersionMatchesInstalled = !!installedVersion
      && String(selectedOptionFromKey?.version || '').trim() === installedVersion;
    const showInstalledVersion = !!installedVersion && !selectedVersionMatchesInstalled;
    const mongoHint = row.type === 'mongodb'
      ? t('driver.modal.card.mongodbVersionHint')
      : '';
    const versionSummaryId = `driver-manager-${row.type}-version-summary`;
    const versionHintId = `driver-manager-${row.type}-version-hint`;
    const showVersionSummary = (row.packageInstalled || row.connectable) && (versionSwitchPending || showInstalledVersion);
    const versionDescription = [
      showVersionSummary ? versionSummaryId : '',
      mongoHint ? versionHintId : '',
    ].filter(Boolean).join(' ');
    return (
      <div className="driver-manager-version-control">
        <Select
          size="small"
          style={{ width: '100%' }}
          loading={!!versionLoadingMap[row.type]}
          disabled={isDriverRowActionDisabled(row.type)}
          placeholder={options.length > 0 ? t('driver.modal.card.versionPlaceholder.select') : t('driver.modal.card.versionPlaceholder.load')}
          value={selectedKey}
          options={selectOptions as any}
          aria-describedby={versionDescription || undefined}
          onOpenChange={(open) => {
            if (open && loadedOptions.length === 0 && !versionLoadingMap[row.type]) {
              void loadVersionOptions(row, true);
              return;
            }
            if (open && selectedKey) {
              void loadVersionPackageSize(row, selectedKey);
            }
          }}
          onChange={(value) => {
            setSelectedVersionMap((prev) => ({ ...prev, [row.type]: value }));
            void loadVersionPackageSize(row, value);
          }}
        />
        {(row.packageInstalled || row.connectable) && (versionSwitchPending || showInstalledVersion) ? (
          <Text id={versionSummaryId} type="secondary" className="driver-manager-small-text driver-manager-version-summary">
            {versionSwitchPending
              ? t('driver_manager.version.switch_pending', {
                installedVersion: installedVersion || t('driver_manager.version.current_fallback'),
                targetVersion: selectedOption?.version || t('driver_manager.version.target_fallback'),
              })
              : t('driver_manager.version.installed_with_version', {
                version: installedVersion,
                suffix: '',
              })}
          </Text>
        ) : null}
        {mongoHint ? <Text id={versionHintId} type="secondary" className="driver-manager-small-text">{mongoHint}</Text> : null}
      </div>
    );
  };

  const renderDriverActions = (row: DriverStatusRow) => {
    if (row.builtIn) {
      return null;
    }
    const isSlimBuildUnavailable = isSlimBuildInstallUnavailable(row);
    const loadingInstallOrRemove =
      actionState.driverType === row.type && (actionState.kind === 'install' || actionState.kind === 'remove');
    const loadingLocal = actionState.driverType === row.type && actionState.kind === 'local';
    const versionSwitchPending = isDriverVersionSwitchPending(row);

    if (isSlimBuildUnavailable && !row.packageInstalled) {
      return <Text type="secondary">{t('driver.modal.card.fullOnly')}</Text>;
    }

    const rowActionDisabled = isDriverRowActionDisabled(row.type);
    const mainAction = isDriverReinstallTarget(row, optionalUpdateDismissedRevisions) ? (
      <Button size={embedded ? 'small' : undefined} type="primary" icon={<DownloadOutlined />} disabled={rowActionDisabled} loading={loadingInstallOrRemove} onClick={() => requestInstallDriver(row)}>
        {t('driver.modal.card.action.reinstall')}
      </Button>
    ) : versionSwitchPending ? (
      <Button size={embedded ? 'small' : undefined} type="primary" icon={<DownloadOutlined />} disabled={rowActionDisabled} loading={loadingInstallOrRemove} onClick={() => requestInstallDriver(row)}>
        {t('driver_manager.action.switch_version')}
      </Button>
    ) : row.connectable ? (
      <Button size={embedded ? 'small' : undefined} danger icon={<DeleteOutlined />} disabled={rowActionDisabled} loading={loadingInstallOrRemove} onClick={() => confirmRemoveDriver(row)}>
        {t('driver.modal.card.action.remove')}
      </Button>
    ) : (
      <Button size={embedded ? 'small' : undefined} type="primary" icon={<DownloadOutlined />} disabled={rowActionDisabled} loading={loadingInstallOrRemove} onClick={() => installDriver(row)}>
        {t('driver.modal.card.action.install')}
      </Button>
    );

    return (
      <Space size={8} wrap className="driver-manager-card-actions">
        {mainAction}
        {isOptionalUpdateVisible(row, optionalUpdateDismissedRevisions) ? (
          <Button
            size={embedded ? 'small' : undefined}
            type="text"
            disabled={rowActionDisabled}
            onClick={() => {
              if (!row.expectedRevision) {
                return;
              }
              const nextDismissed = Array.from(new Set([...optionalUpdateDismissedRevisions, row.expectedRevision]));
              try {
                window.localStorage.setItem(OPTIONAL_UPDATE_DISMISS_KEY, JSON.stringify(nextDismissed));
              } catch {
                // localStorage 不可用时仅本次会话内生效
              }
              setOptionalUpdateDismissedRevisions(nextDismissed);
            }}
          >
            {t('driver.modal.card.optionalUpdate.dismiss')}
          </Button>
        ) : null}
        {!row.connectable ? (
          <Button size={embedded ? 'small' : undefined} danger ghost icon={<DeleteOutlined />} disabled={rowActionDisabled} onClick={() => confirmRemoveDriver(row)}>
            {t('driver.modal.card.action.remove')}
          </Button>
        ) : null}
        <Button size={embedded ? 'small' : undefined} icon={<FileSearchOutlined />} disabled={rowActionDisabled} loading={loadingLocal} onClick={() => requestInstallDriverFromLocalFile(row)}>
          {getDriverLocalImportButtonLabel()}
        </Button>
      </Space>
    );
  };
  return { renderVersionControl, renderDriverActions };
};

export type DriverManagerRowControlsApi = ReturnType<typeof useDriverManagerRowControls>;
