import type { TabData } from '../../types';
import { t } from '../../i18n';

/** 对象概览页的种类：表 / 视图 / 函数 / 事件。表走既有 table-overview，其余走 object-overview。 */
export type ObjectOverviewKind = 'tables' | 'views' | 'routines' | 'events';

export interface ObjectOverviewContext {
  connectionId: string;
  dbName: string;
  schemaName?: string;
}

const isNonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** 概览 tab 的稳定 id：同连接同库同种类只开一个，addTab 按 id 去重并切换。 */
export const buildObjectOverviewTabId = (kind: ObjectOverviewKind, context: ObjectOverviewContext): string => {
  const schemaSuffix = isNonEmpty(context.schemaName) ? `-${context.schemaName}` : '';
  const prefix = kind === 'tables' ? 'table-overview' : `object-overview-${kind}`;
  return `${prefix}-${context.connectionId}-${context.dbName}${schemaSuffix}`;
};

export const buildObjectOverviewTab = (kind: ObjectOverviewKind, context: ObjectOverviewContext): TabData => {
  if (kind === 'tables') {
    return {
      id: buildObjectOverviewTabId(kind, context),
      title: t('sidebar.tab.table_overview', {
        database: context.dbName,
        schema: isNonEmpty(context.schemaName) ? ` (${context.schemaName})` : '',
      }),
      type: 'table-overview',
      connectionId: context.connectionId,
      dbName: context.dbName,
      ...(isNonEmpty(context.schemaName) ? { schemaName: context.schemaName } : {}),
    } as TabData;
  }
  return {
    id: buildObjectOverviewTabId(kind, context),
    title: t(kind === 'views'
      ? 'object_overview.title.views'
      : kind === 'events' ? 'object_overview.title.events' : 'object_overview.title.routines', {
      database: context.dbName,
      schema: isNonEmpty(context.schemaName) ? ` (${context.schemaName})` : '',
    }),
    type: 'object-overview',
    connectionId: context.connectionId,
    dbName: context.dbName,
    overviewKind: kind,
    ...(isNonEmpty(context.schemaName) ? { schemaName: context.schemaName } : {}),
  } as TabData;
};

export const openObjectOverview = (
  addTab: (tab: TabData) => void,
  kind: ObjectOverviewKind,
  context: ObjectOverviewContext,
): void => {
  if (!isNonEmpty(context.connectionId) || !isNonEmpty(context.dbName)) return;
  addTab(buildObjectOverviewTab(kind, context));
};
