import { type MenuProps } from 'antd';
import type { SavedConnection } from '../../types';
import { type SidebarNodeMenuContext } from './sidebarNodeMenuHelpers';
import { buildExternalSqlFileMenuItems } from './sidebarNodeMenuExternalSql';
import { buildExternalSqlFolderMenuItems } from './sidebarNodeMenuExternalSql';
import { buildExternalSqlDirectoryMenuItems } from './sidebarNodeMenuExternalSql';
import { buildExternalSqlRootMenuItems } from './sidebarNodeMenuExternalSql';
import { buildSavedQueryMenuItems } from './sidebarNodeMenuSavedQueries';
import { buildSavedQueryManualGroupMenuItems } from './sidebarNodeMenuSavedQueries';
import { buildAllSavedQueriesMenuItems } from './sidebarNodeMenuSavedQueries';
import { buildTableNodeMenuItems } from './sidebarNodeMenuObjects';
import { buildMessageObjectMenuItems } from './sidebarNodeMenuObjects';
import { buildMessageNamespaceMenuItems } from './sidebarNodeMenuObjects';
import { buildDbEventMenuItems } from './sidebarNodeMenuObjects';
import { buildDatabaseLinkMenuItems } from './sidebarNodeMenuObjects';
import { buildPackageMenuItems } from './sidebarNodeMenuObjects';
import { buildSequenceMenuItems } from './sidebarNodeMenuObjects';
import { buildDbTriggerMenuItems } from './sidebarNodeMenuObjects';
import { buildRoutineMenuItems } from './sidebarNodeMenuObjects';
import { buildMaterializedViewMenuItems } from './sidebarNodeMenuObjects';
import { buildViewMenuItems } from './sidebarNodeMenuObjects';
import { buildDatabaseNodeMenuItems } from './sidebarNodeMenuDatabase';
import { buildRedisDbMenuItems } from './sidebarNodeMenuDatabase';
import { buildNacosServiceGroupMenuItems } from './sidebarNodeMenuNacos';
import { buildNacosConfigGroupMenuItems } from './sidebarNodeMenuNacos';
import { buildNacosEntryMenuItems } from './sidebarNodeMenuNacos';
import { buildNacosNamespaceMenuItems } from './sidebarNodeMenuNacos';
import { buildConnectionNodeMenuItems } from './sidebarNodeMenuConnection';
import { buildTagNodeMenuItems } from './sidebarNodeMenuObjectGroups';
import { buildEventsGroupMenuItems } from './sidebarNodeMenuObjectGroups';
import { buildRoutinesGroupMenuItems } from './sidebarNodeMenuObjectGroups';
import { buildMaterializedViewsGroupMenuItems } from './sidebarNodeMenuObjectGroups';
import { buildViewsGroupMenuItems } from './sidebarNodeMenuObjectGroups';
import { buildTablesGroupMenuItems } from './sidebarNodeMenuObjectGroups';
import { buildSchemaGroupMenuItems } from './sidebarNodeMenuObjectGroups';
export type { SidebarNodeMenuContext } from './sidebarNodeMenuHelpers';

export const buildSidebarNodeMenuItems = (
  node: any,
  context: SidebarNodeMenuContext,
): MenuProps['items'] => {
  const { loadDatabases, refreshConnectionResources: refreshConnectionResourcesFromContext } = context;
    const refreshConnectionResources = refreshConnectionResourcesFromContext || ((targetNode: any) => {
      loadDatabases(targetNode);
      return Promise.resolve();
    });
    const conn = node.dataRef as SavedConnection;
    const isRedis = conn?.config?.type === 'redis';
    const isNacos = conn?.config?.type === 'nacos';

    if (node.type === 'object-group' && node.dataRef?.groupKey === 'schema') {
        return buildSchemaGroupMenuItems({ node, context });
    }

    // 表分组节点的右键菜单
    if (node.type === 'object-group' && node.dataRef?.groupKey === 'tables') {
        return buildTablesGroupMenuItems({ node, context });
    }

    // 视图分组节点的右键菜单
    if (node.type === 'object-group' && node.dataRef?.groupKey === 'views') {
        return buildViewsGroupMenuItems({ node, context });
    }

    if (node.type === 'object-group' && node.dataRef?.groupKey === 'materializedViews') {
        return buildMaterializedViewsGroupMenuItems({ node, context });
    }

    // 函数分组节点的右键菜单
    if (node.type === 'object-group' && node.dataRef?.groupKey === 'routines') {
        return buildRoutinesGroupMenuItems({ node, context });
    }

    if (node.type === 'object-group' && node.dataRef?.groupKey === 'events') {
        return buildEventsGroupMenuItems({ node, context });
    }

    // Connection Tag Menu — must be BEFORE the connection check
    if (node.type === 'tag') {
        return buildTagNodeMenuItems({ node, context });
    }

    if (node.type === 'connection') {
        return buildConnectionNodeMenuItems({ isRedis, refreshConnectionResources, node, isNacos, conn, context });
    } else if (node.type === 'nacos-namespace') {
        return buildNacosNamespaceMenuItems({ node, context });
    } else if (node.type === 'nacos-config-entry' || node.type === 'nacos-services-entry') {
        return buildNacosEntryMenuItems({ node, context });
    } else if (node.type === 'nacos-config-group') {
        return buildNacosConfigGroupMenuItems({ node, context });
    } else if (node.type === 'nacos-service-group') {
        return buildNacosServiceGroupMenuItems({ node, context });
    } else if (node.type === 'redis-db') {
        return buildRedisDbMenuItems({ node, context });
    } else if (node.type === 'database') {
       return buildDatabaseNodeMenuItems({ node, context });
    } else if (node.type === 'view') {
        return buildViewMenuItems({ node, context });
    } else if (node.type === 'materialized-view') {
        return buildMaterializedViewMenuItems({ node, context });
    } else if (node.type === 'routine') {
        return buildRoutineMenuItems({ node, context });
    } else if (node.type === 'db-trigger') {
        return buildDbTriggerMenuItems({ node, context });
    } else if (node.type === 'sequence') {
        return buildSequenceMenuItems({ node, context });
    } else if (node.type === 'package') {
        return buildPackageMenuItems({ node, context });
    } else if (node.type === 'database-link') {
        return buildDatabaseLinkMenuItems({ node, context });
    } else if (node.type === 'db-event') {
        return buildDbEventMenuItems({ node, context });
    } else if (node.type === 'message-namespace' || node.type === 'message-object-group') {
        return buildMessageNamespaceMenuItems({ node, context });
    } else if (node.type === 'message-object') {
        return buildMessageObjectMenuItems({ node, context });
    } else if (node.type === 'table') {
        return buildTableNodeMenuItems({ node, context });
    }

    if (node.type === 'all-saved-queries') {
        return buildAllSavedQueriesMenuItems({ context });
    }

    if (node.type === 'saved-query-manual-group') {
        return buildSavedQueryManualGroupMenuItems({ node, context });
    }

    // 已存查询节点的右键菜单
    if (node.type === 'saved-query') {
        return buildSavedQueryMenuItems({ node, context });
    }

    if (node.type === 'external-sql-root') {
        return buildExternalSqlRootMenuItems({ node, context });
    }

    if (node.type === 'external-sql-directory') {
        return buildExternalSqlDirectoryMenuItems({ node, context });
    }

    if (node.type === 'external-sql-folder') {
        return buildExternalSqlFolderMenuItems({ node, context });
    }

    if (node.type === 'external-sql-file') {
        return buildExternalSqlFileMenuItems({ node, context });
    }

    return [];
  };
