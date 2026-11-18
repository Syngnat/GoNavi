import { DBQuery } from '../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from './connectionRpcConfig';
import {
  buildDatabaseDefinitionQueries,
  buildStaticDatabaseDefinition,
  extractDatabaseDefinition,
  supportsDatabaseDefinition,
} from './databaseDefinition';

export interface DatabaseDefinitionLoadResult {
  success: boolean;
  definition: string;
  unsupported?: boolean;
  message?: string;
}

export const fetchDatabaseDefinition = async (
  config: Record<string, unknown>,
  dialect: string,
  dbName: string,
): Promise<DatabaseDefinitionLoadResult> => {
  const normalizedDbName = String(dbName || '').trim();
  if (!normalizedDbName) {
    return { success: false, definition: '', message: '' };
  }

  const staticDefinition = buildStaticDatabaseDefinition(dialect, normalizedDbName);
  if (staticDefinition) {
    return { success: true, definition: staticDefinition };
  }
  if (!supportsDatabaseDefinition(dialect)) {
    return { success: false, definition: '', unsupported: true };
  }

  const queries = buildDatabaseDefinitionQueries(dialect, normalizedDbName);
  if (queries.length === 0) {
    return { success: false, definition: '', unsupported: true };
  }

  let lastMessage = '';
  const rpcConfig = buildRpcConnectionConfig(config as any) as any;
  for (const query of queries) {
    const sql = String(query || '').trim();
    if (!sql) continue;
    try {
      const result = await DBQuery(rpcConfig, normalizedDbName, sql);
      if (!result?.success || !Array.isArray(result.data)) {
        lastMessage = String(result?.message || lastMessage || '');
        continue;
      }
      if (result.data.length === 0) continue;
      const definition = extractDatabaseDefinition(
        dialect,
        result.data as Record<string, unknown>[],
        normalizedDbName,
      );
      if (definition) {
        return { success: true, definition };
      }
    } catch (error: any) {
      lastMessage = error?.message || String(error);
    }
  }

  return { success: false, definition: '', message: lastMessage };
};
