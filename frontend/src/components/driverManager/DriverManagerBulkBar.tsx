import { Button, Dropdown, Tooltip } from 'antd';
import {
  DownloadOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  DownOutlined,
  ExportOutlined,
  ImportOutlined,
} from '@ant-design/icons';
import { t } from '../../i18n';
import type { DriverManagerInstallApi } from './useDriverManagerInstall';
import type { DriverManagerRowsApi } from './useDriverManagerRows';
import type { DriverManagerStateApi } from './useDriverManagerState';
import type { DriverManagerBatchApi } from './useDriverManagerBatch';
import type { DriverManagerRemovalApi } from './useDriverManagerRemoval';
import type { DriverManagerModalProps } from '../DriverManagerModal';

export interface DriverManagerBulkBarProps {
  embedded: Exclude<DriverManagerModalProps['embedded'], undefined>;
  driverBatchOperationBusy: DriverManagerInstallApi['driverBatchOperationBusy'];
  initialStatusLoading: DriverManagerRowsApi['initialStatusLoading'];
  installableRows: DriverManagerRowsApi['installableRows'];
  batchAction: DriverManagerStateApi['batchAction'];
  installAllDrivers: DriverManagerBatchApi['installAllDrivers'];
  reinstallableRows: DriverManagerRowsApi['reinstallableRows'];
  reinstallNeededDrivers: DriverManagerBatchApi['reinstallNeededDrivers'];
  removableRows: DriverManagerRowsApi['removableRows'];
  removeAllDrivers: DriverManagerBatchApi['removeAllDrivers'];
  openDriverDirectory: DriverManagerRemovalApi['openDriverDirectory'];
  batchDirectoryImporting: DriverManagerStateApi['batchDirectoryImporting'];
  requestInstallDriversFromDirectory: DriverManagerInstallApi['requestInstallDriversFromDirectory'];
  packageTransferDisabledReason: DriverManagerInstallApi['packageTransferDisabledReason'];
  driverPackageExporting: DriverManagerInstallApi['driverPackageExporting'];
  packageTransferDisabled: DriverManagerInstallApi['packageTransferDisabled'];
  installedDriverCount: DriverManagerInstallApi['installedDriverCount'];
  requestExportDriverPackage: DriverManagerInstallApi['requestExportDriverPackage'];
  driverPackageInspecting: DriverManagerInstallApi['driverPackageInspecting'];
  requestImportDriverPackage: DriverManagerInstallApi['requestImportDriverPackage'];
}

export const DriverManagerBulkBar = ({
  embedded,
  driverBatchOperationBusy,
  initialStatusLoading,
  installableRows,
  batchAction,
  installAllDrivers,
  reinstallableRows,
  reinstallNeededDrivers,
  removableRows,
  removeAllDrivers,
  openDriverDirectory,
  batchDirectoryImporting,
  requestInstallDriversFromDirectory,
  packageTransferDisabledReason,
  driverPackageExporting,
  packageTransferDisabled,
  installedDriverCount,
  requestExportDriverPackage,
  driverPackageInspecting,
  requestImportDriverPackage,
}: DriverManagerBulkBarProps) => (
  <div className={`driver-manager-bulkbar${embedded ? ' is-embedded-toolbar' : ''}`}>
    <div className="driver-manager-bulkbar-primary">
      <Button
        size={embedded ? 'middle' : 'small'}
        type="primary"
        icon={<DownloadOutlined />}
        disabled={driverBatchOperationBusy || (!initialStatusLoading && installableRows.length === 0)}
        loading={batchAction === 'install-all' || initialStatusLoading}
        onClick={() => void installAllDrivers()}
      >
        {t('driver.modal.toolbar.installAll')}
      </Button>
      <Button
        size={embedded ? 'middle' : 'small'}
        type={embedded ? 'default' : 'primary'}
        icon={<DownloadOutlined />}
        disabled={driverBatchOperationBusy || (!initialStatusLoading && reinstallableRows.length === 0)}
        loading={batchAction === 'reinstall-updates' || initialStatusLoading}
        onClick={() => void reinstallNeededDrivers()}
      >
        {t('driver.modal.toolbar.reinstallUpdates')}
      </Button>
      <Button
        size={embedded ? 'middle' : 'small'}
        danger
        icon={<DeleteOutlined />}
        disabled={driverBatchOperationBusy || (!initialStatusLoading && removableRows.length === 0)}
        loading={batchAction === 'remove-all' || initialStatusLoading}
        onClick={() => void removeAllDrivers()}
      >
        {t('driver.modal.toolbar.removeAll')}
      </Button>
    </div>
    <span className="driver-manager-bulkbar-dir">
      <Button
        size={embedded ? 'middle' : 'small'}
        icon={<FolderOpenOutlined />}
        onClick={() => void openDriverDirectory()}
      >
        {t('driver.modal.toolbar.openDirectory')}
      </Button>
      <Dropdown.Button
        size={embedded ? 'middle' : 'small'}
        className="driver-manager-import-directory-dropdown"
        icon={<DownOutlined />}
        loading={batchDirectoryImporting}
        disabled={batchDirectoryImporting}
        onClick={() => requestInstallDriversFromDirectory({ forceOverwrite: false })}
        menu={{
          items: [
            {
              key: 'overwrite',
              label: t('driver.modal.toolbar.importDirectoryOverwrite'),
              disabled: batchDirectoryImporting,
              onClick: () => requestInstallDriversFromDirectory({ forceOverwrite: true }),
            },
          ],
        }}
      >
        {t('driver.modal.toolbar.importDirectory')}
      </Dropdown.Button>
      <Tooltip title={packageTransferDisabledReason}>
        <Button
          size={embedded ? 'middle' : 'small'}
          icon={<ExportOutlined />}
          loading={driverPackageExporting}
          disabled={packageTransferDisabled || installedDriverCount === 0}
          onClick={() => void requestExportDriverPackage()}
        >
          {t('driver.modal.toolbar.exportPackage')}
        </Button>
      </Tooltip>
      <Tooltip title={packageTransferDisabledReason}>
        <Button
          size={embedded ? 'middle' : 'small'}
          icon={<ImportOutlined />}
          loading={driverPackageInspecting}
          disabled={packageTransferDisabled}
          onClick={() => void requestImportDriverPackage()}
        >
          {t('driver.modal.toolbar.importPackageZip')}
        </Button>
      </Tooltip>
                            </span>
  </div>
);
