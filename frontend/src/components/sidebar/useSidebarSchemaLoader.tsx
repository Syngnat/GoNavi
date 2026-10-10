import { useRef } from 'react';
import { message, Button } from 'antd';
import { DBGetTables, DBQuery } from '../../../wailsjs/go/app/App';
import type { SavedConnection } from '../../types';
import { useStore } from '../../store';
import { t } from '../../i18n';
import { GnFolderOpenIcon, GnSqlDocIcon } from '../icons/gnIcons';
import type { SidebarTreeNode } from './sidebarV2TreeNodes';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { buildMetadataDiscoveryScope } from '../../utils/metadataDiscoveryScope';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import { getSchemaVisibilityRule, isSchemaVisible } from '../../utils/schemaVisibility';
import { isRegistryHiddenSchema } from './sidebarRegistryObjectGroups';
import { loadSchemas, loadViews, loadFunctions, loadSequences, loadDatabaseTriggers, buildSidebarTableStatusSQL } from './sidebarMetadataLoaders';
import { createSidebarDatabaseChildrenBuilder } from './sidebarDatabaseChildren';
import { ensureTableStatsServerVersion } from './sidebarTableStatsVersion';
import { needsServerVersionForTableStats } from '../../utils/dataSourceRegistry/tableStats';
import { invalidateQueryEditorSessionMetadata } from '../queryEditor/metadata/queryEditorSessionMetadataStore';
import { buildConnectionReloadSignature, scheduleSidebarLoad, type SidebarTreeLoadOptions } from './sidebarTreeLoaderHelpers';
import type { UseSidebarTableLoaderInput, SidebarDatabaseObjectLoadResults } from './useSidebarTableLoader';
import { collectSidebarSubtreeKeys } from './sidebarV2TreeExpansion';
import { supportsSidebarSchemaLazyLoading, sidebarSchemaNodeKey, sidebarSchemaLoadKey, findSidebarSchemaTreeNode, buildSidebarSchemaTableEntries, preserveSidebarSchemaObjectChildren } from './sidebarSchemaLoading';

type SchemaConnection = SavedConnection & { dbName: string; schemaName?: string; groupKey?: string; schemaLazy?: boolean; schemaLoaded?: boolean };
type LoadNode = { key: React.Key; type?: string; dataRef: SchemaConnection; children?: SidebarTreeNode[] };
type LoadTables = (node: { key: React.Key; dataRef?: unknown; type?: string }, options?: SidebarTreeLoadOptions) => Promise<void>;
type Input = UseSidebarTableLoaderInput & {
  getTree?: () => SidebarTreeNode[];
  setExpandedKeys?: React.Dispatch<React.SetStateAction<React.Key[]>>;
  loadLegacyTables: (node: LoadNode, options?: SidebarTreeLoadOptions) => Promise<void>;
};
const emptyObjects = (): SidebarDatabaseObjectLoadResults => ({
  viewsResult: { views: [], supported: true }, materializedViewsResult: { views: [], supported: true },
  triggersResult: { triggers: [], supported: true }, routinesResult: { routines: [], supported: true },
  sequencesResult: { sequences: [], supported: true }, packagesResult: { packages: [], supported: true },
  eventsResult: { events: [], supported: true }, databaseLinksResult: { databaseLinks: [], supported: true },
});

type SchemaLoadTask = {
  input: Input; node: LoadNode; options: SidebarTreeLoadOptions; connection: SchemaConnection; schema: string;
  current: () => boolean; finish: () => void; queriesNode: SidebarTreeNode; loadTables: LoadTables;
  fail: (error: unknown) => void;
};

const loadSidebarSchemaContents = async (task: SchemaLoadTask) => {
  const { input, node, options, connection, schema, queriesNode, loadTables } = task;
  const { replaceTreeNodeChildren, setLoadedKeys, setConnectionStates } = input;
  const databaseKey = `${connection.id}-${connection.dbName}`;
  let failed = false;
  const current = () => !failed && task.current();
  if (options.ensureFresh) {
    const previous = input.getTree ? findSidebarSchemaTreeNode(input.getTree(), String(node.key)) : node;
    const clearedKeys = new Set([String(node.key), ...collectSidebarSubtreeKeys(previous)]);
    replaceTreeNodeChildren(node.key, undefined, { ...connection, groupKey: 'schema', schemaName: schema, schemaLazy: true });
    setLoadedKeys((keys) => keys.filter((key) => !clearedKeys.has(String(key))));
    invalidateQueryEditorSessionMetadata(connection.id, connection.dbName);
  }
  try {
    const scoped: SchemaConnection = { ...connection, schemaLazy: true, schemaVisibilityByDatabase: { ...connection.schemaVisibilityByDatabase, [connection.dbName]: { mode: 'include', schemas: [schema] } } };
    const rpcConfig = buildRpcConnectionConfig(connection.config, { metadataScope: buildMetadataDiscoveryScope(scoped, connection.dbName) });
    const result = await DBGetTables(rpcConfig, connection.dbName);
    if (!current()) return;
    if (!result.success) throw new Error(result.message);
    const tableRows = Array.isArray(result.data) ? result.data as Record<string, unknown>[] : [];
    let statusRows: Record<string, unknown>[] = [];
    let objects = emptyObjects();
    const publish = (notify = false) => {
      if (!current()) return;
      const builder = createSidebarDatabaseChildrenBuilder({
        schemasResult: { schemas: [schema], supported: true }, tableEntries: buildSidebarSchemaTableEntries(scoped, schema, tableRows, statusRows),
        conn: scoped, key: databaseKey, dbName: connection.dbName, node, loadTables,
        tableSortPreference: input.tableSortPreference, tableAccessCount: input.tableAccessCount, pinnedSidebarTables: input.pinnedSidebarTables, queriesNode,
      });
      const schemaNode = builder.buildRenderedDatabaseChildren(objects, notify).renderedDatabaseChildren.find((child) => String(child.key) === String(node.key));
      const previous = input.getTree ? findSidebarSchemaTreeNode(input.getTree(), String(node.key))?.children : node.children;
      if (schemaNode) replaceTreeNodeChildren(node.key, preserveSidebarSchemaObjectChildren(schemaNode.children || [], previous || []), { ...connection, groupKey: 'schema', schemaName: schema, schemaLazy: true, schemaLoaded: true });
      setConnectionStates((states) => ({ ...states, [String(node.key)]: 'success' }));
      input.onDatabaseTreeLoaded?.(databaseKey);
    };
    publish();
    if (result.partial || result.truncated) message.warning({ key: `schema-${node.key}-partial`, content: result.message });
    // Queue objects before expensive relation sizes on serial driver-agent transports.
    const objectTask = Promise.all([loadViews(scoped, connection.dbName), loadDatabaseTriggers(scoped, connection.dbName), loadFunctions(scoped, connection.dbName), loadSequences(scoped, connection.dbName)]).then(([viewsResult, triggersResult, routinesResult, sequencesResult]) => {
      objects = { ...objects, viewsResult, triggersResult, routinesResult, sequencesResult }; publish(true);
    });
    const statisticsTask = (async () => {
      const version = needsServerVersionForTableStats(connection.config.type) ? await ensureTableStatsServerVersion(connection) : '';
      if (!current()) return;
      const sql = buildSidebarTableStatusSQL(scoped, connection.dbName, version);
      if (!sql) return;
      const stats = await DBQuery(rpcConfig, connection.dbName, sql);
      if (!current()) return;
      if (stats.success && Array.isArray(stats.data) && stats.data.length) { statusRows = stats.data as Record<string, unknown>[]; publish(); }
    })().catch((error) => { if (current()) console.warn('GoNavi schema statistics failed', error); });
    await Promise.all([objectTask, statisticsTask]);
  } catch (error) { if (current()) task.fail(error); failed = true; }
  finally { task.finish(); }
};

export const useSidebarSchemaLoader = (input: Input) => {
  const databaseVersions = useRef(new Map<string, number>());
  const latestInput = useRef(input);
  latestInput.current = input;
  const { loadingNodesRef, tableLoadsRef, setConnectionStates, setLoadedKeys, replaceTreeNodeChildren } = input;
  const resolveConnection = (node: LoadNode): SchemaConnection => ({
    ...(useStore.getState().connections.find((connection) => connection.id === node.dataRef.id) || node.dataRef),
    dbName: node.dataRef.dbName,
  });
  const visible = (connection: SchemaConnection, schema: string) => {
    const options = { caseSensitive: getDataSourceCapabilities(connection.config).schemaIdentifierCaseSensitive };
    return isSchemaVisible(getSchemaVisibilityRule(connection, connection.dbName, options), schema, options)
      && !isRegistryHiddenSchema(connection, schema);
  };
  const queriesNode = (connection: SchemaConnection): SidebarTreeNode => {
    const queries = latestInput.current.savedQueries.filter((query) => query.connectionId === connection.id && query.dbName === connection.dbName);
    return { key: `${connection.id}-${connection.dbName}-queries`, title: t('sidebar.tree.saved_queries'), type: 'queries-folder', icon: <GnFolderOpenIcon />, isLeaf: queries.length === 0,
    children: queries.map((query) => ({
      key: query.id, title: input.resolveSavedQueryDisplayName(query.name), icon: <GnSqlDocIcon />, type: 'saved-query', dataRef: query, isLeaf: true,
    })) };
  };
  const fail = (node: LoadNode, error: unknown) => {
    setConnectionStates((states) => ({ ...states, [String(node.key)]: 'error' }));
    setLoadedKeys((keys) => keys.filter((key) => key !== node.key));
    const detail = error instanceof Error ? error.message : String(error);
    message.error({ key: `schema-${node.key}`, content: <span>{t('sidebar.message.load_table_list_failed', { error: detail })}<Button type="link" onClick={() => void loadTables(node, { ensureFresh: true })}>{t('common.retry')}</Button></span> });
  };
  const startLoad = (connection: SchemaConnection, loadKey: string, nodeKey: React.Key) => {
    const epoch = input.getConnectionLoadEpoch(connection.id);
    const generation = input.beginLoadGeneration(loadKey);
    const signature = buildConnectionReloadSignature(connection);
    const current = () => input.isCurrentConnectionLoadEpoch(connection.id, epoch)
      && input.isCurrentLoadGeneration(loadKey, generation)
      && buildConnectionReloadSignature(useStore.getState().connections.find((item) => item.id === connection.id) || connection) === signature;
    loadingNodesRef.current.add(loadKey);
    setConnectionStates((states) => ({ ...states, [String(nodeKey)]: 'loading' }));
    const finish = () => {
      if (!input.isCurrentLoadGeneration(loadKey, generation)) return;
      loadingNodesRef.current.delete(loadKey);
      if (!current()) setConnectionStates((states) => { const next = { ...states }; delete next[String(nodeKey)]; return next; });
    };
    return { current, finish };
  };

  const loadSchema = (node: LoadNode, options: SidebarTreeLoadOptions) => {
    const connection = resolveConnection(node);
    const schema = String(node.dataRef.schemaName || '');
    if (!schema || !visible(connection, schema)) return Promise.resolve();
    const databaseKey = `${connection.id}-${connection.dbName}`;
    const version = databaseVersions.current.get(databaseKey) || 0;
    const loadKey = sidebarSchemaLoadKey(connection.id, connection.dbName, schema);
    const lifecycle = startLoad(connection, loadKey, node.key);
    const current = () => lifecycle.current() && (databaseVersions.current.get(databaseKey) || 0) === version
      && (!input.getTree || !!findSidebarSchemaTreeNode(input.getTree(), String(node.key)));
    return loadSidebarSchemaContents({ input, node, options, connection, schema, current, finish: lifecycle.finish, queriesNode: queriesNode(connection), loadTables, fail: (error) => fail(node, error) });
  };

  const loadDatabase = async (node: LoadNode, options: SidebarTreeLoadOptions) => {
    const connection = resolveConnection(node);
    const databaseKey = `${connection.id}-${connection.dbName}`;
    const loadKey = `tables-${connection.id}-${connection.dbName}`;
    const lifecycle = startLoad(connection, loadKey, node.key);
    // Every database rebuild invalidates schema work that could overwrite the new placeholders.
    databaseVersions.current.set(databaseKey, (databaseVersions.current.get(databaseKey) || 0) + 1);
    const previous = input.getTree ? findSidebarSchemaTreeNode(input.getTree(), String(node.key)) : node;
    const schemaKeys = new Set((previous?.children || []).filter((child) => child.dataRef?.groupKey === 'schema').flatMap((child) => [String(child.key), ...collectSidebarSubtreeKeys(child)]));
    if (options.ensureFresh) {
      invalidateQueryEditorSessionMetadata(connection.id, connection.dbName);
      setLoadedKeys((keys) => keys.filter((key) => key !== node.key && !String(key).startsWith(`${databaseKey}-`)));
      replaceTreeNodeChildren(node.key, [queriesNode(connection)], connection);
    }
    try {
      const schemas = await loadSchemas(connection, connection.dbName, DBQuery, true);
      if (!lifecycle.current()) return;
      if (!schemas.supported) throw new Error(schemas.failureMessage || t('sidebar.message.load_table_list_failed', { error: '' }));
      const nodes: SidebarTreeNode[] = schemas.schemas.filter((schema) => visible(connection, schema)).map((schema) => ({
        key: sidebarSchemaNodeKey(databaseKey, schema), title: schema, icon: <GnFolderOpenIcon />, type: 'object-group', isLeaf: false,
        dataRef: { ...connection, schemaName: schema, groupKey: 'schema', schemaLazy: true, schemaLoaded: false },
      }));
      // Even persisted expansion keys wait for an explicit schema expansion after this database load.
      nodes.forEach((schema) => schemaKeys.add(String(schema.key)));
      input.setExpandedKeys?.((keys) => keys.filter((key) => !schemaKeys.has(String(key))));
      replaceTreeNodeChildren(node.key, [queriesNode(connection), ...nodes], connection);
      setConnectionStates((states) => ({ ...states, [String(node.key)]: 'success' }));
      input.onDatabaseTreeLoaded?.(databaseKey);
    } catch (error) { if (lifecycle.current()) fail(node, error); }
    finally { lifecycle.finish(); }
  };

  const loadTables = (node: { key: React.Key; dataRef?: unknown; type?: string }, options: SidebarTreeLoadOptions = {}): Promise<void> => {
    if (!node.dataRef) return Promise.resolve();
    const loadNode = node as LoadNode;
    const connection = resolveConnection(loadNode);
    if (!supportsSidebarSchemaLazyLoading(connection)) return input.loadLegacyTables(loadNode, options);
    const currentNode = input.getTree ? findSidebarSchemaTreeNode(input.getTree(), String(node.key)) : loadNode;
    if (options.savedQueriesOnly && loadNode.dataRef.groupKey !== 'schema' && currentNode?.children) {
      replaceTreeNodeChildren(node.key, [queriesNode(connection), ...currentNode.children.filter((child) => child.type !== 'queries-folder')], connection);
      return Promise.resolve();
    }
    const schema = loadNode.dataRef.groupKey === 'schema' ? loadNode.dataRef.schemaName : undefined;
    const loadKey = schema ? sidebarSchemaLoadKey(connection.id, connection.dbName, schema) : `tables-${connection.id}-${connection.dbName}`;
    // A refresh replaces the request generation immediately; slow old statistics must not hold it up.
    if (options.ensureFresh) tableLoadsRef.current.delete(loadKey);
    return scheduleSidebarLoad(tableLoadsRef.current, loadKey, () => schema ? loadSchema(loadNode, options) : loadDatabase(loadNode, options), options, buildConnectionReloadSignature(connection));
  };
  return { loadTables };
};
