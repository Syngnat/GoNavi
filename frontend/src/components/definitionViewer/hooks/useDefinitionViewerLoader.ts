import { useEffect, useCallback } from 'react';
import {
  buildOracleDatabaseLinkDefinitionQueries,
  extractOracleDatabaseLinkDefinition,
} from '../../databaseLinkDefinition';
import { DBShowCreateTable } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { buildDisplayDefinitionSql } from '../definitionViewerSql';
import { formatDdlForDisplay } from '../../../utils/ddlFormat';
import { resolveDefinitionViewerObjectMeta } from '../../definitionViewerObjectMeta';
import { usesDriverObjectDefinition, usesDriverSequenceDefinition, usesBackendViewDefinition } from '../../definitionViewerDialect';
import type { DefinitionViewerStateApi } from './useDefinitionViewerState';
import type { DefinitionViewerProps } from '../../DefinitionViewer';

export interface UseDefinitionViewerLoaderInput {
  t: DefinitionViewerStateApi['t'];
  buildDuckDBMacroDDL: DefinitionViewerStateApi['buildDuckDBMacroDDL'];
  getCaseInsensitiveRawValue: DefinitionViewerStateApi['getCaseInsensitiveRawValue'];
  tab: DefinitionViewerProps['tab'];
  connections: DefinitionViewerStateApi['connections'];
  getMetadataDialect: DefinitionViewerStateApi['getMetadataDialect'];
  isSphinxConnection: DefinitionViewerStateApi['isSphinxConnection'];
  buildShowViewQueries: DefinitionViewerStateApi['buildShowViewQueries'];
  extractViewDefinition: DefinitionViewerStateApi['extractViewDefinition'];
  buildShowEventQueries: DefinitionViewerStateApi['buildShowEventQueries'];
  buildShowSequenceQueries: DefinitionViewerStateApi['buildShowSequenceQueries'];
  buildShowPackageQueries: DefinitionViewerStateApi['buildShowPackageQueries'];
  buildShowRoutineQueries: DefinitionViewerStateApi['buildShowRoutineQueries'];
  runQueryCandidatesCollectAll: DefinitionViewerStateApi['runQueryCandidatesCollectAll'];
  runQueryCandidates: DefinitionViewerStateApi['runQueryCandidates'];
  getVersionHint: DefinitionViewerStateApi['getVersionHint'];
  setLoading: DefinitionViewerStateApi['setLoading'];
  setError: DefinitionViewerStateApi['setError'];
  loadedDefinitionKeyRef: DefinitionViewerStateApi['loadedDefinitionKeyRef'];
  objectIdentityKey: DefinitionViewerStateApi['objectIdentityKey'];
  setDefinition: DefinitionViewerStateApi['setDefinition'];
  isMountedRef: DefinitionViewerStateApi['isMountedRef'];
  definition: DefinitionViewerStateApi['definition'];
  editorRef: DefinitionViewerStateApi['editorRef'];
}

export const useDefinitionViewerLoader = ({
  t, buildDuckDBMacroDDL, getCaseInsensitiveRawValue, tab, connections, getMetadataDialect,
  isSphinxConnection, buildShowViewQueries, extractViewDefinition, buildShowEventQueries,
  buildShowSequenceQueries, buildShowPackageQueries, buildShowRoutineQueries,
  runQueryCandidatesCollectAll, runQueryCandidates, getVersionHint, setLoading, setError,
  loadedDefinitionKeyRef, objectIdentityKey, setDefinition, isMountedRef, definition, editorRef,
}: UseDefinitionViewerLoaderInput) => {
  const extractRoutineDefinition = (dialect: string, data: any[]): string => {
      if (!data || data.length === 0) return `-- ${t('definition_viewer.editor.routine_definition_not_found')}`;

      switch (dialect) {
          case 'mysql':
          case 'starrocks': {
              const row = data[0];
              const keys = Object.keys(row);
              if (row.routine_definition || row.ROUTINE_DEFINITION) {
                  return String(row.routine_definition || row.ROUTINE_DEFINITION);
              }
              const sqlKey = keys.find(k => k.toLowerCase().includes('create function') || k.toLowerCase().includes('create procedure'));
              if (sqlKey) return row[sqlKey];
              for (const key of keys) {
                  const val = String(row[key] || '');
                  if (val.toUpperCase().includes('CREATE') && (val.toUpperCase().includes('FUNCTION') || val.toUpperCase().includes('PROCEDURE'))) {
                      return val;
                  }
              }
              const routineName = String(row.Name || row.name || '').trim();
              if (routineName) {
                  const routineType = String(row.Type || row.type || row.ROUTINE_TYPE || row.routine_type || 'FUNCTION').trim().toUpperCase();
                  return `-- ${t('definition_viewer.editor.metadata_fallback.header')}\n-- ${t('definition_viewer.editor.metadata_fallback.name_label')}: ${routineName}\n-- ${t('definition_viewer.editor.metadata_fallback.type_label')}: ${routineType}\n${JSON.stringify(row, null, 2)}`;
              }
              return JSON.stringify(row, null, 2);
          }
          case 'oracle':
          case 'dm': {
              // Oracle/DM ALL_SOURCE returns multiple rows, one per line
              return data.map(row => row.text || row.TEXT || Object.values(row)[0] || '').join('');
          }
          case 'duckdb': {
              const row = data[0] as Record<string, any>;
              const ddl = buildDuckDBMacroDDL(
                  String(getCaseInsensitiveRawValue(row, ['schema_name']) || '').trim(),
                  String(getCaseInsensitiveRawValue(row, ['function_name', 'routine_name', 'name']) || '').trim(),
                  getCaseInsensitiveRawValue(row, ['parameters']),
                  getCaseInsensitiveRawValue(row, ['macro_definition'])
              );
              if (ddl) return ddl;
              const fallback = getCaseInsensitiveRawValue(row, ['macro_definition', 'routine_definition', 'definition']);
              if (fallback !== undefined && fallback !== null && String(fallback).trim() !== '') {
                  return String(fallback);
              }
              return JSON.stringify(row, null, 2);
          }
          case 'sqlserver': {
              const directDefinition = getCaseInsensitiveRawValue(data[0], ['routine_definition', 'definition']);
              if (directDefinition !== undefined && directDefinition !== null && String(directDefinition).trim() !== '') {
                  return String(directDefinition);
              }
              const helpTextDefinition = data
                  .map((row) => getCaseInsensitiveRawValue(row, ['Text', 'text']))
                  .filter((value) => value !== undefined && value !== null)
                  .map((value) => String(value))
                  .join('');
              if (helpTextDefinition.trim()) return helpTextDefinition;
              return String(Object.values(data[0])[0] || '');
          }
          default: {
              const row = data[0];
              return row.routine_definition || row.ROUTINE_DEFINITION || Object.values(row)[0] || '';
          }
      }
  };

  const extractEventDefinition = (dialect: string, data: any[]): string => {
      if (!data || data.length === 0) return `-- ${t('definition_viewer.editor.event_definition_not_found')}`;

      switch (dialect) {
          case 'mysql': {
              const row = data[0];
              const keys = Object.keys(row);
              const sqlKey = keys.find(k => k.toLowerCase().includes('create event'));
              if (sqlKey && row[sqlKey]) return String(row[sqlKey]);

              const definition = row.event_definition || row.EVENT_DEFINITION;
              const eventName = row.event_name || row.EVENT_NAME || row.Name || row.name;
              if (definition && eventName) {
                  return `-- ${t('definition_viewer.editor.event_fragment_fallback.header')}\n-- ${t('definition_viewer.editor.metadata_fallback.name_label')}: ${eventName}\n${String(definition)}`;
              }
              return JSON.stringify(row, null, 2);
          }
          default: {
              const row = data[0];
              return row.event_definition || row.EVENT_DEFINITION || Object.values(row)[0] || '';
          }
      }
  };

  const buildSequenceDefinitionFromRow = (row: Record<string, any>): string => {
      const sequenceName = String(getCaseInsensitiveRawValue(row, ['sequence_name']) || '').trim();
      const owner = String(getCaseInsensitiveRawValue(row, ['sequence_owner', 'owner', 'sequence_schema']) || '').trim();
      const name = owner && sequenceName ? `${owner}.${sequenceName}` : sequenceName;
      if (!name) return JSON.stringify(row, null, 2);

      const clauses: string[] = [];
      const increment = getCaseInsensitiveRawValue(row, ['increment_by', 'increment']);
      const minValue = getCaseInsensitiveRawValue(row, ['min_value', 'minimum_value']);
      const maxValue = getCaseInsensitiveRawValue(row, ['max_value', 'maximum_value']);
      const cacheSize = Number(getCaseInsensitiveRawValue(row, ['cache_size']));
      const cycleFlag = String(getCaseInsensitiveRawValue(row, ['cycle_flag']) || '').trim().toUpperCase();
      const orderFlag = String(getCaseInsensitiveRawValue(row, ['order_flag']) || '').trim().toUpperCase();

      if (increment !== undefined && increment !== null && String(increment).trim() !== '') {
          clauses.push(`INCREMENT BY ${increment}`);
      }
      if (minValue !== undefined && minValue !== null && String(minValue).trim() !== '') {
          clauses.push(`MINVALUE ${minValue}`);
      }
      if (maxValue !== undefined && maxValue !== null && String(maxValue).trim() !== '') {
          clauses.push(`MAXVALUE ${maxValue}`);
      }
      if (Number.isFinite(cacheSize)) {
          clauses.push(cacheSize > 0 ? `CACHE ${cacheSize}` : 'NOCACHE');
      }
      if (cycleFlag) clauses.push(cycleFlag === 'Y' ? 'CYCLE' : 'NOCYCLE');
      if (orderFlag) clauses.push(orderFlag === 'Y' ? 'ORDER' : 'NOORDER');

      return [`CREATE SEQUENCE ${name}`, ...clauses.map((clause) => `  ${clause}`)].join('\n') + ';';
  };

  const extractSequenceDefinition = (dialect: string, data: any[]): string => {
      if (!data || data.length === 0) return `-- ${t('definition_viewer.editor.sequence_definition_not_found')}`;
      switch (dialect) {
          case 'oracle':
          case 'dm':
          case 'postgres':
          case 'kingbase':
          case 'highgo':
          case 'vastbase':
          case 'opengauss':
          case 'gaussdb':
              return buildSequenceDefinitionFromRow(data[0] as Record<string, any>);
          default:
              return JSON.stringify(data[0], null, 2);
      }
  };

  const extractPackageDefinition = (dialect: string, data: any[]): string => {
      if (!data || data.length === 0) return `-- ${t('definition_viewer.editor.package_definition_not_found')}`;
      switch (dialect) {
          case 'oracle':
          case 'dm':
              return data.map(row => row.text || row.TEXT || Object.values(row)[0] || '').join('');
          default:
              return JSON.stringify(data[0], null, 2);
      }
  };

  const loadDefinition = async (): Promise<{ success: boolean; definition?: string; error?: string }> => {
      const conn = connections.find(c => c.id === tab.connectionId);
      if (!conn) {
          return { success: false, error: t('definition_viewer.error.connection_not_found') };
      }

      const dbName = tab.dbName || '';
      const dialect = getMetadataDialect(conn);
      const sphinxLike = isSphinxConnection(conn) && dialect === 'mysql';

      let queries: string[];
      let extractFn: (dialect: string, data: any[]) => string;
      let resolvedObjectLabel: string;
      let resolvedObjectName = '';
      let backendRoutine = false;

      if (tab.type === 'view-def') {
          const viewName = tab.viewName || '';
          if (!viewName) {
              return { success: false, error: t('definition_viewer.error.view_name_empty') };
          }
          queries = buildShowViewQueries(dialect, viewName, dbName, tab.viewKind);
          extractFn = extractViewDefinition;
          resolvedObjectLabel = tab.viewKind === 'materialized'
              ? t('definition_viewer.object.materialized_view')
              : t('definition_viewer.object.view');
          resolvedObjectName = viewName;
      } else if (tab.type === 'event-def') {
          const eventName = tab.eventName || '';
          if (!eventName) {
              return { success: false, error: t('definition_viewer.error.event_name_empty') };
          }
          queries = buildShowEventQueries(dialect, eventName, dbName);
          extractFn = extractEventDefinition;
          resolvedObjectLabel = t('definition_viewer.object.event');
          resolvedObjectName = eventName;
      } else if (tab.type === 'sequence-def') {
          const sequenceName = tab.sequenceName || '';
          if (!sequenceName) {
              return { success: false, error: t('definition_viewer.error.sequence_name_empty') };
          }
          queries = buildShowSequenceQueries(dialect, sequenceName, dbName);
          backendRoutine = usesDriverSequenceDefinition(conn, queries);
          extractFn = extractSequenceDefinition;
          resolvedObjectLabel = t('definition_viewer.object.sequence');
          resolvedObjectName = sequenceName;
      } else if (tab.type === 'package-def') {
          const packageName = tab.packageName || '';
          if (!packageName) {
              return { success: false, error: t('definition_viewer.error.package_name_empty') };
          }
          queries = buildShowPackageQueries(dialect, packageName, dbName);
          backendRoutine = usesDriverObjectDefinition(conn);
          extractFn = extractPackageDefinition;
          resolvedObjectLabel = t('definition_viewer.object.package');
          resolvedObjectName = packageName;
      } else if (tab.type === 'database-link-def') {
          const databaseLinkName = String(tab.databaseLinkName || '').trim();
          if (!databaseLinkName) {
              return { success: false, error: t('definition_viewer.error.database_link_name_empty') };
          }
          queries = dialect === 'oracle'
              ? buildOracleDatabaseLinkDefinitionQueries(databaseLinkName, String(tab.schemaName || dbName || ''))
              : [`-- ${t('definition_viewer.editor.unsupported_database_link_definition')}`];
          extractFn = (_dialect, data) => extractOracleDatabaseLinkDefinition(data, databaseLinkName, String(tab.schemaName || dbName || ''), {
              notFoundComment: t('definition_viewer.editor.database_link_definition_not_found'),
              passwordUnavailableComment: t('definition_viewer.editor.database_link_password_unavailable'),
          });
          resolvedObjectLabel = t('definition_viewer.object.database_link');
          resolvedObjectName = databaseLinkName;
      } else {
          const routineName = tab.routineName || '';
          const routineType = tab.routineType || 'FUNCTION';
          if (!routineName) {
              return { success: false, error: t('definition_viewer.error.routine_name_empty') };
          }
          queries = buildShowRoutineQueries(dialect, routineName, routineType, dbName);
          backendRoutine = usesDriverObjectDefinition(conn);
          extractFn = extractRoutineDefinition;
          resolvedObjectLabel = t('definition_viewer.object.routine');
          resolvedObjectName = routineName;
      }

      const backendView = tab.type === 'view-def' && usesBackendViewDefinition(conn, dialect);
      if ((!queries.length || String(queries[0] || '').startsWith('--')) && !backendView && !backendRoutine) {
          return {
              success: true,
              definition: String(
                  queries[0] || `-- ${t('definition_viewer.editor.unsupported_object_definition')}`,
              ),
          };
      }

      try {
          const config = {
              ...conn.config,
              port: Number(conn.config.port),
              password: conn.config.password || '',
              database: conn.config.database || '',
              useSSH: conn.config.useSSH || false,
              ssh: conn.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' }
          };

          if (backendRoutine) {
              // 自有方言的描述表数据源（如 GBase 8s 的 SPL 例程）由驱动按对象名给出原文，不做 SQL 格式化。
              const result = await DBShowCreateTable(buildRpcConnectionConfig(config) as any, dbName, resolvedObjectName);
              return result.success && String(result.data || '').trim()
                  ? { success: true, definition: String(result.data) }
                  : { success: false, error: result.message || t('definition_viewer.error.query_failed') };
          }

          if (backendView) {
              const result = await DBShowCreateTable(
                  buildRpcConnectionConfig(config) as any,
                  dbName,
                  resolvedObjectName,
              );
              if (result.success && String(result.data || '').trim()) {
                  const displayDefinition = buildDisplayDefinitionSql(
                      tab,
                      String(result.data),
                      resolvedObjectName,
                  );
                  return {
                      success: true,
                      definition: formatDdlForDisplay(displayDefinition, dialect, {
                          oceanBaseProtocol: conn?.config?.oceanBaseProtocol,
                      }),
                  };
              }
              return {
                  success: false,
                  error: result.message || t('definition_viewer.error.query_failed'),
              };
          }

          const result = tab.type === 'package-def'
              ? await runQueryCandidatesCollectAll(config, dbName, queries)
              : await runQueryCandidates(config, dbName, queries);

          if (result.success && Array.isArray(result.data) && result.data.length > 0) {
              const rawDefinition = extractFn(dialect, result.data);
              const displayDefinition = buildDisplayDefinitionSql(tab, rawDefinition, resolvedObjectName);
              return {
                  success: true,
                  definition: displayDefinition,
              };
          }

          if (result.success) {
              if (sphinxLike) {
                  const version = await getVersionHint(config, dbName);
                  const versionText = version
                      ? t('definition_viewer.editor.sphinx.version_suffix', { version })
                      : '';
                  return {
                      success: true,
                      definition: `-- ${t('definition_viewer.editor.sphinx.empty_result', {
                          version: versionText,
                          object: resolvedObjectLabel,
                      })}\n-- ${t('definition_viewer.editor.sphinx.compat_queries_hint')}`,
                  };
              }
              return {
                  success: true,
                  definition: `-- ${t('definition_viewer.editor.object_definition_not_found', {
                      object: resolvedObjectLabel,
                  })}`,
              };
          }

          if (sphinxLike) {
              const version = await getVersionHint(config, dbName);
              const versionText = version
                  ? t('definition_viewer.editor.sphinx.version_suffix', { version })
                  : '';
              const failedMessage = result.message
                  ? `${t('definition_viewer.editor.sphinx.failed_message_label')}: ${result.message}`
                  : t('definition_viewer.editor.sphinx.failed_message_unknown');
              return {
                  success: true,
                  definition: `-- ${t('definition_viewer.editor.sphinx.unsupported_query', {
                      version: versionText,
                      object: resolvedObjectLabel,
                  })}\n-- ${failedMessage}`,
              };
          }

          return {
              success: false,
              error: result.message || t('definition_viewer.error.query_failed'),
          };
      } catch (e: any) {
          return {
              success: false,
              error: t('definition_viewer.error.query_failed_detail', {
                  detail: e?.message || String(e),
              }),
          };
      }
  };

  useEffect(() => {
      let cancelled = false;
      const syncDefinition = async () => {
          setLoading(true);
          setError(null);
          const result = await loadDefinition();
          if (cancelled) {
              return;
          }
          if (result.success) {
              loadedDefinitionKeyRef.current = objectIdentityKey;
              setDefinition(String(result.definition || ''));
          } else {
              setError(result.error || t('definition_viewer.error.query_failed'));
          }
          setLoading(false);
      };

      syncDefinition();

      return () => {
          cancelled = true;
      };
  }, [tab.connectionId, tab.dbName, tab.viewName, tab.viewKind, tab.eventName, tab.routineName, tab.routineType, tab.sequenceName, tab.packageName, tab.databaseLinkName, tab.schemaName, tab.type, connections, objectIdentityKey, t]);

  useEffect(() => () => {
      isMountedRef.current = false;
  }, []);

  const { label: objectLabel, name: objectName, loadingTip } = resolveDefinitionViewerObjectMeta(tab, t);
  const normalizedObjectName = String(objectName || '').trim();
  const displayedDefinition = loadedDefinitionKeyRef.current === objectIdentityKey ? definition : '';
  const hasDefinition = String(displayedDefinition || '').trim() !== '';
  const editTabTitle = t('definition_viewer.edit.tab_title', {
      object: objectLabel,
      name: normalizedObjectName,
  });
  const editableDefinitionCopy = {
      commentTitle: t('definition_viewer.edit.comment_title', {
          object: objectLabel,
          name: normalizedObjectName,
      }),
      compatibilityHint: t('definition_viewer.edit.comment_compatibility'),
      emptyDefinitionHint: t('definition_viewer.edit.comment_empty_definition', {
          name: normalizedObjectName,
      }),
  };
  const editorModelPath = `gonavi-definition://${encodeURIComponent(objectIdentityKey)}`;
  const currentDefinition = loadedDefinitionKeyRef.current === objectIdentityKey ? String(definition || '') : '';

  const refreshEditorLayout = useCallback(() => {
      const editor = editorRef.current;
      if (!editor) {
          return;
      }

      const run = () => {
          editor.layout?.();
          editor.render?.();
          editor.setScrollTop?.(0);
          editor.setScrollLeft?.(0);
      };

      if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => run());
          return;
      }

      setTimeout(run, 0);
  }, []);

  const handleEditorMount = useCallback((editor: any) => {
      editorRef.current = editor;
      refreshEditorLayout();
  }, [refreshEditorLayout]);

  useEffect(() => {
      if (!displayedDefinition) {
          return;
      }
      refreshEditorLayout();
  }, [displayedDefinition, refreshEditorLayout]);
  return {
    loadDefinition, objectLabel, objectName, loadingTip, normalizedObjectName, displayedDefinition,
    hasDefinition, editTabTitle, editableDefinitionCopy, editorModelPath, currentDefinition,
    handleEditorMount,
  };
};

export type DefinitionViewerLoaderApi = ReturnType<typeof useDefinitionViewerLoader>;
