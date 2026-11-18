export type ObjectInfoTarget =
  | {
      kind: 'table';
      connectionId: string;
      dbName: string;
      schemaName?: string;
      tableName: string;
    }
  | {
      kind: 'database';
      connectionId: string;
      dbName: string;
      schemaName?: string;
    };

type ObjectInfoActiveContextLike = {
  connectionId?: string;
  dbName?: string;
  schemaName?: string;
  tableName?: string;
} | null | undefined;

type ObjectInfoActiveTabLike = {
  type?: string;
  connectionId?: string;
  dbName?: string;
  schemaName?: string;
  tableName?: string;
} | null | undefined;

const trimmed = (value: unknown): string => String(value ?? '').trim();

export const resolveObjectInfoTarget = (
  activeContext: ObjectInfoActiveContextLike,
  activeTab: ObjectInfoActiveTabLike,
): ObjectInfoTarget | null => {
  const contextConnectionId = trimmed(activeContext?.connectionId);
  const contextDbName = trimmed(activeContext?.dbName);
  if (contextConnectionId && contextDbName) {
    const tableName = trimmed(activeContext?.tableName);
    if (tableName) {
      return {
        kind: 'table',
        connectionId: contextConnectionId,
        dbName: contextDbName,
        schemaName: trimmed(activeContext?.schemaName) || undefined,
        tableName,
      };
    }
    return {
      kind: 'database',
      connectionId: contextConnectionId,
      dbName: contextDbName,
      schemaName: trimmed(activeContext?.schemaName) || undefined,
    };
  }

  const tabConnectionId = trimmed(activeTab?.connectionId);
  const tabDbName = trimmed(activeTab?.dbName);
  if (!tabConnectionId || !tabDbName) return null;
  const tabTableName = activeTab?.type === 'table' || activeTab?.type === 'design'
    ? trimmed(activeTab.tableName)
    : '';
  if (tabTableName) {
    return {
      kind: 'table',
      connectionId: tabConnectionId,
      dbName: tabDbName,
      schemaName: trimmed(activeTab?.schemaName) || undefined,
      tableName: tabTableName,
    };
  }
  return {
    kind: 'database',
    connectionId: tabConnectionId,
    dbName: tabDbName,
    schemaName: trimmed(activeTab?.schemaName) || undefined,
  };
};
