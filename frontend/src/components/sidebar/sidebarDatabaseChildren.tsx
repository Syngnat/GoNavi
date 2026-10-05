import type { SidebarViewMetadataEntry } from '../../utils/sidebarMetadata';
import type { OracleDatabaseLinkEntry } from './sidebarOracleDatabaseLinks';
import {
  dedupeSidebarTableEntries, groupSidebarPartitionTableEntries, getSidebarTableEntryIdentity,
} from './sidebarPartitions';
import {
  splitQualifiedName, getSidebarTableDisplayName, getMetadataDialect, buildQualifiedName,
  isSphinxConnection, shouldHideSchemaPrefix, buildSidebarObjectKeyName, supportsDatabaseSequences,
  supportsDatabaseEvents,
} from './sidebarMetadataLoaders';
import type { SavedConnection } from '../../types';
import { splitMetadataQualifiedName } from '../../utils/qualifiedName';
import { buildMetadataIdentityKey } from '../../utils/metadataIdentity';
import { t } from '../../i18n';
import { message, Button } from 'antd';
import { useStore } from '../../store';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import { getSchemaVisibilityRule, isSchemaVisible } from '../../utils/schemaVisibility';
import {
  sortSidebarTableEntries, type SidebarTreeNode as TreeNode, isSidebarTablePinned,
} from '../sidebarV2Utils';
import type { SidebarLoadedTableEntry, SidebarTreeLoadOptions } from './sidebarTreeLoaderHelpers';
import { GnFieldsIcon, GnIndexIcon, GnLinkIcon, GnFolderOpenIcon } from '../icons/gnIcons';
import { renderSidebarObjectIcon } from './sidebarObjectIcons';
import { filterRegistryObjectGroups, isRegistryHiddenSchema } from './sidebarRegistryObjectGroups';
import {
  createSidebarObjectGroupBuilder, buildOracleDatabaseLinkGroup,
} from './sidebarObjectGroup';
import type { MetadataLoadState } from './sidebarMetadataBasics';
import type { SidebarDatabaseObjectLoadResults } from './useSidebarTableLoader';

export interface CreateSidebarDatabaseChildrenBuilderInput {
  schemasResult: { schemas: string[]; } & MetadataLoadState;
  tableEntries: SidebarLoadedTableEntry[];
  conn: any;
  key: any;
  loadTables: (node: any, options?: SidebarTreeLoadOptions) => Promise<void>;
  node: any;
  tableSortPreference: Record<string, any>;
  tableAccessCount: Record<string, any>;
  pinnedSidebarTables: any[];
  dbName: any;
  queriesNode: TreeNode;
}

export const createSidebarDatabaseChildrenBuilder = ({
  schemasResult, tableEntries, conn, key, loadTables, node, tableSortPreference, tableAccessCount,
  pinnedSidebarTables, dbName, queriesNode,
}: CreateSidebarDatabaseChildrenBuilderInput) => {
  // Runs twice: once with empty object results as soon as tables are known, and
  // once more when views/routines/sequences/triggers/events have arrived.
  const buildRenderedDatabaseChildren = (
      objectResults: SidebarDatabaseObjectLoadResults,
      notifyMetadataIssues: boolean,
  ) => {
  const {
      viewsResult,
      materializedViewsResult,
      triggersResult,
      routinesResult,
      sequencesResult,
      packagesResult,
      eventsResult,
      databaseLinksResult,
  } = objectResults;
              const viewRows: SidebarViewMetadataEntry[] = Array.isArray(viewsResult.views) ? viewsResult.views : [];
              const materializedViewRows: SidebarViewMetadataEntry[] = Array.isArray(materializedViewsResult.views) ? materializedViewsResult.views : [];
              const triggerRows: any[] = Array.isArray(triggersResult.triggers) ? triggersResult.triggers : [];
              const routineRows: any[] = Array.isArray(routinesResult.routines) ? routinesResult.routines : [];
              const sequenceRows: any[] = Array.isArray(sequencesResult.sequences) ? sequencesResult.sequences : [];
              const packageRows: any[] = Array.isArray(packagesResult.packages) ? packagesResult.packages : [];
              const eventRows: any[] = Array.isArray(eventsResult.events) ? eventsResult.events : [];
  const databaseLinkEntries: OracleDatabaseLinkEntry[] = Array.isArray(databaseLinksResult.databaseLinks) ? databaseLinksResult.databaseLinks : [];
              const schemaRows: string[] = Array.isArray(schemasResult.schemas) ? schemasResult.schemas : [];
              const normalizedSchemaRows = schemaRows
                  .map((schemaName) => String(schemaName || '').trim())
                  .filter((schemaName) => schemaName !== '');
              const normalizedTableEntries = dedupeSidebarTableEntries(tableEntries.map((entry) => {
                  if (entry.schemaName || normalizedSchemaRows.length !== 1) {
                      return entry;
                  }
                  return {
                      ...entry,
                      schemaName: normalizedSchemaRows[0],
                  };
              }));

              const viewEntries = viewRows.map((entry: SidebarViewMetadataEntry) => {
                  const parsed = splitQualifiedName(entry.viewName);
                  return {
                      viewName: entry.viewName,
          schemaName: entry.schemaName || parsed.schemaName,
          displayName: getSidebarTableDisplayName(conn, entry.viewName),
      };
  });

              const materializedViewEntries = materializedViewRows.map((entry: SidebarViewMetadataEntry) => {
                  const parsed = splitQualifiedName(entry.viewName);
                  return {
                      viewName: entry.viewName,
                      schemaName: entry.schemaName || parsed.schemaName,
                      displayName: getSidebarTableDisplayName(conn, entry.viewName),
                  };
              });

              const triggerEntries = (() => {
                  const deduped: Array<{ displayName: string; triggerName: string; tableName: string; schemaName: string; objectStatus?: string }> = [];
                  const triggerSeen = new Set<string>();
                  const metadataDialect = getMetadataDialect(conn as SavedConnection);

                  triggerRows.forEach((trigger: any) => {
                      // Trigger metadata carries schema and object names as
                      // separate fields. Treat a bare dotted value as a literal
                      // identifier unless it explicitly matches that schema;
                      // otherwise `a.b` gets silently reduced to `b`.
                      const rawTriggerName = String(trigger.triggerName || '').trim();
                      const rawTableName = String(trigger.tableName || '').trim();
                      const metadataSchemaName = String(trigger.schemaName || '').trim();
                      const splitTriggerMetadataName = (rawName: string) => {
                          if (metadataSchemaName) {
                              return splitMetadataQualifiedName(rawName, metadataSchemaName);
                          }
                          const parsed = splitQualifiedName(rawName);
                          return { parentPath: parsed.schemaName, objectName: parsed.objectName };
                      };
                      const triggerParsed = splitTriggerMetadataName(rawTriggerName);
                      const tableParsed = splitTriggerMetadataName(rawTableName);
                      const schemaName = metadataSchemaName || tableParsed.parentPath || triggerParsed.parentPath || String(conn.dbName || '').trim();
                      const triggerObjectName = String(triggerParsed.objectName || rawTriggerName).trim();
                      const tableObjectName = String(tableParsed.objectName || rawTableName).trim();
                      // The loader may have quoted a dotted object name (for
                      // example `audit.`order.items``). Preserve that exact
                      // identity instead of rebuilding it from an ambiguous
                      // bare string and losing the delimiter.
                      const triggerName = rawTriggerName || triggerObjectName;
                      const tableName = rawTableName || buildQualifiedName(schemaName, tableObjectName) || tableObjectName;
                      const displayName = tableObjectName ? `${triggerObjectName} (${tableObjectName})` : triggerObjectName;
                      const objectStatus = String(trigger.objectStatus || '').trim();
                      const dedupeKey = metadataDialect === 'mysql'
                          ? buildMetadataIdentityKey(
                              metadataDialect,
                              schemaName,
                              triggerObjectName,
                          )
                          : buildMetadataIdentityKey(
                              metadataDialect,
                              schemaName,
                              triggerObjectName,
                              tableObjectName,
                          );

                      if (triggerSeen.has(dedupeKey)) return;
                      triggerSeen.add(dedupeKey);
                      deduped.push({
                          ...trigger,
                          schemaName,
                          triggerName,
                          tableName,
                          displayName,
                          ...(objectStatus ? { objectStatus } : {}),
                      });
                  });

                  return deduped;
              })();

              const routineEntries = (() => {
                  const deduped: Array<{ routineName: string; routineType: string; schemaName: string; displayName: string; objectStatus?: string }> = [];
                  const routineSeen = new Set<string>();
                  const metadataDialect = getMetadataDialect(conn as SavedConnection);
                  routineRows.forEach((routine: any) => {
                      const parsed = splitQualifiedName(routine.routineName);
                      const routineType = String(routine.routineType || 'FUNCTION').toUpperCase().includes('PROC')
                          ? 'PROCEDURE'
                          : 'FUNCTION';
                      const schemaName = String(parsed.schemaName || routine.schemaName || '').trim();
                      const objectName = String(parsed.objectName || routine.routineName || '').trim();
                      if (!objectName) return;
                      const routineName = String(routine.routineName || objectName).trim();
                      const typeLabel = routineType === 'PROCEDURE' ? 'P' : 'F';
                      const objectStatus = String(routine.objectStatus || '').trim();
                      const dedupeKey = buildMetadataIdentityKey(
                          metadataDialect,
                          schemaName,
                          objectName,
                          routineType,
                      );
                      if (routineSeen.has(dedupeKey)) return;
                      routineSeen.add(dedupeKey);
                      deduped.push({
                          routineName,
                          routineType,
                          schemaName,
                          displayName: `${objectName} [${typeLabel}]`,
                          ...(objectStatus ? { objectStatus } : {}),
                      });
                  });
                  return deduped;
              })();

              const sequenceEntries = sequenceRows.map((sequence: any) => {
                  const parsed = splitQualifiedName(sequence.sequenceName);
                  return {
                      ...sequence,
                      schemaName: sequence.schemaName || parsed.schemaName,
                      displayName: parsed.objectName || sequence.sequenceName,
                  };
              });

              const packageEntries = packageRows.map((packageEntry: any) => {
                  const parsed = splitQualifiedName(packageEntry.packageName);
                  return {
                      ...packageEntry,
                      schemaName: packageEntry.schemaName || parsed.schemaName,
                      displayName: parsed.objectName || packageEntry.packageName,
                  };
              });

              const eventEntries = eventRows.map((event: any) => ({
                  ...event,
                  schemaName: String(event.schemaName || conn.dbName || '').trim(),
                  displayName: String(event.displayName || event.eventName || '').trim(),
              })).filter((event: any) => event.eventName && event.displayName);

              if (notifyMetadataIssues && isSphinxConnection(conn as SavedConnection)) {
                  const unsupportedObjects: string[] = [];
                  if (!viewsResult.supported) unsupportedObjects.push(t('sidebar.object_group.views'));
                  if (!routinesResult.supported) unsupportedObjects.push(t('sidebar.object_group.routines'));
                  if (!triggersResult.supported) unsupportedObjects.push(t('sidebar.object_group.triggers'));
                  if (unsupportedObjects.length > 0) {
                      message.info({
                          key: `sphinx-capability-${conn.id}-${conn.dbName}`,
                          content: t('sidebar.message.sphinx_unsupported_objects', {
                              objects: unsupportedObjects.join(t('sidebar.punctuation.list_separator')),
                          }),
                      });
                  }
              }

              const metadataFailures = [
                  { label: t('sidebar.object_group.views'), message: viewsResult.failureMessage },
                  { label: t('sidebar.object_group.materialized_views'), message: materializedViewsResult.failureMessage },
                  { label: t('sidebar.object_group.triggers'), message: triggersResult.failureMessage },
                  { label: t('sidebar.object_group.routines'), message: routinesResult.failureMessage },
                  { label: t('sidebar.object_group.sequences'), message: sequencesResult.failureMessage },
                  { label: t('sidebar.object_group.packages'), message: packagesResult.failureMessage },
                  { label: t('sidebar.object_group.events'), message: eventsResult.failureMessage },
      { label: t('sidebar.object_group.database_links'), message: databaseLinksResult.failureMessage },
              ].filter((failure) => failure.message);
              if (notifyMetadataIssues && metadataFailures.length > 0) {
                  const warningKey = `db-${key}-metadata-partial`;
                  message.warning({
                      key: warningKey,
                      duration: 10,
                      content: (
                          <span>
                              {t('sidebar.message.object_metadata_partial', {
                                  objects: metadataFailures.map((failure) => failure.label).join(t('sidebar.punctuation.list_separator')),
                                  error: metadataFailures.map((failure) => failure.message).join('; '),
                              })}
                              <Button
                                  type="link"
                                  size="small"
                                  onClick={() => void loadTables(node, { ensureFresh: true })}
                              >
                                  {t('common.retry')}
                              </Button>
                          </span>
                      ),
                  });
              }

  const currentStoreState = useStore.getState();
  const currentTableSortPreference = currentStoreState.tableSortPreference || tableSortPreference;
  const currentTableAccessCount = currentStoreState.tableAccessCount || tableAccessCount;
  const currentPinnedSidebarTables = currentStoreState.pinnedSidebarTables || pinnedSidebarTables;
  // Metadata loading can overlap with a schema visibility save. Build partition
  // relationships from the newest visible table set so hidden schemas cannot leak
  // through a visible parent, and visible children do not disappear with a hidden parent.
  const latestConnection = useStore.getState().connections.find(
      (candidate) => candidate.id === conn.id,
  ) || conn;
  		            const latestDatabaseConnection = { ...latestConnection, dbName };
  		            const shouldGroupBySchema = shouldHideSchemaPrefix(latestDatabaseConnection as SavedConnection);
  		            const schemaIdentifierOptions = {
  		                caseSensitive: getDataSourceCapabilities(latestDatabaseConnection.config)
  		                    .schemaIdentifierCaseSensitive,
  		            };
  		            const schemaVisibilityRule = getSchemaVisibilityRule(
  		                latestDatabaseConnection,
  		                dbName,
  		                schemaIdentifierOptions,
  		            );

  // 获取当前数据库的排序偏好
  const sortPreferenceKey = `${conn.id}-${conn.dbName}`;
  const sortBy = currentTableSortPreference[sortPreferenceKey] || 'name';

  const sortedTableEntries = groupSidebarPartitionTableEntries(sortSidebarTableEntries(normalizedTableEntries, {
      connectionId: conn.id,
      dbName: conn.dbName,
      sortBy,
      tableAccessCount: currentTableAccessCount,
      pinnedSidebarTables: currentPinnedSidebarTables,
  }), {
  		                isEntryVisible: (entry) => !shouldGroupBySchema
  		                    || isSchemaVisible(schemaVisibilityRule, entry.schemaName, schemaIdentifierOptions),
  }) as SidebarLoadedTableEntry[];

  // Sort views by name (case-insensitive)
  viewEntries.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));

  materializedViewEntries.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));

  // Sort triggers by display name (case-insensitive)
  triggerEntries.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));

  // Sort routines by display name (case-insensitive)
  routineEntries.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));

  sequenceEntries.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));

  packageEntries.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));

  eventEntries.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));

  const buildTableNode = (entry: SidebarLoadedTableEntry): TreeNode => {
      const isPinned = isSidebarTablePinned(
          currentPinnedSidebarTables,
          conn.id,
          conn.dbName,
          entry.tableName,
          entry.schemaName,
      );
      const keyName = encodeURIComponent(getSidebarTableEntryIdentity(entry));
      const nodeKey = `${conn.id}-${conn.dbName}-table-${keyName}`;
      const tableDataRef = {
          ...conn,
          tableName: entry.tableName,
          schemaName: entry.schemaName,
          ...(entry.rowCount !== undefined ? { rowCount: entry.rowCount } : {}),
                          tableSize: entry.tableSize,
                          createdAt: entry.createdAt,
                          updatedAt: entry.updatedAt,
                          tableComment: entry.tableComment,
          ...(isPinned ? { pinnedSidebarTable: true } : {}),
      };
      const partitionNodes = (entry.partitionTables || []).map(buildTableNode);
      const children: TreeNode[] | undefined = partitionNodes.length > 0
          ? [
              {
                  title: t('sidebar.table_folder.columns'),
                  key: `${nodeKey}-columns`,
                  icon: <GnFieldsIcon />,
                  type: 'folder-columns',
                  isLeaf: true,
                  dataRef: tableDataRef,
              },
              {
                  title: t('sidebar.table_folder.indexes'),
                  key: `${nodeKey}-indexes`,
                  icon: <GnIndexIcon />,
                  type: 'folder-indexes',
                  isLeaf: true,
                  dataRef: tableDataRef,
              },
              {
                  title: t('sidebar.table_folder.foreign_keys'),
                  key: `${nodeKey}-fks`,
                  icon: <GnLinkIcon />,
                  type: 'folder-fks',
                  isLeaf: true,
                  dataRef: tableDataRef,
              },
              {
                  title: t('sidebar.table_folder.triggers'),
                  key: `${nodeKey}-triggers`,
                  icon: renderSidebarObjectIcon('trigger'),
                  type: 'folder-triggers',
                  isLeaf: true,
                  dataRef: tableDataRef,
              },
              {
                  title: t('sidebar.table_folder.partitions'),
                  key: `${nodeKey}-partitions`,
                  icon: <GnFolderOpenIcon />,
                  type: 'object-group',
                  isLeaf: false,
                  selectable: false,
                  children: partitionNodes,
                  dataRef: {
                      ...tableDataRef,
                      groupKey: 'partitions',
                      partitionCount: partitionNodes.length,
                  },
              },
          ]
          : undefined;
      return {
          title: entry.displayName,
          key: nodeKey,
          icon: renderSidebarObjectIcon('table'),
          type: 'table',
          dataRef: tableDataRef,
          ...(children ? { children } : {}),
          isLeaf: false,
      };
  };

  const buildViewNode = (entry: { viewName: string; schemaName: string; displayName: string }): TreeNode => {
      const keyName = buildSidebarObjectKeyName(conn.dbName, entry.schemaName, entry.viewName);
      return {
          title: entry.displayName,
          key: `${conn.id}-${conn.dbName}-view-${keyName}`,
          icon: renderSidebarObjectIcon('view'),
          type: 'view',
          dataRef: { ...conn, viewName: entry.viewName, tableName: entry.viewName, schemaName: entry.schemaName },
          isLeaf: true,
      };
  };

  const buildMaterializedViewNode = (entry: { viewName: string; schemaName: string; displayName: string }): TreeNode => {
      const keyName = buildSidebarObjectKeyName(conn.dbName, entry.schemaName, entry.viewName);
      return {
          title: entry.displayName,
          key: `${conn.id}-${conn.dbName}-materialized-view-${keyName}`,
          icon: renderSidebarObjectIcon('materializedView'),
          type: 'materialized-view',
          dataRef: { ...conn, viewName: entry.viewName, tableName: entry.viewName, schemaName: entry.schemaName, objectKind: 'materialized-view' },
          isLeaf: true,
      };
  };

              const buildTriggerNode = (entry: { triggerName: string; tableName: string; schemaName: string; displayName: string; objectStatus?: string }): TreeNode => ({
      title: entry.displayName,
      key: `${conn.id}-${conn.dbName}-trigger-${entry.triggerName}-${entry.tableName}`,
      icon: renderSidebarObjectIcon('trigger'),
      type: 'db-trigger',
                  dataRef: { ...conn, triggerName: entry.triggerName, triggerTableName: entry.tableName, tableName: entry.tableName, schemaName: entry.schemaName, ...(entry.objectStatus ? { objectStatus: entry.objectStatus } : {}) },
      isLeaf: true,
  });

              const buildRoutineNode = (entry: { routineName: string; routineType: string; schemaName: string; displayName: string; objectStatus?: string }): TreeNode => {
      const typeToken = entry.routineType === 'PROCEDURE' ? 'proc' : 'func';
      const keyName = buildSidebarObjectKeyName(conn.dbName, entry.schemaName, entry.routineName);
      return {
          title: entry.displayName,
          // 必须带 routineType：同名函数/过程否则 key 冲突，虚拟列表会叠成“同一函数无限重复”
          key: `${conn.id}-${conn.dbName}-routine-${typeToken}-${keyName}`,
          icon: renderSidebarObjectIcon('routine'),
          type: 'routine',
                      dataRef: { ...conn, routineName: entry.routineName, routineType: entry.routineType, schemaName: entry.schemaName, ...(entry.objectStatus ? { objectStatus: entry.objectStatus } : {}) },
          isLeaf: true,
      };
  };

  const buildSequenceNode = (entry: { sequenceName: string; schemaName: string; displayName: string }): TreeNode => {
      const keyName = buildSidebarObjectKeyName(conn.dbName, entry.schemaName, entry.sequenceName);
      return {
          title: entry.displayName,
          key: `${conn.id}-${conn.dbName}-sequence-${keyName}`,
          icon: renderSidebarObjectIcon('sequence'),
          type: 'sequence',
          dataRef: { ...conn, sequenceName: entry.sequenceName, schemaName: entry.schemaName },
          isLeaf: true,
      };
  };

  const buildPackageNode = (entry: { packageName: string; schemaName: string; displayName: string }): TreeNode => {
      const keyName = buildSidebarObjectKeyName(conn.dbName, entry.schemaName, entry.packageName);
      return {
          title: entry.displayName,
          key: `${conn.id}-${conn.dbName}-package-${keyName}`,
          icon: renderSidebarObjectIcon('package'),
          type: 'package',
          dataRef: { ...conn, packageName: entry.packageName, schemaName: entry.schemaName },
          isLeaf: true,
      };
  };

              const buildEventNode = (entry: { eventName: string; schemaName: string; displayName: string; eventType?: string; status?: string }): TreeNode => ({
      title: entry.displayName,
      key: `${conn.id}-${conn.dbName}-event-${entry.schemaName}-${entry.eventName}`,
      icon: renderSidebarObjectIcon('event'),
      type: 'db-event',
      dataRef: { ...conn, eventName: entry.eventName, schemaName: entry.schemaName, eventType: entry.eventType, eventStatus: entry.status },
      isLeaf: true,
  });

  let renderedDatabaseChildren: TreeNode[];
  const objectGroupConnection = conn as SavedConnection & { dbName?: string };
  const buildObjectGroup = createSidebarObjectGroupBuilder(objectGroupConnection);
  if (shouldGroupBySchema) {
      type SchemaBucket = {
          schemaName: string;
          tables: TreeNode[];
          views: TreeNode[];
          materializedViews: TreeNode[];
          routines: TreeNode[];
          sequences: TreeNode[];
          packages: TreeNode[];
          triggers: TreeNode[];
          events: TreeNode[];
          databaseLinks: OracleDatabaseLinkEntry[];
      };

      const schemaMap = new Map<string, SchemaBucket>();
      const getSchemaBucket = (rawSchemaName: string): SchemaBucket => {
          const schemaName = String(rawSchemaName || '').trim();
          // Use a length-prefixed identity rather than a sentinel. A
          // real schema can be named "default" (or "__default__"),
          // and it must remain distinct from rows with no schema.
          const schemaKey = `${schemaName.length}:${schemaName}`;
          let bucket = schemaMap.get(schemaKey);
          if (!bucket) {
              bucket = {
                  schemaName,
                  tables: [],
                  views: [],
                  materializedViews: [],
                  routines: [],
                  sequences: [],
                  packages: [],
                  triggers: [],
                  events: [],
                  databaseLinks: [],
              };
              schemaMap.set(schemaKey, bucket);
          }
          return bucket;
      };

      schemaRows.forEach((schemaName) => getSchemaBucket(schemaName));
      sortedTableEntries.forEach((entry) => getSchemaBucket(entry.schemaName).tables.push(buildTableNode(entry)));
      viewEntries.forEach((entry) => getSchemaBucket(entry.schemaName).views.push(buildViewNode(entry)));
      materializedViewEntries.forEach((entry) => getSchemaBucket(entry.schemaName).materializedViews.push(buildMaterializedViewNode(entry)));
      routineEntries.forEach((entry) => getSchemaBucket(entry.schemaName).routines.push(buildRoutineNode(entry)));
      sequenceEntries.forEach((entry) => getSchemaBucket(entry.schemaName).sequences.push(buildSequenceNode(entry)));
      packageEntries.forEach((entry) => getSchemaBucket(entry.schemaName).packages.push(buildPackageNode(entry)));
      triggerEntries.forEach((entry) => getSchemaBucket(entry.schemaName).triggers.push(buildTriggerNode(entry)));
      eventEntries.forEach((entry) => getSchemaBucket(entry.schemaName).events.push(buildEventNode(entry)));

      const dialect = getMetadataDialect(conn as SavedConnection);
      const isOracleLike = (dialect === 'oracle' || dialect === 'dm');
      const includeMaterializedViews = dialect === 'starrocks';
      const includeOracleObjects = isOracleLike;
      databaseLinkEntries.forEach((entry) => getSchemaBucket(entry.schemaName).databaseLinks.push(entry));
      if (dialect === 'oracle') getSchemaBucket(String(dbName || '').trim());
      const includeSequences = supportsDatabaseSequences(conn as SavedConnection);
      const includeEvents = supportsDatabaseEvents(conn as SavedConnection);

  		                const schemaNodes: TreeNode[] = Array.from(schemaMap.values())
  		                    .filter((bucket) => !(isOracleLike && !bucket.schemaName))
  		                    .filter((bucket) => isSchemaVisible(
  		                        schemaVisibilityRule,
  		                        bucket.schemaName,
  		                        schemaIdentifierOptions,
  		                    ) && !isRegistryHiddenSchema(conn as SavedConnection, bucket.schemaName))
          .sort((a, b) => {
              if (!a.schemaName && !b.schemaName) return 0;
              if (!a.schemaName) return -1;
              if (!b.schemaName) return 1;
              return a.schemaName.toLowerCase().localeCompare(b.schemaName.toLowerCase());
          })
          .map((bucket) => {
          const schemaIdentity = `${bucket.schemaName.length}:${bucket.schemaName}`;
          const schemaNodeKey = `${key}-schema-${encodeURIComponent(schemaIdentity)}`;
          const schemaTitle = bucket.schemaName || t('sidebar.tree.default_schema');
              const groupedNodes: TreeNode[] = filterRegistryObjectGroups(conn as SavedConnection, [
                  buildObjectGroup(schemaNodeKey, 'tables', t('sidebar.object_group.tables'), renderSidebarObjectIcon('table'), bucket.tables, { schemaName: bucket.schemaName }),
                  buildObjectGroup(schemaNodeKey, 'views', t('sidebar.object_group.views'), renderSidebarObjectIcon('view'), bucket.views, { schemaName: bucket.schemaName }),
                  ...(includeMaterializedViews ? [buildObjectGroup(schemaNodeKey, 'materializedViews', t('sidebar.object_group.materialized_views'), renderSidebarObjectIcon('materializedView'), bucket.materializedViews, { schemaName: bucket.schemaName })] : []),
                  ...(includeSequences ? [buildObjectGroup(schemaNodeKey, 'sequences', t('sidebar.object_group.sequences'), renderSidebarObjectIcon('sequence'), bucket.sequences, { schemaName: bucket.schemaName })] : []),
                  buildObjectGroup(schemaNodeKey, 'routines', t('sidebar.object_group.routines'), renderSidebarObjectIcon('routine'), bucket.routines, { schemaName: bucket.schemaName }),
                  ...(includeOracleObjects ? [buildObjectGroup(schemaNodeKey, 'packages', t('sidebar.object_group.packages'), renderSidebarObjectIcon('package'), bucket.packages, { schemaName: bucket.schemaName })] : []),
                  buildObjectGroup(schemaNodeKey, 'triggers', t('sidebar.object_group.triggers'), renderSidebarObjectIcon('trigger'), bucket.triggers, { schemaName: bucket.schemaName }),
                  ...(includeEvents ? [buildObjectGroup(schemaNodeKey, 'events', t('sidebar.object_group.events'), renderSidebarObjectIcon('event'), bucket.events, { schemaName: bucket.schemaName })] : []),
                  ...(dialect === 'oracle' ? [buildOracleDatabaseLinkGroup(objectGroupConnection, schemaNodeKey, t('sidebar.object_group.database_links'), bucket.databaseLinks, bucket.schemaName)] : []),
              ]);

              return {
                  title: schemaTitle,
                  key: schemaNodeKey,
                  icon: <GnFolderOpenIcon />,
                  type: 'object-group' as const,
                  isLeaf: groupedNodes.length === 0,
                  children: groupedNodes,
                  dataRef: { ...conn, dbName: conn.dbName, groupKey: 'schema', schemaName: bucket.schemaName }
              };
          });

      renderedDatabaseChildren = [queriesNode, ...schemaNodes];
  } else {
      const dialect = getMetadataDialect(conn as SavedConnection);
      const includeMaterializedViews = dialect === 'starrocks';
      const includeOracleObjects = dialect === 'oracle' || dialect === 'dm';
      const includeSequences = supportsDatabaseSequences(conn as SavedConnection);
      const includeEvents = supportsDatabaseEvents(conn as SavedConnection);
      const groupedNodes: TreeNode[] = filterRegistryObjectGroups(conn as SavedConnection, [
          buildObjectGroup(key as string, 'tables', t('sidebar.object_group.tables'), renderSidebarObjectIcon('table'), sortedTableEntries.map(buildTableNode)),
          buildObjectGroup(key as string, 'views', t('sidebar.object_group.views'), renderSidebarObjectIcon('view'), viewEntries.map(buildViewNode)),
          ...(includeMaterializedViews ? [buildObjectGroup(key as string, 'materializedViews', t('sidebar.object_group.materialized_views'), renderSidebarObjectIcon('materializedView'), materializedViewEntries.map(buildMaterializedViewNode))] : []),
          ...(includeSequences ? [buildObjectGroup(key as string, 'sequences', t('sidebar.object_group.sequences'), renderSidebarObjectIcon('sequence'), sequenceEntries.map(buildSequenceNode))] : []),
          buildObjectGroup(key as string, 'routines', t('sidebar.object_group.routines'), renderSidebarObjectIcon('routine'), routineEntries.map(buildRoutineNode)),
          ...(includeOracleObjects ? [buildObjectGroup(key as string, 'packages', t('sidebar.object_group.packages'), renderSidebarObjectIcon('package'), packageEntries.map(buildPackageNode))] : []),
          buildObjectGroup(key as string, 'triggers', t('sidebar.object_group.triggers'), renderSidebarObjectIcon('trigger'), triggerEntries.map(buildTriggerNode)),
          ...(includeEvents ? [buildObjectGroup(key as string, 'events', t('sidebar.object_group.events'), renderSidebarObjectIcon('event'), eventEntries.map(buildEventNode))] : []),
          ...(dialect === 'oracle' ? [buildOracleDatabaseLinkGroup(objectGroupConnection, key as string, t('sidebar.object_group.database_links'), databaseLinkEntries)] : []),
      ]);

      renderedDatabaseChildren = [queriesNode, ...groupedNodes];
  }
  return { renderedDatabaseChildren, latestDatabaseConnection };
  };
  return { buildRenderedDatabaseChildren };
};
