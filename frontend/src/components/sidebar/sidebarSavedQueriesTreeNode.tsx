import { GnSqlDocIcon, GnDatabaseIcon, GnFolderOpenIcon, GnFolderIcon } from '../icons/gnIcons';
import { WarningOutlined } from '@ant-design/icons';
import { SavedQuery, SavedConnection, SavedQueryGroup } from '../../types';
import { getDbIcon } from '../DatabaseIcons';
import {
  resolveConnectionIconType,
  resolveConnectionAccentColor,
} from '../../utils/connectionVisual';
import {
  normalizeSavedQueryGroups,
  getSavedQueryGroupOwnerIds,
  resolveSavedQueryGroupChildOrder,
  isSavedQueryGroupQueryToken,
  getSavedQueryIdFromGroupToken,
  isSavedQueryGroupToken,
  getSavedQueryGroupIdFromToken,
} from '../../utils/savedQueryGroups';
import { t } from '../../i18n';
import type { SidebarTreeNode as TreeNode } from '../sidebarV2Utils';
import { isSavedQueryUnmatchedForConnectionIds } from './sidebarRootHelpers';

export const buildAllSavedQueriesTreeNode = (
  savedQueries: SavedQuery[],
  connections: SavedConnection[],
  savedQueryGroups: SavedQueryGroup[] = [],
): TreeNode | null => {
  const normalizedGroups = normalizeSavedQueryGroups(
    savedQueryGroups,
    savedQueries.map((query) => query.id),
  );
  if (savedQueries.length === 0 && normalizedGroups.length === 0) {
      return null;
  }

  const createQueryNode = (query: SavedQuery): TreeNode => ({
      title: query.name || t('sidebar.tree.untitled_query'),
      key: `all-saved-query-${query.id}`,
      icon: <GnSqlDocIcon />,
      type: 'saved-query',
      dataRef: query,
      isLeaf: true,
  });
  const buildDatabaseGroups = (queries: SavedQuery[], keyPrefix: string): TreeNode[] => {
      const groupedByDatabase = new Map<string, SavedQuery[]>();
      queries.forEach((query) => {
          const dbName = String(query.dbName || '').trim() || t('sidebar.tree.default_database');
          groupedByDatabase.set(dbName, [...(groupedByDatabase.get(dbName) || []), query]);
      });
      return Array.from(groupedByDatabase.entries()).map(([dbName, items]) => ({
          title: dbName,
          key: `${keyPrefix}-db-${encodeURIComponent(dbName)}`,
          icon: <GnDatabaseIcon />,
          type: 'saved-query-group',
          selectable: false,
          isLeaf: false,
          children: items.map(createQueryNode),
      }));
  };

  const buildAutomaticChildren = (queries: SavedQuery[]): TreeNode[] => {
      const connectionIds = new Set(connections.map((conn) => conn.id));
      const unmatchedSavedQueries = queries.filter((query) => isSavedQueryUnmatchedForConnectionIds(query, connectionIds));
      const unmatchedIds = new Set(unmatchedSavedQueries.map((query) => query.id));
      const groupedByConnection = new Map<string, SavedQuery[]>();
      queries.forEach((query) => {
          if (unmatchedIds.has(query.id)) return;
          groupedByConnection.set(query.connectionId, [
              ...(groupedByConnection.get(query.connectionId) || []),
              query,
          ]);
      });

      const automaticChildren: TreeNode[] = [];
      connections.forEach((conn) => {
          const connectionQueries = groupedByConnection.get(conn.id);
          if (!connectionQueries || connectionQueries.length === 0) return;
          const iconType = resolveConnectionIconType(conn);
          const iconColor = resolveConnectionAccentColor(conn);
          automaticChildren.push({
              title: conn.name || conn.id,
              key: `all-saved-queries-connection-${conn.id}`,
              icon: getDbIcon(iconType, iconColor, 20),
              type: 'saved-query-group',
              selectable: false,
              isLeaf: false,
              children: buildDatabaseGroups(connectionQueries, `all-saved-queries-connection-${conn.id}`),
          });
      });

      if (unmatchedSavedQueries.length > 0) {
          const groupedByOriginalConnection = new Map<string, SavedQuery[]>();
          unmatchedSavedQueries.forEach((query) => {
              const originalConnectionId = String(query.originalConnectionId || query.connectionId || t('sidebar.tree.unknown_connection')).trim() || t('sidebar.tree.unknown_connection');
              groupedByOriginalConnection.set(originalConnectionId, [
                  ...(groupedByOriginalConnection.get(originalConnectionId) || []),
                  query,
              ]);
          });
          automaticChildren.push({
              title: t('sidebar.tree.unmatched_saved_queries'),
              key: 'all-saved-queries-unmatched',
              icon: <WarningOutlined />,
              type: 'saved-query-group',
              selectable: false,
              isLeaf: false,
              children: Array.from(groupedByOriginalConnection.entries()).map(([connectionLabel, items]) => ({
                  title: connectionLabel,
                  key: `all-saved-queries-unmatched-${encodeURIComponent(connectionLabel)}`,
                  icon: <GnFolderOpenIcon />,
                  type: 'saved-query-group',
                  selectable: false,
                  isLeaf: false,
                  children: buildDatabaseGroups(items, `all-saved-queries-unmatched-${encodeURIComponent(connectionLabel)}`),
              })),
          });
      }
      return automaticChildren;
  };

  const queryById = new Map(savedQueries.map((query) => [query.id, query]));
  const groupById = new Map(normalizedGroups.map((group) => [group.id, group]));
  const groupOwners = getSavedQueryGroupOwnerIds(normalizedGroups);
  const buildManualGroupNode = (group: SavedQueryGroup, ancestors = new Set<string>()): TreeNode => {
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(group.id);
      const children = resolveSavedQueryGroupChildOrder(group.id, normalizedGroups).flatMap((token): TreeNode[] => {
          if (isSavedQueryGroupQueryToken(token)) {
              const query = queryById.get(getSavedQueryIdFromGroupToken(token));
              return query ? [createQueryNode(query)] : [];
          }
          if (isSavedQueryGroupToken(token)) {
              const childGroupId = getSavedQueryGroupIdFromToken(token);
              const childGroup = groupById.get(childGroupId);
              if (!childGroup || childGroup.parentGroupId !== group.id || nextAncestors.has(childGroup.id)) return [];
              return [buildManualGroupNode(childGroup, nextAncestors)];
          }
          return [];
      });
      return {
          title: group.name || t('sidebar.saved_query_group.untitled'),
          key: `saved-query-manual-group-${group.id}`,
          icon: <GnFolderIcon />,
          type: 'saved-query-manual-group',
          dataRef: group,
          selectable: false,
          isLeaf: false,
          children,
      };
  };

  const automaticChildren = buildAutomaticChildren(
      savedQueries.filter((query) => !groupOwners.has(query.id)),
  );
  const children: TreeNode[] = normalizedGroups
      .filter((group) => !group.parentGroupId)
      .map((group) => buildManualGroupNode(group));

  if (normalizedGroups.length === 0) {
      children.push(...automaticChildren);
  } else if (automaticChildren.length > 0) {
      children.push({
          title: t('sidebar.tree.ungrouped_saved_queries'),
          key: 'all-saved-queries-ungrouped',
          icon: <GnFolderOpenIcon />,
          type: 'saved-query-group',
          selectable: false,
          isLeaf: false,
          children: automaticChildren,
      });
  }

  return {
      title: t('sidebar.tree.all_saved_queries'),
      key: 'all-saved-queries',
      icon: (
        <span className="gn-v2-tree-folder-icon" data-sidebar-tree-folder-icon="true">
          <GnFolderOpenIcon />
        </span>
      ),
      type: 'all-saved-queries',
      isLeaf: false,
      selectable: false,
      children,
  };
};
