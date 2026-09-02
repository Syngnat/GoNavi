import { splitQualifiedNameLast } from './qualifiedName';

export const SIDEBAR_LOCATE_CONNECTION_EVENT = 'gonavi:locate-sidebar-connection';

export type SidebarLocateObjectGroup = 'tables' | 'views' | 'materializedViews' | 'triggers' | 'routines' | 'sequences' | 'packages' | 'events' | 'externalSqlFiles' | 'savedQueries';
export type SidebarLocateDatabaseObjectGroup = Exclude<SidebarLocateObjectGroup, 'externalSqlFiles' | 'savedQueries'>;

export interface SidebarLocateConnectionRequest {
  connectionId: string;
  dbName?: string;
}

export interface SidebarLocateDatabaseObjectRequest {
  tabId?: string;
  connectionId: string;
  dbName: string;
  tableName: string;
  schemaName?: string;
  objectGroup: SidebarLocateDatabaseObjectGroup;
}

export interface SidebarLocateExternalSQLFileRequest {
  tabId?: string;
  connectionId?: string;
  dbName?: string;
  filePath: string;
  fileName?: string;
  objectGroup: 'externalSqlFiles';
}

export interface SidebarLocateSavedQueryRequest {
  tabId?: string;
  connectionId?: string;
  dbName?: string;
  savedQueryId: string;
  savedQueryName?: string;
  objectGroup: 'savedQueries';
}

export type SidebarLocateObjectRequest = SidebarLocateDatabaseObjectRequest | SidebarLocateExternalSQLFileRequest | SidebarLocateSavedQueryRequest;

export interface SidebarLocateTarget {
  connectionKey: string;
  databaseKey: string;
  targetKey: string;
  objectGroup: SidebarLocateObjectGroup;
  objectGroupKey: string;
  schemaKey?: string;
  expectedAncestorKeys: string[];
  connectionId: string;
  dbName: string;
  tableName: string;
  schemaName: string;
  filePath?: string;
  savedQueryId?: string;
}

export interface SidebarLocateTreeNodeLike {
  key: string | number;
  title?: unknown;
  type?: string;
  dataRef?: Record<string, any>;
  children?: SidebarLocateTreeNodeLike[];
}

export interface SidebarLocateTabLike {
  id?: string;
  type?: string;
  connectionId?: string;
  dbName?: string;
  tableName?: string;
  viewName?: string;
  viewKind?: string;
  triggerName?: string;
  triggerTableName?: string;
  routineName?: string;
  sequenceName?: string;
  packageName?: string;
  eventName?: string;
  schemaName?: string;
  sidebarLocateKey?: string;
  filePath?: string;
  objectType?: string;
  queryMode?: string;
  savedQueryId?: string;
  title?: string;
}

const toTrimmedString = (value: unknown): string => String(value ?? '').trim();
const normalizeLocateName = (value: string): string => toTrimmedString(value).toLowerCase();

// Schema groups use an encoded, length-prefixed identity so an unqualified
// object (empty schema) cannot collide with a schema literally named
// "default" or another sentinel value. Keep this helper shared with locate
// and object-refresh paths that derive the same tree keys.
export const encodeSidebarSchemaIdentity = (schemaName: unknown): string => {
  const schema = toTrimmedString(schemaName);
  return encodeURIComponent(`${schema.length}:${schema}`);
};

export const buildSidebarSchemaNodeKey = (
  databaseKey: string,
  schemaName: unknown,
): string => `${toTrimmedString(databaseKey)}-schema-${encodeSidebarSchemaIdentity(schemaName)}`;

const buildLegacySidebarSchemaNodeKey = (
  databaseKey: string,
  schemaName: unknown,
): string => `${toTrimmedString(databaseKey)}-schema-${toTrimmedString(schemaName) || 'default'}`;

const normalizeExternalSQLLocatePath = (value: unknown): string => toTrimmedString(value).replace(/\\/g, '/');

export const normalizeSidebarLocateConnectionRequest = (detail: unknown): SidebarLocateConnectionRequest | null => {
  const raw = (detail || {}) as Record<string, unknown>;
  const connectionId = toTrimmedString(raw.connectionId);
  if (!connectionId) return null;
  const dbName = toTrimmedString(raw.dbName);
  return {
    connectionId,
    ...(dbName ? { dbName } : {}),
  };
};

export const dispatchSidebarLocateConnection = (
  detail: unknown,
  eventTarget?: Pick<Window, 'dispatchEvent'> | null,
): boolean => {
  const request = normalizeSidebarLocateConnectionRequest(detail);
  const target = eventTarget ?? (typeof window === 'undefined' ? null : window);
  if (!request || !target || typeof CustomEvent !== 'function') return false;
  target.dispatchEvent(new CustomEvent<SidebarLocateConnectionRequest>(SIDEBAR_LOCATE_CONNECTION_EVENT, {
    detail: request,
  }));
  return true;
};

export const splitSidebarQualifiedName = (qualifiedName: string): { schemaName: string; objectName: string } => {
  const raw = toTrimmedString(qualifiedName);
  if (!raw) return { schemaName: '', objectName: '' };
  const parsed = splitQualifiedNameLast(raw);
  return {
    schemaName: parsed.parentPath,
    objectName: parsed.objectName,
  };
};

const inferObjectGroup = (detail: Record<string, unknown>, connectionId: string, dbName: string): SidebarLocateDatabaseObjectGroup => {
  const explicitGroup = toTrimmedString(detail.objectGroup);
  if (explicitGroup === 'views' || explicitGroup === 'view') return 'views';
  if (explicitGroup === 'materializedViews' || explicitGroup === 'materialized-view') return 'materializedViews';
  if (explicitGroup === 'triggers' || explicitGroup === 'trigger') return 'triggers';
  if (explicitGroup === 'routines' || explicitGroup === 'routine') return 'routines';
  if (explicitGroup === 'sequences' || explicitGroup === 'sequence') return 'sequences';
  if (explicitGroup === 'packages' || explicitGroup === 'package') return 'packages';
  if (explicitGroup === 'events' || explicitGroup === 'event') return 'events';

  const explicitType = toTrimmedString(detail.objectType);
  if (explicitType === 'view' || explicitType === 'views') return 'views';
  if (explicitType === 'materialized' || explicitType === 'materialized-view') return 'materializedViews';
  if (explicitType === 'trigger' || explicitType === 'triggers') return 'triggers';
  if (explicitType === 'routine' || explicitType === 'routines') return 'routines';
  if (explicitType === 'sequence' || explicitType === 'sequences') return 'sequences';
  if (explicitType === 'package' || explicitType === 'packages') return 'packages';
  if (explicitType === 'event' || explicitType === 'events') return 'events';

  const tabId = toTrimmedString(detail.tabId);
  const dbNodeKey = `${connectionId}-${dbName}`;
  if (tabId.startsWith(`${dbNodeKey}-materialized-view-`)) return 'materializedViews';
  if (tabId.startsWith(`${dbNodeKey}-view-`)) return 'views';
  if (tabId.startsWith(`${dbNodeKey}-trigger-`)) return 'triggers';
  if (tabId.startsWith(`${dbNodeKey}-routine-`) || tabId.startsWith(`routine-def-${connectionId}-${dbName}-`)) return 'routines';
  if (tabId.startsWith(`${dbNodeKey}-sequence-`) || tabId.startsWith(`sequence-def-${connectionId}-${dbName}-`)) return 'sequences';
  if (tabId.startsWith(`${dbNodeKey}-package-`) || tabId.startsWith(`package-def-${connectionId}-${dbName}-`)) return 'packages';
  if (tabId.startsWith(`${dbNodeKey}-event-`) || tabId.startsWith(`event-def-${connectionId}-${dbName}-`)) return 'events';

  return 'tables';
};

export const normalizeSidebarLocateObjectRequest = (detail: unknown): SidebarLocateObjectRequest | null => {
  const raw = (detail || {}) as Record<string, unknown>;
  const filePath = normalizeExternalSQLLocatePath(raw.filePath);
  if (filePath) {
    return {
      tabId: toTrimmedString(raw.tabId) || undefined,
      connectionId: toTrimmedString(raw.connectionId) || undefined,
      dbName: toTrimmedString(raw.dbName) || undefined,
      filePath,
      fileName: toTrimmedString(raw.fileName || raw.title) || undefined,
      objectGroup: 'externalSqlFiles',
    };
  }

  const savedQueryId = toTrimmedString(raw.savedQueryId);
  if (savedQueryId) {
    return {
      tabId: toTrimmedString(raw.tabId) || undefined,
      connectionId: toTrimmedString(raw.connectionId) || undefined,
      dbName: toTrimmedString(raw.dbName) || undefined,
      savedQueryId,
      savedQueryName: toTrimmedString(raw.savedQueryName || raw.title) || undefined,
      objectGroup: 'savedQueries',
    };
  }

  const connectionId = toTrimmedString(raw.connectionId);
  const dbName = toTrimmedString(raw.dbName);
  const tableName = toTrimmedString(raw.tableName || raw.objectName || raw.viewName || raw.triggerName || raw.routineName || raw.sequenceName || raw.packageName || raw.eventName);

  if (!connectionId || !dbName || !tableName) {
    return null;
  }

  const parsed = splitSidebarQualifiedName(tableName);
  const schemaName = toTrimmedString(raw.schemaName) || parsed.schemaName;

  return {
    tabId: toTrimmedString(raw.tabId) || undefined,
    connectionId,
    dbName,
    tableName,
    schemaName,
    objectGroup: inferObjectGroup(raw, connectionId, dbName),
  };
};

const resolveObjectEditLocateIdentity = (
  tab: SidebarLocateTabLike,
): { objectName: string; objectGroup: SidebarLocateDatabaseObjectGroup } | null => {
  const routineName = toTrimmedString(tab.routineName);
  if (routineName) {
    return { objectName: routineName, objectGroup: 'routines' };
  }
  const triggerName = toTrimmedString(tab.triggerName);
  if (triggerName) {
    return { objectName: triggerName, objectGroup: 'triggers' };
  }
  const sequenceName = toTrimmedString(tab.sequenceName);
  if (sequenceName) {
    return { objectName: sequenceName, objectGroup: 'sequences' };
  }
  const packageName = toTrimmedString(tab.packageName);
  if (packageName) {
    return { objectName: packageName, objectGroup: 'packages' };
  }
  const eventName = toTrimmedString(tab.eventName);
  if (eventName) {
    return { objectName: eventName, objectGroup: 'events' };
  }
  const viewName = toTrimmedString(tab.viewName);
  if (viewName) {
    const isMaterialized = tab.viewKind === 'materialized' || tab.objectType === 'materialized-view';
    return { objectName: viewName, objectGroup: isMaterialized ? 'materializedViews' : 'views' };
  }
  return null;
};

const resolveDefinitionTabObjectGroup = (tab: SidebarLocateTabLike): SidebarLocateDatabaseObjectGroup | undefined => {
  if (tab.type === 'view-def') return tab.viewKind === 'materialized' ? 'materializedViews' : 'views';
  if (tab.type === 'trigger') return 'triggers';
  if (tab.type === 'routine-def') return 'routines';
  if (tab.type === 'sequence-def') return 'sequences';
  if (tab.type === 'package-def') return 'packages';
  if (tab.type === 'event-def') return 'events';
  if (tab.objectType === 'materialized-view') return 'materializedViews';
  if (tab.objectType === 'view') return 'views';
  return undefined;
};

export const normalizeSidebarLocateObjectRequestFromTab = (tab: SidebarLocateTabLike | null | undefined): SidebarLocateObjectRequest | null => {
  if (!tab) return null;
  const filePath = normalizeExternalSQLLocatePath(tab.filePath);
  if (tab.type === 'query' && filePath) {
    return normalizeSidebarLocateObjectRequest({
      tabId: tab.id,
      connectionId: tab.connectionId,
      dbName: tab.dbName,
      filePath,
      fileName: tab.id,
    });
  }

  if (tab.type === 'query') {
    if (toTrimmedString(tab.queryMode) !== 'object-edit') {
      const savedQueryId = toTrimmedString(tab.savedQueryId);
      if (!savedQueryId) return null;
      return normalizeSidebarLocateObjectRequest({
        tabId: tab.id,
        connectionId: tab.connectionId,
        dbName: tab.dbName,
        savedQueryId,
        savedQueryName: tab.title,
      });
    }
    const identity = resolveObjectEditLocateIdentity(tab);
    if (!identity) return null;
    return normalizeSidebarLocateObjectRequest({
      tabId: toTrimmedString(tab.sidebarLocateKey || tab.id) || undefined,
      connectionId: tab.connectionId,
      dbName: tab.dbName,
      tableName: identity.objectName,
      schemaName: tab.schemaName,
      objectGroup: identity.objectGroup,
    });
  }

  const objectName = tab.type === 'view-def'
    ? toTrimmedString(tab.viewName || tab.tableName)
    : tab.type === 'trigger'
      ? toTrimmedString(tab.triggerName || tab.tableName)
      : tab.type === 'routine-def'
        ? toTrimmedString(tab.routineName || tab.tableName)
        : tab.type === 'sequence-def'
          ? toTrimmedString(tab.sequenceName || tab.tableName)
          : tab.type === 'package-def'
            ? toTrimmedString(tab.packageName || tab.tableName)
            : tab.type === 'event-def'
              ? toTrimmedString(tab.eventName || tab.tableName)
              : toTrimmedString(tab.tableName || tab.viewName);
  if (tab.type !== 'table' && tab.type !== 'view-def' && tab.type !== 'trigger' && tab.type !== 'routine-def' && tab.type !== 'sequence-def' && tab.type !== 'package-def' && tab.type !== 'event-def') {
    return null;
  }

  return normalizeSidebarLocateObjectRequest({
    tabId: toTrimmedString(tab.sidebarLocateKey || tab.id) || undefined,
    connectionId: tab.connectionId,
    dbName: tab.dbName,
    tableName: objectName,
    schemaName: tab.schemaName,
    objectGroup: resolveDefinitionTabObjectGroup(tab),
  });
};

export const resolveSidebarLocateTarget = (
  request: SidebarLocateObjectRequest,
  options: { groupBySchema: boolean },
): SidebarLocateTarget => {
  if (request.objectGroup === 'savedQueries') {
    return {
      connectionKey: toTrimmedString(request.connectionId),
      databaseKey: request.connectionId && request.dbName ? `${request.connectionId}-${request.dbName}` : '',
      targetKey: `all-saved-query-${request.savedQueryId}`,
      objectGroup: 'savedQueries',
      objectGroupKey: 'all-saved-queries',
      expectedAncestorKeys: ['all-saved-queries'],
      connectionId: toTrimmedString(request.connectionId),
      dbName: toTrimmedString(request.dbName),
      tableName: request.savedQueryName || request.savedQueryId,
      schemaName: '',
      savedQueryId: request.savedQueryId,
    };
  }

  if (request.objectGroup === 'externalSqlFiles') {
    const filePath = normalizeExternalSQLLocatePath(request.filePath);
    return {
      connectionKey: toTrimmedString(request.connectionId),
      databaseKey: request.connectionId && request.dbName ? `${request.connectionId}-${request.dbName}` : '',
      targetKey: request.tabId || filePath,
      objectGroup: 'externalSqlFiles',
      objectGroupKey: 'external-sql-root',
      expectedAncestorKeys: ['external-sql-root'],
      connectionId: toTrimmedString(request.connectionId),
      dbName: toTrimmedString(request.dbName),
      tableName: request.fileName || filePath.split('/').filter(Boolean).pop() || filePath,
      schemaName: '',
      filePath,
    };
  }

  const connectionKey = request.connectionId;
  const databaseKey = `${request.connectionId}-${request.dbName}`;
  const fallbackTargetKey = request.objectGroup === 'materializedViews'
    ? `${databaseKey}-materialized-view-${request.tableName}`
    : request.objectGroup === 'views'
      ? `${databaseKey}-view-${request.tableName}`
      : request.objectGroup === 'triggers'
        ? `${databaseKey}-trigger-${request.tableName}`
        : request.objectGroup === 'routines'
          ? `${databaseKey}-routine-${request.tableName}`
          : request.objectGroup === 'sequences'
            ? `${databaseKey}-sequence-${request.tableName}`
            : request.objectGroup === 'packages'
              ? `${databaseKey}-package-${request.tableName}`
              : request.objectGroup === 'events'
                ? `${databaseKey}-event-${request.tableName}`
                : `${databaseKey}-${request.tableName}`;
  const targetKey = request.tabId || fallbackTargetKey;
  const schemaKey = options.groupBySchema
    ? buildSidebarSchemaNodeKey(databaseKey, request.schemaName)
    : undefined;
  const objectGroupKey = options.groupBySchema
    ? `${schemaKey}-${request.objectGroup}`
    : `${databaseKey}-${request.objectGroup}`;
  const expectedAncestorKeys = [
    connectionKey,
    databaseKey,
    ...(schemaKey ? [schemaKey] : []),
    objectGroupKey,
  ];

  return {
    connectionKey,
    databaseKey,
    targetKey,
    objectGroup: request.objectGroup,
    objectGroupKey,
    schemaKey,
    expectedAncestorKeys,
    connectionId: request.connectionId,
    dbName: request.dbName,
    tableName: request.tableName,
    schemaName: request.schemaName || '',
  };
};

export const findSidebarNodePathByKey = (
  nodes: SidebarLocateTreeNodeLike[],
  targetKey: string,
): string[] | null => {
  for (const node of nodes) {
    const nodeKey = String(node.key);
    if (nodeKey === targetKey) {
      return [nodeKey];
    }

    if (node.children) {
      const childPath = findSidebarNodePathByKey(node.children, targetKey);
      if (childPath) {
        return [nodeKey, ...childPath];
      }
    }
  }
  return null;
};

const matchesLocateObjectName = (
  target: SidebarLocateTarget,
  nodeObjectName: string,
  nodeSchemaName: string,
  options: { allowUnqualifiedSchemaMatch?: boolean } = {},
): boolean => {
  const normalizedNodeName = toTrimmedString(nodeObjectName);
  if (!normalizedNodeName) return false;

  const nodeParsed = splitSidebarQualifiedName(normalizedNodeName);
  const targetParsed = splitSidebarQualifiedName(target.tableName);
  const nodeObject = nodeParsed.objectName || normalizedNodeName;
  const targetObject = targetParsed.objectName || target.tableName;
  const resolvedNodeSchema = toTrimmedString(nodeSchemaName) || nodeParsed.schemaName;
  const resolvedTargetSchema = toTrimmedString(target.schemaName) || targetParsed.schemaName;

  if (
    resolvedTargetSchema
    && !resolvedNodeSchema
    && normalizeLocateName(resolvedTargetSchema) === normalizeLocateName(target.dbName)
    && normalizeLocateName(nodeObject) === normalizeLocateName(targetObject)
  ) {
    return true;
  }

  if (
    options.allowUnqualifiedSchemaMatch
    && !resolvedNodeSchema
    && normalizeLocateName(nodeObject) === normalizeLocateName(targetObject)
  ) {
    return true;
  }

  if (!resolvedTargetSchema) {
    if (options.allowUnqualifiedSchemaMatch) {
      return normalizeLocateName(nodeObject) === normalizeLocateName(targetObject);
    }
    return !resolvedNodeSchema && normalizeLocateName(nodeObject) === normalizeLocateName(targetObject);
  }

  return normalizeLocateName(resolvedNodeSchema) === normalizeLocateName(resolvedTargetSchema)
    && normalizeLocateName(nodeObject) === normalizeLocateName(targetObject);
};

const matchesLocateObjectNode = (
  node: SidebarLocateTreeNodeLike,
  target: SidebarLocateTarget,
  options: { allowUnqualifiedSchemaMatch?: boolean } = {},
): boolean => {
  const dataRef = node.dataRef || {};
  const nodeObjectType = normalizeLocateName(toTrimmedString(dataRef.objectType || dataRef.objectKind));

  if (target.objectGroup === 'externalSqlFiles') {
    return node.type === 'external-sql-file'
      && normalizeExternalSQLLocatePath(dataRef.path) === normalizeExternalSQLLocatePath(target.filePath);
  }

  if (target.objectGroup === 'savedQueries') {
    return node.type === 'saved-query'
      && toTrimmedString(dataRef.id) === target.savedQueryId;
  }

  const nodeConnectionId = toTrimmedString(dataRef.id || dataRef.connectionId);
  const nodeDbName = toTrimmedString(dataRef.dbName);

  if (nodeConnectionId !== target.connectionId || nodeDbName !== target.dbName) {
    return false;
  }

  if (target.objectGroup === 'views') {
    if (node.type !== 'view' && nodeObjectType !== 'view' && nodeObjectType !== 'views') return false;
    return matchesLocateObjectName(target, toTrimmedString(dataRef.viewName || dataRef.tableName), toTrimmedString(dataRef.schemaName), options);
  }

  if (target.objectGroup === 'materializedViews') {
    if (node.type !== 'materialized-view' && nodeObjectType !== 'materialized-view' && nodeObjectType !== 'materializedviews') return false;
    return matchesLocateObjectName(target, toTrimmedString(dataRef.viewName || dataRef.tableName), toTrimmedString(dataRef.schemaName), options);
  }

  if (target.objectGroup === 'triggers') {
    if (node.type !== 'db-trigger') return false;
    return matchesLocateObjectName(target, toTrimmedString(dataRef.triggerName || dataRef.tableName), toTrimmedString(dataRef.schemaName), options);
  }

  if (target.objectGroup === 'routines') {
    if (node.type !== 'routine') return false;
    return matchesLocateObjectName(target, toTrimmedString(dataRef.routineName || dataRef.tableName), toTrimmedString(dataRef.schemaName), options);
  }

  if (target.objectGroup === 'sequences') {
    if (node.type !== 'sequence') return false;
    return matchesLocateObjectName(target, toTrimmedString(dataRef.sequenceName || dataRef.tableName), toTrimmedString(dataRef.schemaName), options);
  }

  if (target.objectGroup === 'packages') {
    if (node.type !== 'package') return false;
    return matchesLocateObjectName(target, toTrimmedString(dataRef.packageName || dataRef.tableName), toTrimmedString(dataRef.schemaName), options);
  }

  if (target.objectGroup === 'events') {
    if (node.type !== 'db-event') return false;
    return matchesLocateObjectName(target, toTrimmedString(dataRef.eventName || dataRef.tableName), toTrimmedString(dataRef.schemaName), options);
  }

  if (node.type !== 'table') return false;
  return matchesLocateObjectName(target, toTrimmedString(dataRef.tableName), toTrimmedString(dataRef.schemaName), options);
};

const findSidebarNodePathForLocateByObject = (
  nodes: SidebarLocateTreeNodeLike[],
  target: SidebarLocateTarget,
  options: { allowUnqualifiedSchemaMatch?: boolean } = {},
): string[] | null => {
  for (const node of nodes) {
    const nodeKey = String(node.key);
    if (matchesLocateObjectNode(node, target, options)) {
      return [nodeKey];
    }

    if (node.children) {
      const childPath = findSidebarNodePathForLocateByObject(node.children, target, options);
      if (childPath) {
        return [nodeKey, ...childPath];
      }
    }
  }
  return null;
};

const collectSidebarNodePathsForLocateByObject = (
  nodes: SidebarLocateTreeNodeLike[],
  target: SidebarLocateTarget,
  options: { allowUnqualifiedSchemaMatch?: boolean } = {},
  ancestorPath: string[] = [],
): string[][] => {
  const paths: string[][] = [];
  for (const node of nodes) {
    const nodeKey = String(node.key);
    const path = [...ancestorPath, nodeKey];
    if (matchesLocateObjectNode(node, target, options)) {
      paths.push(path);
    }
    if (node.children) {
      paths.push(...collectSidebarNodePathsForLocateByObject(node.children, target, options, path));
    }
  }
  return paths;
};

const getVisualNodeObjectName = (
  node: SidebarLocateTreeNodeLike,
  target: SidebarLocateTarget,
): string => {
  const title = toTrimmedString(node.title);
  if (title && title !== '[object Object]') return title;

  const nodeKey = toTrimmedString(node.key);
  const keyPrefixes = target.objectGroup === 'materializedViews'
    ? [`${target.databaseKey}-materialized-view-`]
    : target.objectGroup === 'views'
      ? [`${target.databaseKey}-view-`]
      : target.objectGroup === 'triggers'
        ? [`${target.databaseKey}-trigger-`]
        : target.objectGroup === 'routines'
          ? [`${target.databaseKey}-routine-`]
          : target.objectGroup === 'sequences'
            ? [`${target.databaseKey}-sequence-`]
            : target.objectGroup === 'packages'
              ? [`${target.databaseKey}-package-`]
              : target.objectGroup === 'events'
                ? [`${target.databaseKey}-event-`]
                : [`${target.databaseKey}-table-`, `${target.databaseKey}-`];

  const matchedPrefix = keyPrefixes.find((prefix) => nodeKey.startsWith(prefix));
  if (!matchedPrefix) return '';

  const keyName = nodeKey.slice(matchedPrefix.length);
  if (target.objectGroup !== 'tables') return keyName;

  // Table nodes use an encoded schema\u0000object identity so names that only
  // differ by schema never share an rc-tree key. Recover a qualified name for
  // the metadata-free locate fallback, while accepting historical raw keys.
  try {
    const decodedKeyName = decodeURIComponent(keyName);
    const separatorIndex = decodedKeyName.indexOf('\u0000');
    if (separatorIndex < 0) return decodedKeyName;

    const schemaName = decodedKeyName.slice(0, separatorIndex).trim();
    const objectName = decodedKeyName.slice(separatorIndex + 1).trim();
    if (!schemaName) return objectName;
    if (!objectName) return schemaName;
    return `${schemaName}.${objectName}`;
  } catch {
    return keyName;
  }
};

const getLocateObjectGroupPathSuffix = (objectGroup: SidebarLocateObjectGroup): string => {
  if (objectGroup === 'externalSqlFiles') return 'external-sql-root';
  if (objectGroup === 'savedQueries') return 'all-saved-queries';
  return objectGroup.toLowerCase();
};

const isPathInsideLocateObjectGroup = (
  path: string[],
  target: SidebarLocateTarget,
): boolean => {
  if (target.objectGroup === 'externalSqlFiles' || target.objectGroup === 'savedQueries') return false;
  const normalizedObjectGroupKey = normalizeLocateName(target.objectGroupKey);
  const groupSuffix = getLocateObjectGroupPathSuffix(target.objectGroup);
  return path.some((key) => {
    const normalizedKey = normalizeLocateName(key);
    return normalizedKey === normalizedObjectGroupKey || normalizedKey.endsWith(`-${groupSuffix}`);
  });
};

const matchesLocateObjectNodeByVisualIdentity = (
  node: SidebarLocateTreeNodeLike,
  target: SidebarLocateTarget,
  path: string[],
): boolean => {
  if (!path.includes(target.databaseKey)) return false;
  const nodeObjectType = normalizeLocateName(toTrimmedString(node.dataRef?.objectType || node.dataRef?.objectKind));
  const insideExpectedGroup = isPathInsideLocateObjectGroup(path, target);

  if (target.objectGroup === 'views' && node.type !== 'view' && nodeObjectType !== 'view' && nodeObjectType !== 'views' && !insideExpectedGroup) return false;
  if (target.objectGroup === 'materializedViews' && node.type !== 'materialized-view' && nodeObjectType !== 'materialized-view' && nodeObjectType !== 'materializedviews' && !insideExpectedGroup) return false;
  if (target.objectGroup === 'triggers' && node.type !== 'db-trigger' && !insideExpectedGroup) return false;
  if (target.objectGroup === 'routines' && node.type !== 'routine' && !insideExpectedGroup) return false;
  if (target.objectGroup === 'sequences' && node.type !== 'sequence' && !insideExpectedGroup) return false;
  if (target.objectGroup === 'packages' && node.type !== 'package' && !insideExpectedGroup) return false;
  if (target.objectGroup === 'events' && node.type !== 'db-event' && !insideExpectedGroup) return false;
  if (target.objectGroup === 'tables' && node.type !== 'table' && !insideExpectedGroup) return false;
  if (target.objectGroup === 'externalSqlFiles' || target.objectGroup === 'savedQueries') return false;

  const schemaName = toTrimmedString(node.dataRef?.schemaName);
  return matchesLocateObjectName(target, getVisualNodeObjectName(node, target), schemaName, { allowUnqualifiedSchemaMatch: true });
};

const collectSidebarNodePathsForLocateByVisualIdentity = (
  nodes: SidebarLocateTreeNodeLike[],
  target: SidebarLocateTarget,
  ancestorPath: string[] = [],
): string[][] => {
  const paths: string[][] = [];
  for (const node of nodes) {
    const nodeKey = String(node.key);
    const path = [...ancestorPath, nodeKey];
    if (matchesLocateObjectNodeByVisualIdentity(node, target, path)) {
      paths.push(path);
    }
    if (node.children) {
      paths.push(...collectSidebarNodePathsForLocateByVisualIdentity(node.children, target, path));
    }
  }
  return paths;
};

const hasLocateTargetSchema = (target: SidebarLocateTarget): boolean => {
  if (target.objectGroup === 'externalSqlFiles') return true;
  return Boolean(toTrimmedString(target.schemaName) || splitSidebarQualifiedName(target.tableName).schemaName);
};

const shouldFallbackViewLocateToTableNode = (target: SidebarLocateTarget): boolean => (
  target.objectGroup === 'views' || target.objectGroup === 'materializedViews'
);

const selectPreferredSidebarLocatePath = (
  paths: string[][],
  target: SidebarLocateTarget,
): string[] | null => {
  if (paths.length === 1) return paths[0];
  if (paths.length === 0 || target.objectGroup === 'externalSqlFiles' || target.objectGroup === 'savedQueries') return null;

  const targetParsed = splitSidebarQualifiedName(target.tableName);
  const targetObjectName = normalizeLocateName(targetParsed.objectName || target.tableName);
  const schemaCandidates = [
    toTrimmedString(target.schemaName),
    targetParsed.schemaName,
    target.dbName,
  ].filter(Boolean);
  const seenSchemaNames = new Set<string>();

  for (const schemaCandidate of schemaCandidates) {
    const normalizedSchema = normalizeLocateName(schemaCandidate);
    if (seenSchemaNames.has(normalizedSchema)) continue;
    seenSchemaNames.add(normalizedSchema);
    const preferredSchemaKeys = [
      buildSidebarSchemaNodeKey(target.databaseKey, schemaCandidate),
      buildSidebarSchemaNodeKey(target.databaseKey, normalizedSchema),
      // Existing expanded trees can still contain pre-schema-identity keys.
      // Prefer the current encoding, but accept the legacy form while the tree
      // is being refreshed after an upgrade.
      buildLegacySidebarSchemaNodeKey(target.databaseKey, schemaCandidate),
      buildLegacySidebarSchemaNodeKey(target.databaseKey, normalizedSchema),
    ].map(normalizeLocateName);
    const bySchemaGroup = paths.filter((path) =>
      path.some((key) => preferredSchemaKeys.includes(normalizeLocateName(key))),
    );
    if (bySchemaGroup.length === 1) return bySchemaGroup[0];

    const qualifiedSuffix = `${normalizedSchema}.${targetObjectName}`;
    const byQualifiedLeafKey = paths.filter((path) => {
      const leafKey = normalizeLocateName(path[path.length - 1] || '');
      return leafKey.endsWith(qualifiedSuffix);
    });
    if (byQualifiedLeafKey.length === 1) return byQualifiedLeafKey[0];
  }

  return null;
};

export const findSidebarNodePathForLocate = (
  nodes: SidebarLocateTreeNodeLike[],
  target: SidebarLocateTarget,
): string[] | null => {
  const exactPath = findSidebarNodePathByKey(nodes, target.targetKey);
  if (exactPath) return exactPath;

  const strictPath = findSidebarNodePathForLocateByObject(nodes, target);
  if (strictPath) return strictPath;

  const visualIdentityPaths = collectSidebarNodePathsForLocateByVisualIdentity(nodes, target);
  const visualIdentityPath = selectPreferredSidebarLocatePath(visualIdentityPaths, target);
  if (visualIdentityPath) return visualIdentityPath;

  if (shouldFallbackViewLocateToTableNode(target)) {
    const tableLikeTarget = { ...target, objectGroup: 'tables' as const };
    const tableLikePaths = collectSidebarNodePathsForLocateByObject(nodes, tableLikeTarget);
    const tableLikePath = selectPreferredSidebarLocatePath(tableLikePaths, target);
    if (tableLikePath) return tableLikePath;
    const visualTableLikePaths = collectSidebarNodePathsForLocateByVisualIdentity(nodes, tableLikeTarget);
    const visualTableLikePath = selectPreferredSidebarLocatePath(visualTableLikePaths, target);
    if (visualTableLikePath) return visualTableLikePath;
    if (!hasLocateTargetSchema(target)) {
      const relaxedTableLikePaths = collectSidebarNodePathsForLocateByObject(
        nodes,
        tableLikeTarget,
        { allowUnqualifiedSchemaMatch: true },
      );
      const relaxedTableLikePath = selectPreferredSidebarLocatePath(relaxedTableLikePaths, target);
      if (relaxedTableLikePath) return relaxedTableLikePath;
    }
  }

  const relaxedPaths = collectSidebarNodePathsForLocateByObject(
    nodes,
    target,
    { allowUnqualifiedSchemaMatch: true },
  );
  const relaxedPath = selectPreferredSidebarLocatePath(relaxedPaths, target);
  if (relaxedPath) return relaxedPath;

  if (hasLocateTargetSchema(target)) return null;

  return null;
};
