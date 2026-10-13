import type { SavedConnection, TabData } from '../../types';

/**
 * 「视图 / 函数」对象列表页（object-overview tab）的领域模型。
 *
 * 表列表沿用 TableOverview（table-overview tab），这里只承接尚没有列表页的
 * 对象种类：视图与函数/存储过程。数据复用侧栏的元数据加载器，保证与左侧
 * 树看到的对象集合一致。
 */

export type ObjectListKind = 'views' | 'routines' | 'events';

export interface ObjectOverviewRow {
  /** 展示名：视图为（可能带 schema 前缀的）视图名，函数为全限定名。 */
  name: string;
  /** 例程种类：FUNCTION / PROCEDURE；视图无此字段。 */
  subType?: string;
}

export interface ObjectListLoadResult {
  rows: ObjectOverviewRow[];
  /** 驱动是否支持该对象种类（例如部分 NoSQL 无视图概念）。 */
  supported: boolean;
  failureMessage?: string;
}

export type ObjectListLoader = (
  connection: SavedConnection,
  dbName: string,
) => Promise<ObjectListLoadResult>;

export const isObjectListKind = (value: unknown): value is ObjectListKind => (
  value === 'views' || value === 'routines' || value === 'events'
);

export const resolveObjectListKind = (value: unknown): ObjectListKind => (
  isObjectListKind(value) ? value : 'views'
);

/** 双击行时的打开动作：视图进数据网格（objectType=view），例程进定义查看器。 */
export const buildObjectOpenTab = (
  kind: ObjectListKind,
  connection: SavedConnection,
  dbName: string,
  schemaName: string | undefined,
  row: ObjectOverviewRow,
  t: (key: string, vars?: Record<string, string | number>) => string,
): TabData => {
  if (kind === 'views') {
    return {
      id: `${connection.id}-${dbName}${schemaName ? `-${schemaName}` : ''}-${row.name}`,
      title: row.name,
      type: 'table',
      connectionId: connection.id,
      dbName,
      tableName: row.name,
      objectType: 'view',
      ...(schemaName ? { schemaName } : {}),
    } as TabData;
  }
  if (kind === 'events') {
    return {
      id: `routine-def-${connection.id}-${dbName}${schemaName ? `-${schemaName}` : ''}-event-${row.name}`,
      title: t('sidebar.tab.event', { name: row.name }),
      type: 'event-def',
      connectionId: connection.id,
      dbName,
      eventName: row.name,
      ...(schemaName ? { schemaName } : {}),
    } as TabData;
  }
  const typeLabel = t(row.subType === 'PROCEDURE' ? 'sidebar.object.procedure' : 'sidebar.object.function');
  return {
    id: `routine-def-${connection.id}-${dbName}${schemaName ? `-${schemaName}` : ''}-${row.name}-${row.subType || 'FUNCTION'}`,
    title: t('sidebar.tab.routine_definition', { type: typeLabel, name: row.name }),
    type: 'routine-def',
    connectionId: connection.id,
    dbName,
    routineName: row.name,
    routineType: row.subType || 'FUNCTION',
    ...(schemaName ? { schemaName } : {}),
  } as TabData;
};
