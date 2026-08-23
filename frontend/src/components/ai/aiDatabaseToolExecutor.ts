import type { SavedConnection } from '../../types';
import { t as translateCatalog, type I18nParams } from '../../i18n';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { buildAIReadonlyPreviewSQL } from '../../utils/aiSqlLimit';
import { findPotentiallyMutatingConnectionStatements } from '../../utils/connectionReadOnly';
import { confirmProductionRisk } from '../../utils/productionRiskConfirm';
import { resolveAITableSchemaToolResult } from '../../utils/aiTableSchemaTool';
import type { AILocalToolRuntime, AIToolContextEntry } from './aiLocalToolRuntime';
import {
  buildPreviewSQLForTable,
  normalizeColumns,
  normalizeColumnsWithTable,
  normalizePreviewLimit,
  normalizeTableList,
} from './aiDatabaseToolHelpers';
import { inspectDatabaseBundle, inspectTableBundle } from './aiDatabaseBundleTools';

interface ExecuteDatabaseToolCallOptions {
  toolName: string;
  args: Record<string, any>;
  connections: SavedConnection[];
  toolContextMap: Map<string, AIToolContextEntry>;
  runtime: AILocalToolRuntime;
  translate?: (key: string, params?: I18nParams) => string;
}

interface ToolExecutionResult {
  content: string;
  success: boolean;
  countsAsProbeFailure?: boolean;
}

type DatabaseToolTranslate = (key: string, params?: I18nParams) => string;

const findConnection = (connections: SavedConnection[], connectionId: string) =>
  connections.find((connection) => connection.id === connectionId);

const resolveConnectionOrFailure = (
  connections: SavedConnection[],
  connectionId: string,
  translate?: DatabaseToolTranslate,
): { connection: SavedConnection | null; failure?: ToolExecutionResult } => {
  const connection = findConnection(connections, connectionId);
  if (!connection) {
    return {
      connection: null,
      failure: {
        content: translateDatabaseToolCopy(
          translate,
          'ai_chat.panel.tool_error.connection_not_found',
          'Connection not found',
        ),
        success: false,
        countsAsProbeFailure: true,
      },
    };
  }
  return { connection };
};

const CONNECTION_ERROR_KEYWORDS = [
  'connection not found',
  'invalid connection',
  'bad connection',
  'driver: bad connection',
  'connection refused',
  'connection reset',
  'closed network connection',
  'server has gone away',
  'broken pipe',
  'no such host',
  'network is unreachable',
  'context deadline exceeded',
  'i/o timeout',
  'timeout',
  'eof',
  '\u8fde\u63a5\u5931\u8d25',
  '\u8fde\u63a5\u5f02\u5e38',
  '\u8fde\u63a5\u8d85\u65f6',
  '\u8fde\u63a5\u5df2\u5173\u95ed',
  '\u7f51\u7edc\u8d85\u65f6',
  '\u7f51\u7edc\u5f02\u5e38',
  '\u903e\u6642',
  '\u30bf\u30a4\u30e0\u30a2\u30a6\u30c8',
  'zeit\u00fcberschreitung',
  '\u0442\u0430\u0439\u043c-\u0430\u0443\u0442',
];

const countsAsProbeFailure = (message: unknown): boolean => {
  const text = String(message || '').trim().toLowerCase();
  if (!text) {
    return true;
  }
  return CONNECTION_ERROR_KEYWORDS.some((keyword) => text.includes(keyword));
};

const translateDatabaseToolCopy = (
  translate: DatabaseToolTranslate | undefined,
  key: string,
  fallback: string,
  params?: I18nParams,
): string => {
  const t = translate || ((catalogKey, catalogParams) => translateCatalog(catalogKey, catalogParams, 'en-US'));
  const translated = t(key, params);
  return translated && translated !== key ? translated : fallback;
};

const rawErrorDetail = (error: any): string => String(error?.message || error);

const translateDatabaseToolError = (
  translate: DatabaseToolTranslate | undefined,
  key: string,
  fallbackPrefix: string,
  detail: string,
): string =>
  translateDatabaseToolCopy(
    translate,
    key,
    `${fallbackPrefix}: ${detail}`,
    { detail },
  );

const translateDatabaseToolUnknownDetail = (
  translate: DatabaseToolTranslate | undefined,
): string =>
  translateDatabaseToolCopy(
    translate,
    'ai_chat.inspection.diagnostics.error.unknown',
    'unknown error',
  );

const translateDatabaseToolUnknownFailure = (
  translate: DatabaseToolTranslate | undefined,
  key: string,
  fallbackPrefix: string,
): string =>
  translateDatabaseToolError(
    translate,
    key,
    fallbackPrefix,
    translateDatabaseToolUnknownDetail(translate),
  );

const translateTruncatedSuffix = (translate: DatabaseToolTranslate | undefined): string =>
  translateDatabaseToolCopy(
    translate,
    'ai_chat.panel.error.truncated_suffix',
    '...(truncated)',
  );

export async function executeDatabaseToolCall(
  options: ExecuteDatabaseToolCallOptions,
): Promise<ToolExecutionResult | null> {
  const { toolName, args, connections, toolContextMap, runtime, translate } = options;

  switch (toolName) {
    case 'get_connections': {
      const availableConnections = connections.map((connection) => ({
        id: connection.id,
        name: connection.name,
        type: connection.config?.type,
        host: (connection.config as any)?.host || (connection.config as any)?.addr || '',
      }));
      return {
        content: JSON.stringify(availableConnections),
        success: true,
      };
    }
    case 'get_databases': {
      const resolved = resolveConnectionOrFailure(connections, args.connectionId, translate);
      if (resolved.failure || !resolved.connection) return resolved.failure || null;
      try {
        const result = await runtime.getDatabases(buildRpcConnectionConfig(resolved.connection.config) as any);
        if (result?.success && Array.isArray(result.data)) {
          let databaseNames = result.data.map((row: any) => row.Database || row.database || Object.values(row)[0]);
          if (databaseNames.length > 50) {
            databaseNames = [...databaseNames.slice(0, 50), translateTruncatedSuffix(translate)];
          }
          return { content: JSON.stringify(databaseNames), success: true };
        }
        return {
          content: result?.message || translateDatabaseToolUnknownFailure(
            translate,
            'ai_chat.panel.tool_error.fetch_databases_failed',
            'Failed to fetch database list',
          ),
          success: false,
          countsAsProbeFailure: countsAsProbeFailure(result?.message),
        };
      } catch (error: any) {
        const detail = rawErrorDetail(error);
        const message = translateDatabaseToolError(
          translate,
          'ai_chat.panel.tool_error.fetch_databases_failed',
          'Failed to fetch database list',
          detail,
        );
        return { content: message, success: false, countsAsProbeFailure: countsAsProbeFailure(message) };
      }
    }
    case 'get_tables': {
      const resolved = resolveConnectionOrFailure(connections, args.connectionId, translate);
      if (resolved.failure || !resolved.connection) return resolved.failure || null;
      try {
        const rawDbName = args.dbName || args.database;
        const safeDbName = rawDbName ? String(rawDbName).trim() : '';
        const result = await runtime.getTables(buildRpcConnectionConfig(resolved.connection.config) as any, safeDbName);
        if (result?.success && Array.isArray(result.data)) {
          let tableNames = normalizeTableList(result.data);
          const contextTableNames = tableNames.slice(0, 150);
          const truncatedSuffix = translateTruncatedSuffix(translate);
          if (tableNames.length > 150) {
            tableNames = [...tableNames.slice(0, 150), truncatedSuffix];
          }
          toolContextMap.set(`${args.connectionId}:${safeDbName}`, {
            connectionId: args.connectionId,
            dbName: safeDbName,
            tables: contextTableNames,
          });
          return { content: JSON.stringify(tableNames), success: true };
        }
        return {
          content: result?.message || translateDatabaseToolUnknownFailure(
            translate,
            'ai_chat.panel.tool_error.fetch_tables_failed',
            'Failed to fetch table list',
          ),
          success: false,
          countsAsProbeFailure: countsAsProbeFailure(result?.message),
        };
      } catch (error: any) {
        const detail = rawErrorDetail(error);
        const message = translateDatabaseToolError(
          translate,
          'ai_chat.panel.tool_error.fetch_tables_failed',
          'Failed to fetch table list',
          detail,
        );
        return { content: message, success: false, countsAsProbeFailure: countsAsProbeFailure(message) };
      }
    }
    case 'get_all_columns': {
      const resolved = resolveConnectionOrFailure(connections, args.connectionId, translate);
      if (resolved.failure || !resolved.connection) return resolved.failure || null;
      try {
        const safeDbName = args.dbName ? String(args.dbName).trim() : '';
        const result = await runtime.getAllColumns(buildRpcConnectionConfig(resolved.connection.config) as any, safeDbName);
        if (result?.success && Array.isArray(result.data)) {
          const allColumns = normalizeColumnsWithTable(result.data);
          const tableNames = Array.from(new Set(allColumns.map((column) => column.tableName).filter(Boolean)));
          const limitedColumns = allColumns.slice(0, 400);
          const warnings = Array.isArray(result.warnings)
            ? result.warnings.map((warning: unknown) => String(warning || '').trim()).filter(Boolean)
            : [];
          return {
            content: JSON.stringify({
              dbName: safeDbName,
              tableCount: tableNames.length,
              totalColumns: allColumns.length,
              truncated: allColumns.length > limitedColumns.length,
              partial: Boolean(result.partial),
              warnings,
              columns: limitedColumns,
            }),
            success: true,
          };
        }
        return {
          content: result?.message || translateDatabaseToolUnknownFailure(
            translate,
            'ai_chat.panel.tool_error.fetch_all_columns_failed',
            'Failed to fetch database column summary',
          ),
          success: false,
          countsAsProbeFailure: countsAsProbeFailure(result?.message),
        };
      } catch (error: any) {
        const detail = rawErrorDetail(error);
        const message = translateDatabaseToolError(
          translate,
          'ai_chat.panel.tool_error.fetch_all_columns_failed',
          'Failed to fetch database column summary',
          detail,
        );
        return { content: message, success: false, countsAsProbeFailure: countsAsProbeFailure(message) };
      }
    }
    case 'get_columns': {
      const resolved = resolveConnectionOrFailure(connections, args.connectionId, translate);
      if (resolved.failure || !resolved.connection) return resolved.failure || null;
      try {
        const safeDbName = args.dbName ? String(args.dbName).trim() : '';
        const safeTable = args.tableName ? String(args.tableName).trim() : '';
        const result = await runtime.getColumns(buildRpcConnectionConfig(resolved.connection.config) as any, safeDbName, safeTable);
        if (result?.success && Array.isArray(result.data)) {
          const columns = normalizeColumns(result.data);
          const fieldNames = columns.map((column) => column.field).join(', ');
          const detail = JSON.stringify(columns);
          return {
            content: [
              translateDatabaseToolCopy(
                translate,
                'ai_chat.inspection.table_schema.warning.columns_contract',
                `The following is the real field list for table ${safeTable}. When generating SQL, use only these field values as column names exactly as shown; do not modify, abbreviate, or invent column names.`,
                { tableName: safeTable },
              ),
              translateDatabaseToolCopy(
                translate,
                'ai_chat.inspection.table_schema.warning.available_fields',
                `Available fields: ${fieldNames}`,
                { fields: fieldNames },
              ),
              translateDatabaseToolCopy(
                translate,
                'ai_chat.inspection.table_schema.warning.detail',
                `Details: ${detail}`,
                { detail },
              ),
            ].join('\n'),
            success: true,
          };
        }
        return {
          content: result?.message || translateDatabaseToolUnknownFailure(
            translate,
            'ai_chat.panel.tool_error.fetch_columns_failed',
            'Failed to fetch column list',
          ),
          success: false,
          countsAsProbeFailure: countsAsProbeFailure(result?.message),
        };
      } catch (error: any) {
        const detail = rawErrorDetail(error);
        const message = translateDatabaseToolError(
          translate,
          'ai_chat.panel.tool_error.fetch_columns_failed',
          'Failed to fetch column list',
          detail,
        );
        return { content: message, success: false, countsAsProbeFailure: countsAsProbeFailure(message) };
      }
    }
    case 'get_indexes': {
      const resolved = resolveConnectionOrFailure(connections, args.connectionId, translate);
      if (resolved.failure || !resolved.connection) return resolved.failure || null;
      try {
        const safeDbName = args.dbName ? String(args.dbName).trim() : '';
        const safeTable = args.tableName ? String(args.tableName).trim() : '';
        const result = await runtime.getIndexes(buildRpcConnectionConfig(resolved.connection.config) as any, safeDbName, safeTable);
        return {
          content: result?.success && Array.isArray(result.data) ? JSON.stringify(result.data) : (result?.message || translateDatabaseToolUnknownFailure(
            translate,
            'ai_chat.panel.tool_error.fetch_indexes_failed',
            'Failed to fetch index definitions',
          )),
          success: !!result?.success && Array.isArray(result.data),
          countsAsProbeFailure: result?.success ? false : countsAsProbeFailure(result?.message),
        };
      } catch (error: any) {
        const detail = rawErrorDetail(error);
        const message = translateDatabaseToolError(
          translate,
          'ai_chat.panel.tool_error.fetch_indexes_failed',
          'Failed to fetch index definitions',
          detail,
        );
        return { content: message, success: false, countsAsProbeFailure: countsAsProbeFailure(message) };
      }
    }
    case 'get_foreign_keys': {
      const resolved = resolveConnectionOrFailure(connections, args.connectionId, translate);
      if (resolved.failure || !resolved.connection) return resolved.failure || null;
      try {
        const safeDbName = args.dbName ? String(args.dbName).trim() : '';
        const safeTable = args.tableName ? String(args.tableName).trim() : '';
        const result = await runtime.getForeignKeys(buildRpcConnectionConfig(resolved.connection.config) as any, safeDbName, safeTable);
        return {
          content: result?.success && Array.isArray(result.data) ? JSON.stringify(result.data) : (result?.message || translateDatabaseToolUnknownFailure(
            translate,
            'ai_chat.panel.tool_error.fetch_foreign_keys_failed',
            'Failed to fetch foreign key relationships',
          )),
          success: !!result?.success && Array.isArray(result.data),
          countsAsProbeFailure: result?.success ? false : countsAsProbeFailure(result?.message),
        };
      } catch (error: any) {
        const detail = rawErrorDetail(error);
        const message = translateDatabaseToolError(
          translate,
          'ai_chat.panel.tool_error.fetch_foreign_keys_failed',
          'Failed to fetch foreign key relationships',
          detail,
        );
        return { content: message, success: false, countsAsProbeFailure: countsAsProbeFailure(message) };
      }
    }
    case 'get_triggers': {
      const resolved = resolveConnectionOrFailure(connections, args.connectionId, translate);
      if (resolved.failure || !resolved.connection) return resolved.failure || null;
      try {
        const safeDbName = args.dbName ? String(args.dbName).trim() : '';
        const safeTable = args.tableName ? String(args.tableName).trim() : '';
        const result = await runtime.getTriggers(buildRpcConnectionConfig(resolved.connection.config) as any, safeDbName, safeTable);
        return {
          content: result?.success && Array.isArray(result.data) ? JSON.stringify(result.data) : (result?.message || translateDatabaseToolUnknownFailure(
            translate,
            'ai_chat.panel.tool_error.fetch_triggers_failed',
            'Failed to fetch trigger definitions',
          )),
          success: !!result?.success && Array.isArray(result.data),
          countsAsProbeFailure: result?.success ? false : countsAsProbeFailure(result?.message),
        };
      } catch (error: any) {
        const detail = rawErrorDetail(error);
        const message = translateDatabaseToolError(
          translate,
          'ai_chat.panel.tool_error.fetch_triggers_failed',
          'Failed to fetch trigger definitions',
          detail,
        );
        return { content: message, success: false, countsAsProbeFailure: countsAsProbeFailure(message) };
      }
    }
    case 'get_table_ddl': {
      const resolved = resolveConnectionOrFailure(connections, args.connectionId);
      if (resolved.failure || !resolved.connection) return resolved.failure || null;
      try {
        const safeDbName = args.dbName ? String(args.dbName).trim() : '';
        const safeTable = args.tableName ? String(args.tableName).trim() : '';
        const rpcConfig = buildRpcConnectionConfig(resolved.connection.config) as any;
        const result = await resolveAITableSchemaToolResult({
          tableName: safeTable,
          fetchDDL: () => runtime.showCreateTable(rpcConfig, safeDbName, safeTable),
          fetchColumns: () => runtime.getColumns(rpcConfig, safeDbName, safeTable),
          translate,
        });
        return {
          content: result.content,
          success: result.success,
          countsAsProbeFailure: result.success ? false : countsAsProbeFailure(result.content),
        };
      } catch (error: any) {
        const detail = String(error?.message || error);
        const message = translateDatabaseToolCopy(
          translate,
          'ai_chat.inspection.table_schema.error.ddl_failed',
          `Failed to fetch table DDL: ${detail}`,
          { detail },
        );
        return { content: message, success: false, countsAsProbeFailure: countsAsProbeFailure(message) };
      }
    }
    case 'inspect_table_bundle': {
      const resolved = resolveConnectionOrFailure(connections, args.connectionId);
      if (resolved.failure || !resolved.connection) return resolved.failure || null;
      return inspectTableBundle({ args, connection: resolved.connection, runtime, translate });
    }
    case 'inspect_database_bundle': {
      const resolved = resolveConnectionOrFailure(connections, args.connectionId);
      if (resolved.failure || !resolved.connection) return resolved.failure || null;
      return inspectDatabaseBundle({ args, connection: resolved.connection, runtime, translate });
    }
    case 'preview_table_rows': {
      const resolved = resolveConnectionOrFailure(connections, args.connectionId);
      if (resolved.failure || !resolved.connection) return resolved.failure || null;
      try {
        const safeDbName = args.dbName ? String(args.dbName).trim() : '';
        const safeTable = args.tableName ? String(args.tableName).trim() : '';
        if (!safeTable) {
          return {
            content: translateDatabaseToolCopy(
              translate,
              'ai_chat.panel.tool_error.table_name_required',
              'tableName cannot be empty',
            ),
            success: false,
          };
        }
        const safeLimit = normalizePreviewLimit(args.limit);
        const previewSQL = buildPreviewSQLForTable(resolved.connection, safeTable, safeLimit);
        const result = await runtime.query(buildRpcConnectionConfig(resolved.connection.config) as any, safeDbName, previewSQL);
        if (result?.success) {
          const rows = Array.isArray(result.data) ? result.data : [];
          return {
            content: JSON.stringify({
              dbName: safeDbName,
              tableName: safeTable,
              limit: safeLimit,
              rowCount: rows.length,
              rows: rows.slice(0, safeLimit),
            }),
            success: true,
          };
        }
        return {
          content: result?.message || 'Failed to preview table rows',
          success: false,
          countsAsProbeFailure: countsAsProbeFailure(result?.message),
        };
      } catch (error: any) {
        const detail = rawErrorDetail(error);
        const message = translateDatabaseToolError(
          translate,
          'ai_chat.panel.tool_error.preview_table_rows_failed',
          'Failed to preview table rows',
          detail,
        );
        return { content: message, success: false, countsAsProbeFailure: countsAsProbeFailure(message) };
      }
    }
    case 'execute_sql': {
      const resolved = resolveConnectionOrFailure(connections, args.connectionId);
      if (resolved.failure || !resolved.connection) return resolved.failure || null;
      try {
        const safeDbName = args.dbName ? String(args.dbName).trim() : '';
        const safeSql = args.sql ? String(args.sql).trim() : '';
        if (typeof runtime.checkSQL === 'function') {
          const checkResult = await runtime.checkSQL(safeSql);
          if (checkResult && checkResult.allowed === false) {
            return {
              content: translateDatabaseToolCopy(
                translate,
                'ai_chat.panel.tool_error.sql_blocked',
                `Security policy blocked this request: the current safety level does not allow ${checkResult.operationType} SQL. Show the SQL to the user and ask them to run it manually.`,
                { operationType: checkResult.operationType },
              ),
              success: false,
              countsAsProbeFailure: false,
            };
          }
        }
        const finalSql = buildAIReadonlyPreviewSQL(
          resolved.connection.config?.type || '',
          safeSql,
          50,
          resolved.connection.config?.driver || '',
          { oceanBaseProtocol: resolved.connection.config?.oceanBaseProtocol },
        );
        if (
          findPotentiallyMutatingConnectionStatements(
            resolved.connection.config,
            finalSql,
          ).length > 0
        ) {
          const translateRisk = translate || translateCatalog;
          const approved = await confirmProductionRisk({
            connection: resolved.connection,
            action: translateRisk('connection.production_risk.action.execute_sql'),
            target: safeDbName,
            translate: translateRisk,
          });
          if (!approved) {
            return {
              content: translateRisk('connection.production_risk.cancelled'),
              success: false,
              countsAsProbeFailure: false,
            };
          }
        }
        const result = await runtime.query(buildRpcConnectionConfig(resolved.connection.config) as any, safeDbName, finalSql);
        if (result?.success) {
          const affectedRows = Number((result.data as Record<string, unknown> | null | undefined)?.affectedRows);
          if (Number.isFinite(affectedRows)) {
            return {
              content: JSON.stringify({ affectedRows }),
              success: true,
            };
          }
          const rows = Array.isArray(result.data) ? result.data : [];
          return {
            content: JSON.stringify({ rowCount: rows.length, data: rows.slice(0, 50) }),
            success: true,
          };
        }
        return {
          content: result?.message || translateDatabaseToolCopy(
            translate,
            'ai_chat.panel.tool_error.sql_execute_failed',
            'SQL execution failed',
          ),
          success: false,
          countsAsProbeFailure: countsAsProbeFailure(result?.message),
        };
      } catch (error: any) {
        const detail = rawErrorDetail(error);
        const message = translateDatabaseToolCopy(
          translate,
          'ai_chat.panel.tool_error.sql_execute_exception',
          `SQL execution exception: ${detail}`,
          { detail },
        );
        return { content: message, success: false, countsAsProbeFailure: countsAsProbeFailure(message) };
      }
    }
    default:
      return null;
  }
}
