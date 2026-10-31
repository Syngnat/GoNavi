import type { SavedConnection } from '../../types';
import { registryAllowsImport } from '../../utils/dataSourceRegistry';
import {
  isConnectionDataImportRestricted,
  isConnectionStructureEditRestricted,
  isConnectionScriptExecutionRestricted,
} from '../../utils/connectionReadOnly';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import type { DataImportMode } from '../../utils/dataImportTab';

export const isEligibleImportConnection = (
  connection: SavedConnection,
  mode: DataImportMode,
): boolean => {
  if (mode === 'table') {
    const capabilities = getDataSourceCapabilities(connection.config);
    return (capabilities.supportsCopyInsert || (capabilities.type === 'hive' && registryAllowsImport(connection.config.type, 'table')))
      && !isConnectionDataImportRestricted(connection.config);
  }
  return !isConnectionDataImportRestricted(connection.config)
    && !isConnectionStructureEditRestricted(connection.config)
    && !isConnectionScriptExecutionRestricted(connection.config);
};
