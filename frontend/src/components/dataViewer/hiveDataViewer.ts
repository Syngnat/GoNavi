import { DBGetColumns } from '../../../wailsjs/go/app/App';
import type { ConnectionConfig } from '../../types';
import { t } from '../../i18n';
import { getColumnDefinitionName } from '../../utils/columnDefinition';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { buildHivePageSQL, hivePaginationNeedsOrder } from '../../utils/hivePagination';
import { requestTableMetadata } from '../../utils/tableMetadataRequestCache';

export const prepareHiveTablePageSQL = async (
  config: ConnectionConfig, connectionId: string, database: string, table: string,
  base: string, orderBy: string, limit: number, offset: number,
): Promise<string> => {
  if (offset <= 0) return buildHivePageSQL(base, orderBy, limit, offset);
  const result = await requestTableMetadata({ connectionId, dbName: database, tableName: table, kind: 'columns', connectionParams: config.connectionParams },
    () => DBGetColumns(buildRpcConnectionConfig(config), database, table));
  if (!result.success || !Array.isArray(result.data)) throw new Error(t('hive.pagination.columnsRequired'));
  const columns = result.data.map(getColumnDefinitionName).filter(Boolean);
  return buildHivePageSQL(base, orderBy, limit, offset, columns);
};

export { hivePaginationNeedsOrder };
