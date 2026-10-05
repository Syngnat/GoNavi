import { useState, useRef } from 'react';
import { useStore } from '../../../store';
import { useI18n } from '../../../i18n/provider';
import { resolveDefinitionViewerDialect } from '../../definitionViewerDialect';
import { splitQualifiedNameLast } from '../../../utils/qualifiedName';
import { buildSqlServerObjectDefinitionQueries } from '../../../utils/sqlServerObjectDefinition';
import { DBQuery } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { normalizeMySQLViewDDL } from '../definitionViewerSql';
import type { DefinitionViewerProps } from '../../DefinitionViewer';
import { buildPgRoutineDefinitionQuery } from '../../../utils/pgRoutineDefinition';

export interface UseDefinitionViewerStateInput {
  tab: DefinitionViewerProps['tab'];
}

export const useDefinitionViewerState = ({ tab }: UseDefinitionViewerStateInput) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [definition, setDefinition] = useState<string>('');
  const [openingObjectEdit, setOpeningObjectEdit] = useState(false);
  const isMountedRef = useRef(true);
  const loadedDefinitionKeyRef = useRef('');
  const editorRef = useRef<any>(null);

  const connections = useStore(state => state.connections);
  const theme = useStore(state => state.theme);
  const addTab = useStore(state => state.addTab);
  const setActiveContext = useStore(state => state.setActiveContext);
  const darkMode = theme === 'dark';
  const { t } = useI18n();
  const objectIdentityKey = [
      tab.connectionId,
      tab.dbName,
      tab.type,
      tab.viewName,
      tab.viewKind,
      tab.eventName,
      tab.routineName,
      tab.routineType,
      tab.sequenceName,
      tab.packageName,
      tab.databaseLinkName,
      tab.schemaName,
  ].map((item) => String(item || '')).join('||');

  const escapeSQLLiteral = (raw: string): string => String(raw || '').replace(/'/g, "''");

  const getMetadataDialect = (conn: any): string => resolveDefinitionViewerDialect(conn);

  const isSphinxConnection = (conn: any): boolean => {
      const type = String(conn?.config?.type || '').trim().toLowerCase();
      if (type === 'sphinx') return true;
      if (type !== 'custom') return false;
      const driver = String(conn?.config?.driver || '').trim().toLowerCase();
      return driver === 'sphinx' || driver === 'sphinxql';
  };

  const parseSchemaAndName = (fullName: string): { schema: string; name: string } => {
      const parsed = splitQualifiedNameLast(fullName);
      return { schema: parsed.parentPath, name: parsed.objectName };
  };

  const getCaseInsensitiveRawValue = (row: Record<string, any>, candidateKeys: string[]): any => {
      const keyMap = new Map<string, any>();
      Object.keys(row || {}).forEach((key) => keyMap.set(key.toLowerCase(), row[key]));
      for (const key of candidateKeys) {
          const value = keyMap.get(key.toLowerCase());
          if (value !== undefined && value !== null) {
              return value;
          }
      }
      return undefined;
  };

  const parseDuckDBParameterNames = (raw: any): string[] => {
      if (Array.isArray(raw)) {
          return raw
              .map((item) => String(item ?? '').trim())
              .filter((item) => item !== '' && item.toLowerCase() !== '<nil>');
      }
      const text = String(raw ?? '').trim();
      if (!text) return [];
      const normalized = text.startsWith('[') && text.endsWith(']')
          ? text.slice(1, -1)
          : text;
      return normalized
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part !== '' && part.toLowerCase() !== '<nil>');
  };

  const buildDuckDBMacroDDL = (
      schemaName: string,
      functionName: string,
      parametersRaw: any,
      macroDefinitionRaw: any
  ): string => {
      const schema = String(schemaName || '').trim();
      const name = String(functionName || '').trim();
      const macroDefinition = String(macroDefinitionRaw || '').trim();
      if (!name || !macroDefinition) return '';

      const parameters = parseDuckDBParameterNames(parametersRaw).join(', ');
      const qualifiedName = schema ? `${schema}.${name}` : name;
      const isTableMacro = !macroDefinition.startsWith('(');
      if (isTableMacro) {
          return `CREATE OR REPLACE MACRO ${qualifiedName}(${parameters}) AS TABLE ${macroDefinition};`;
      }
      return `CREATE OR REPLACE MACRO ${qualifiedName}(${parameters}) AS ${macroDefinition};`;
  };

  const buildShowViewQueries = (dialect: string, viewName: string, dbName: string, viewKind?: string): string[] => {
      const { schema, name } = parseSchemaAndName(viewName);
      const safeName = escapeSQLLiteral(name);
      const safeDbName = escapeSQLLiteral(dbName);

      switch (dialect) {
          case 'mysql':
          case 'starrocks':
              if (dialect === 'starrocks' && viewKind === 'materialized') {
                  const mvRef = schema
                      ? `\`${schema.replace(/`/g, '``')}\`.\`${name.replace(/`/g, '``')}\``
                      : `\`${name.replace(/`/g, '``')}\``;
                  return [
                      `SHOW CREATE MATERIALIZED VIEW ${mvRef}`,
                      `SHOW CREATE TABLE ${mvRef}`,
                  ];
              }
              return [
                  `SHOW CREATE VIEW \`${name.replace(/`/g, '``')}\``,
                  safeDbName
                      ? `SELECT VIEW_DEFINITION AS view_definition FROM information_schema.views WHERE table_schema = '${safeDbName}' AND table_name = '${safeName}' LIMIT 1`
                      : '',
                  `SHOW CREATE TABLE \`${name.replace(/`/g, '``')}\``,
              ].filter(Boolean);
          case 'postgres':
          case 'kingbase':
          case 'highgo':
          case 'vastbase':
          case 'opengauss':
          case 'gaussdb': {
              const schemaRef = schema || 'public';
              return [`SELECT pg_get_viewdef('${escapeSQLLiteral(schemaRef)}.${safeName}'::regclass, true) AS view_definition`];
          }
          case 'sqlserver':
              return buildSqlServerObjectDefinitionQueries('view', viewName, dbName, 'view_definition');
          case 'oracle':
          case 'dm':
              if (schema) {
                  return [`SELECT TEXT AS view_definition FROM ALL_VIEWS WHERE OWNER = '${escapeSQLLiteral(schema).toUpperCase()}' AND VIEW_NAME = '${safeName.toUpperCase()}'`];
              }
              if (safeDbName) {
                  return [`SELECT TEXT AS view_definition FROM ALL_VIEWS WHERE OWNER = '${safeDbName.toUpperCase()}' AND VIEW_NAME = '${safeName.toUpperCase()}'`];
              }
              return [`SELECT TEXT AS view_definition FROM USER_VIEWS WHERE VIEW_NAME = '${safeName.toUpperCase()}'`];
          case 'sqlite':
              return [`SELECT sql AS view_definition FROM sqlite_master WHERE type='view' AND name='${safeName}'`];
          case 'duckdb': {
              const schemaRef = schema || 'main';
              return [`SELECT view_definition FROM information_schema.views WHERE table_schema = '${escapeSQLLiteral(schemaRef)}' AND table_name = '${safeName}' LIMIT 1`];
          }
          default:
              return [`-- ${t('definition_viewer.editor.unsupported_view_definition')}`];
      }
  };

  const buildShowRoutineQueries = (dialect: string, routineName: string, routineType: string, dbName: string): string[] => {
      const { schema, name } = parseSchemaAndName(routineName);
      const safeName = escapeSQLLiteral(name);
      const safeDbName = escapeSQLLiteral(dbName);
      const upperType = (routineType || 'FUNCTION').toUpperCase();

      switch (dialect) {
          case 'mysql':
          case 'starrocks':
              return [
                  `SHOW CREATE ${upperType} \`${name.replace(/`/g, '``')}\``,
                  safeDbName
                      ? `SELECT ROUTINE_DEFINITION AS routine_definition, ROUTINE_TYPE AS routine_type FROM information_schema.routines WHERE routine_schema = '${safeDbName}' AND routine_name = '${safeName}' LIMIT 1`
                      : '',
                  upperType === 'PROCEDURE'
                      ? `SHOW PROCEDURE STATUS LIKE '${safeName}'`
                      : `SHOW FUNCTION STATUS LIKE '${safeName}'`,
              ].filter(Boolean);
          case 'postgres':
          case 'kingbase':
          case 'highgo':
          case 'vastbase':
          case 'opengauss':
          case 'gaussdb': {
              const schemaRef = schema || 'public';
              return [buildPgRoutineDefinitionQuery(dialect, escapeSQLLiteral(schemaRef), safeName)];
          }
          case 'sqlserver':
              return buildSqlServerObjectDefinitionQueries('routine', routineName, dbName, 'routine_definition');
          case 'oracle':
          case 'dm': {
              const owner = schema ? escapeSQLLiteral(schema).toUpperCase() : (safeDbName ? safeDbName.toUpperCase() : '');
              if (owner) {
                  return [`SELECT TEXT FROM ALL_SOURCE WHERE OWNER = '${owner}' AND NAME = '${safeName.toUpperCase()}' AND TYPE = '${upperType}' ORDER BY LINE`];
              }
              return [`SELECT TEXT FROM USER_SOURCE WHERE NAME = '${safeName.toUpperCase()}' AND TYPE = '${upperType}' ORDER BY LINE`];
          }
          case 'duckdb': {
              const schemaRef = schema || 'main';
              const safeSchema = escapeSQLLiteral(schemaRef);
              return [
                  `SELECT schema_name, function_name, parameters, macro_definition FROM duckdb_functions() WHERE internal = false AND lower(function_type) = 'macro' AND schema_name = '${safeSchema}' AND function_name = '${safeName}' LIMIT 1`,
                  `SELECT schema_name, function_name, parameters, macro_definition FROM duckdb_functions() WHERE internal = false AND lower(function_type) = 'macro' AND function_name = '${safeName}' ORDER BY CASE WHEN schema_name = '${safeSchema}' THEN 0 ELSE 1 END, schema_name LIMIT 1`,
              ];
          }
          case 'sqlite':
              return [`-- ${t('definition_viewer.editor.unsupported_sqlite_routine_definition')}`];
          default:
              return [`-- ${t('definition_viewer.editor.unsupported_routine_definition')}`];
      }
  };

  const buildShowEventQueries = (dialect: string, eventName: string, dbName: string): string[] => {
      const { schema, name } = parseSchemaAndName(eventName);
      const safeName = escapeSQLLiteral(name);
      const safeSchema = escapeSQLLiteral(schema || dbName);
      const eventRef = schema
          ? `\`${schema.replace(/`/g, '``')}\`.\`${name.replace(/`/g, '``')}\``
          : `\`${name.replace(/`/g, '``')}\``;

      switch (dialect) {
          case 'mysql':
              return [
                  `SHOW CREATE EVENT ${eventRef}`,
                  safeSchema
                      ? `SELECT EVENT_SCHEMA AS schema_name, EVENT_NAME AS event_name, EVENT_DEFINITION AS event_definition, EVENT_TYPE AS event_type, EXECUTE_AT AS execute_at, INTERVAL_VALUE AS interval_value, INTERVAL_FIELD AS interval_field, STARTS AS starts, ENDS AS ends, STATUS AS status, ON_COMPLETION AS on_completion, EVENT_COMMENT AS event_comment FROM information_schema.events WHERE event_schema = '${safeSchema}' AND event_name = '${safeName}' LIMIT 1`
                      : '',
              ].filter(Boolean);
          default:
              return [`-- ${t('definition_viewer.editor.unsupported_event_definition')}`];
      }
  };

  const buildShowSequenceQueries = (dialect: string, sequenceName: string, dbName: string): string[] => {
      const { schema, name } = parseSchemaAndName(sequenceName);
      const safeName = escapeSQLLiteral(name);
      const safeDbName = escapeSQLLiteral(dbName);
      const owner = schema ? escapeSQLLiteral(schema).toUpperCase() : (safeDbName ? safeDbName.toUpperCase() : '');

      switch (dialect) {
          case 'oracle':
          case 'dm':
              if (owner) {
                  return [`SELECT SEQUENCE_OWNER, SEQUENCE_NAME, MIN_VALUE, MAX_VALUE, INCREMENT_BY, CYCLE_FLAG, ORDER_FLAG, CACHE_SIZE, LAST_NUMBER FROM ALL_SEQUENCES WHERE SEQUENCE_OWNER = '${owner}' AND SEQUENCE_NAME = '${safeName.toUpperCase()}'`];
              }
              return [`SELECT SEQUENCE_NAME, MIN_VALUE, MAX_VALUE, INCREMENT_BY, CYCLE_FLAG, ORDER_FLAG, CACHE_SIZE, LAST_NUMBER FROM USER_SEQUENCES WHERE SEQUENCE_NAME = '${safeName.toUpperCase()}'`];
          case 'postgres':
          case 'kingbase':
          case 'highgo':
          case 'vastbase':
          case 'opengauss':
          case 'gaussdb': {
              const schemaRef = schema || 'public';
              return [`SELECT sequence_schema, sequence_name, data_type, start_value, minimum_value, maximum_value, increment FROM information_schema.sequences WHERE sequence_schema = '${escapeSQLLiteral(schemaRef)}' AND sequence_name = '${safeName}' LIMIT 1`];
          }
          default:
              return [`-- ${t('definition_viewer.editor.unsupported_sequence_definition')}`];
      }
  };

  const buildShowPackageQueries = (dialect: string, packageName: string, dbName: string): string[] => {
      const { schema, name } = parseSchemaAndName(packageName);
      const safeName = escapeSQLLiteral(name);
      const safeDbName = escapeSQLLiteral(dbName);

      switch (dialect) {
          case 'oracle':
          case 'dm': {
              const owner = schema ? escapeSQLLiteral(schema).toUpperCase() : (safeDbName ? safeDbName.toUpperCase() : '');
              if (owner) {
                  return [
                      `SELECT TEXT FROM ALL_SOURCE WHERE OWNER = '${owner}' AND NAME = '${safeName.toUpperCase()}' AND TYPE = 'PACKAGE' ORDER BY LINE`,
                      `SELECT TEXT FROM ALL_SOURCE WHERE OWNER = '${owner}' AND NAME = '${safeName.toUpperCase()}' AND TYPE = 'PACKAGE BODY' ORDER BY LINE`,
                  ];
              }
              return [
                  `SELECT TEXT FROM USER_SOURCE WHERE NAME = '${safeName.toUpperCase()}' AND TYPE = 'PACKAGE' ORDER BY LINE`,
                  `SELECT TEXT FROM USER_SOURCE WHERE NAME = '${safeName.toUpperCase()}' AND TYPE = 'PACKAGE BODY' ORDER BY LINE`,
              ];
          }
          default:
              return [`-- ${t('definition_viewer.editor.unsupported_package_definition')}`];
      }
  };

  const runQueryCandidates = async (
      config: Record<string, any>,
      dbName: string,
      queries: string[]
  ): Promise<{ success: boolean; data: any[]; message?: string }> => {
      let lastMessage = '';
      let hasSuccessfulQuery = false;
      for (const query of queries) {
          const sql = String(query || '').trim();
          if (!sql) continue;
          try {
              const result = await DBQuery(buildRpcConnectionConfig(config) as any, dbName, sql);
              if (!result.success || !Array.isArray(result.data)) {
                  lastMessage = result.message || lastMessage;
                  continue;
              }
              hasSuccessfulQuery = true;
              if (result.data.length > 0) {
                  return { success: true, data: result.data };
              }
          } catch (error: any) {
              lastMessage = error?.message || String(error);
          }
      }
      if (hasSuccessfulQuery) {
          return { success: true, data: [] };
      }
      return { success: false, data: [], message: lastMessage };
  };

  const runQueryCandidatesCollectAll = async (
      config: Record<string, any>,
      dbName: string,
      queries: string[]
  ): Promise<{ success: boolean; data: any[]; message?: string }> => {
      let lastMessage = '';
      let hasSuccessfulQuery = false;
      const data: any[] = [];
      for (const query of queries) {
          const sql = String(query || '').trim();
          if (!sql) continue;
          try {
              const result = await DBQuery(buildRpcConnectionConfig(config) as any, dbName, sql);
              if (!result.success || !Array.isArray(result.data)) {
                  lastMessage = result.message || lastMessage;
                  continue;
              }
              hasSuccessfulQuery = true;
              data.push(...result.data);
          } catch (error: any) {
              lastMessage = error?.message || String(error);
          }
      }
      if (hasSuccessfulQuery) {
          return { success: true, data };
      }
      return { success: false, data: [], message: lastMessage };
  };

  const getVersionHint = async (config: Record<string, any>, dbName: string): Promise<string> => {
      const candidates = [
          `SELECT VERSION() AS version`,
          `SHOW VARIABLES LIKE 'version'`,
      ];
      for (const query of candidates) {
          try {
              const result = await DBQuery(buildRpcConnectionConfig(config) as any, dbName, query);
              if (!result.success || !Array.isArray(result.data) || result.data.length === 0) {
                  continue;
              }
              const row = result.data[0] as Record<string, any>;
              const version =
                  row.version
                  || row.VERSION
                  || row.Value
                  || row.value
                  || Object.values(row)[1]
                  || Object.values(row)[0];
              const text = String(version || '').trim();
              if (text) return text;
          } catch {
              // ignore
          }
      }
      return '';
  };

  const extractViewDefinition = (dialect: string, data: any[]): string => {
      if (!data || data.length === 0) return `-- ${t('definition_viewer.editor.view_definition_not_found')}`;
      const row = data[0];

      switch (dialect) {
          case 'mysql':
          case 'starrocks': {
              const keys = Object.keys(row);
              const textDefinition = row.view_definition || row.VIEW_DEFINITION;
              if (textDefinition) return normalizeMySQLViewDDL(textDefinition);
              const sqlKey = keys.find(k => k.toLowerCase().includes('create view') || k.toLowerCase() === 'create view');
              if (sqlKey) return normalizeMySQLViewDDL(row[sqlKey]);
              const tableSqlKey = keys.find(k => k.toLowerCase().includes('create table'));
              if (tableSqlKey) return normalizeMySQLViewDDL(row[tableSqlKey]);
              for (const key of keys) {
                  const val = String(row[key] || '');
                  if (val.toUpperCase().includes('CREATE') && (val.toUpperCase().includes('VIEW') || val.toUpperCase().includes('TABLE'))) {
                      return normalizeMySQLViewDDL(val);
                  }
              }
              return JSON.stringify(row, null, 2);
          }
          case 'oracle':
          case 'dm':
              return row.view_definition || row.VIEW_DEFINITION || row.text || row.TEXT || Object.values(row)[0] || '';
          case 'sqlserver': {
              const directDefinition = getCaseInsensitiveRawValue(row, ['view_definition', 'definition']);
              if (directDefinition !== undefined && directDefinition !== null && String(directDefinition).trim() !== '') {
                  return String(directDefinition);
              }
              const helpTextDefinition = data
                  .map((item) => getCaseInsensitiveRawValue(item, ['Text', 'text']))
                  .filter((value) => value !== undefined && value !== null)
                  .map((value) => String(value))
                  .join('');
              if (helpTextDefinition.trim()) return helpTextDefinition;
              return String(Object.values(row)[0] || '');
          }
          default:
              return row.view_definition || row.VIEW_DEFINITION || row.sql || row.SQL || Object.values(row)[0] || '';
      }
  };
  return {
    loading, setLoading, error, setError, definition, setDefinition, openingObjectEdit,
    setOpeningObjectEdit, isMountedRef, loadedDefinitionKeyRef, editorRef, connections, addTab,
    setActiveContext, darkMode, t, objectIdentityKey, getMetadataDialect, isSphinxConnection,
    getCaseInsensitiveRawValue, buildDuckDBMacroDDL, buildShowViewQueries, buildShowRoutineQueries,
    buildShowEventQueries, buildShowSequenceQueries, buildShowPackageQueries, runQueryCandidates,
    runQueryCandidatesCollectAll, getVersionHint, extractViewDefinition,
  };
};

export type DefinitionViewerStateApi = ReturnType<typeof useDefinitionViewerState>;
