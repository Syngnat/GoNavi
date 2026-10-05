import type { MenuProps } from 'antd';
import { t } from '../../i18n';
import { GnNewConnectionIcon, GnNewQueryIcon } from '../icons/gnIcons';
import {
  EditOutlined, FolderAddOutlined, DeleteOutlined, PlusOutlined, TableOutlined, ReloadOutlined,
  CheckSquareOutlined, ExportOutlined, SaveOutlined,
} from '@ant-design/icons';
import Modal from '../common/ResizableDraggableModal';
import type { SidebarNodeMenuContext } from './sidebarNodeMenuHelpers';
import type { SavedConnection } from '../../types';

export interface BuildTagNodeMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildTagNodeMenuItems = ({ node, context }: BuildTagNodeMenuItemsInput): MenuProps['items'] => {
  const {
    onCreateConnectionInGroup, createTagForm, setRenameViewTarget, setIsCreateTagModalOpen,
    removeConnectionTag,
  } = context;
  const tagId = String(node.dataRef?.id || '').trim();
  const newConnectionItems: NonNullable<MenuProps['items']> = tagId && typeof onCreateConnectionInGroup === 'function'
      ? [
          {
              key: 'new-connection-in-tag',
              label: t('connection.new'),
              icon: <GnNewConnectionIcon />,
              onClick: () => onCreateConnectionInGroup?.(tagId),
          },
          { type: 'divider' },
      ]
      : [];
  return [
      ...newConnectionItems,
      {
          key: 'edit-tag',
          label: t('sidebar.menu.edit_tag'),
          icon: <EditOutlined />,
          onClick: () => {
              createTagForm.setFieldsValue({
                  name: node.title,
                  parentTagId: node.dataRef.parentTagId,
                  connectionIds: node.dataRef.connectionIds,
              });
              setRenameViewTarget(node);
              setIsCreateTagModalOpen(true);
          }
      },
      {
          key: 'new-child-tag',
          label: t('connection.sidebar.group.newSubgroup'),
          icon: <FolderAddOutlined />,
          onClick: () => {
              createTagForm.resetFields();
              createTagForm.setFieldsValue({
                  parentTagId: node.dataRef.id,
                  connectionIds: [],
              });
              setRenameViewTarget(null);
              setIsCreateTagModalOpen(true);
          }
      },
      { type: 'divider' },
      {
          key: 'delete-tag',
          label: t('sidebar.menu.delete_tag'),
          icon: <DeleteOutlined />,
          danger: true,
          onClick: () => {
              Modal.confirm({
                  title: t('sidebar.modal.confirm_delete.title'),
                  content: t('sidebar.modal.confirm_delete_tag.content', { name: node.title }),
                  onOk: () => {
                      removeConnectionTag(node.dataRef.id);
                  }
              });
          }
      }
  ];
};

export interface BuildEventsGroupMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildEventsGroupMenuItems = ({ node, context }: BuildEventsGroupMenuItemsInput): MenuProps['items'] => {
  const { addTab } = context;
  return [
      {
          key: 'create-event-query',
          label: t('sidebar.menu.create_event'),
          icon: <PlusOutlined />,
          onClick: () => {
              addTab({
                  id: `query-create-event-${Date.now()}`,
                  title: t('sidebar.tab.new_event'),
                  type: 'query',
                  connectionId: node.dataRef.id,
                  dbName: node.dataRef.dbName,
                  query: `CREATE EVENT event_name\nON SCHEDULE EVERY 1 DAY\nDO\nBEGIN\n    -- event body\nEND;`
              });
          }
      },
  ];
};

export interface BuildRoutinesGroupMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildRoutinesGroupMenuItems = ({ node, context }: BuildRoutinesGroupMenuItemsInput): MenuProps['items'] => {
  const { getMetadataDialect, openCreateRoutine } = context;
  const dialect = getMetadataDialect(node.dataRef as SavedConnection);
  const routineMenu: MenuProps['items'] = [
      {
          key: 'create-function',
          label: t('sidebar.tab.create_function'),
          icon: <PlusOutlined />,
          onClick: () => openCreateRoutine(node, 'FUNCTION')
      },
  ];
  if (dialect !== 'duckdb') {
      routineMenu.push({
          key: 'create-procedure',
          label: t('sidebar.tab.create_procedure'),
          icon: <PlusOutlined />,
          onClick: () => openCreateRoutine(node, 'PROCEDURE')
      });
  }
  return routineMenu;
};

export interface BuildMaterializedViewsGroupMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildMaterializedViewsGroupMenuItems = ({ node, context }: BuildMaterializedViewsGroupMenuItemsInput): MenuProps['items'] => {
  const { openCreateStarRocksMaterializedView } = context;
  return [
      {
          key: 'create-materialized-view',
          label: t('sidebar.v2_database_menu.new_materialized_view'),
          icon: <PlusOutlined />,
          onClick: () => openCreateStarRocksMaterializedView(node)
      },
  ];
};

export interface BuildViewsGroupMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildViewsGroupMenuItems = ({ node, context }: BuildViewsGroupMenuItemsInput): MenuProps['items'] => {
  const { openCreateView } = context;
  return [
      {
          key: 'create-view',
          label: t('sidebar.menu.create_view'),
          icon: <PlusOutlined />,
          onClick: () => openCreateView(node)
      },
  ];
};

export interface BuildTablesGroupMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildTablesGroupMenuItems = ({ node, context }: BuildTablesGroupMenuItemsInput): MenuProps['items'] => {
  const {
    tableSortPreference, isStructureOnlyDbType, openNewTableDesign, loadTables,
    handleTableGroupSortAction,
  } = context;
  const groupData = node.dataRef; // { ...conn, dbName, groupKey }
  const sortPreferenceKey = `${groupData.id}-${groupData.dbName}`;
  const currentSort = tableSortPreference[sortPreferenceKey] || 'name';
  const canCreateTable = !isStructureOnlyDbType(String(groupData.id || ''));

  return [
      ...(canCreateTable ? [{
          key: 'new-table',
          label: t('sidebar.menu.new_table'),
          icon: <TableOutlined />,
          onClick: () => openNewTableDesign(node)
      }] : []),
      {
          key: 'refresh-tables',
          label: t('sidebar.menu.refresh'),
          icon: <ReloadOutlined />,
          onClick: () => {
              const dbNode = {
                  key: `${groupData.id}-${groupData.dbName}`,
                  dataRef: groupData,
              };
              void loadTables(dbNode);
          },
      },
      { type: 'divider' },
      {
          key: 'sort-by-name',
          label: t('sidebar.menu.sort_by_name'),
          icon: currentSort === 'name' ? <CheckSquareOutlined /> : null,
          onClick: () => handleTableGroupSortAction(node, 'name')
      },
      {
          key: 'sort-by-frequency',
          label: t('sidebar.menu.sort_by_frequency'),
          icon: currentSort === 'frequency' ? <CheckSquareOutlined /> : null,
          onClick: () => handleTableGroupSortAction(node, 'frequency')
      }
  ];
};

export interface BuildSchemaGroupMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildSchemaGroupMenuItems = ({ node, context }: BuildSchemaGroupMenuItemsInput): MenuProps['items'] => {
  const {
    getMetadataDialect, isPostgresSchemaDialect, handleV2DatabaseContextMenuAction,
    openRenameSchemaModal, loadTables, getDatabaseNodeRef, handleExportSchemaSQL,
    handleDeleteSchema,
  } = context;
  const dialect = getMetadataDialect(node.dataRef as SavedConnection);
  const schemaName = String(node?.dataRef?.schemaName || '').trim();
  if (!isPostgresSchemaDialect(dialect) || !schemaName) {
      return [];
  }
  return [
      {
          key: 'new-query',
          label: t('sidebar.menu.new_query'),
          icon: <GnNewQueryIcon />,
          onClick: () => handleV2DatabaseContextMenuAction(node, 'new-query'),
      },
      {
          key: 'rename-schema',
          label: t('sidebar.menu.edit_schema'),
          icon: <EditOutlined />,
          onClick: () => openRenameSchemaModal(node)
      },
      {
          key: 'refresh-schema',
          label: t('sidebar.menu.refresh'),
          icon: <ReloadOutlined />,
          onClick: () => void loadTables(
              getDatabaseNodeRef(node.dataRef, node.dataRef.dbName),
              { ensureFresh: true },
          )
      },
      {
          key: 'export-schema',
          label: t('sidebar.menu.export_current_schema_sql'),
          icon: <ExportOutlined />,
          onClick: () => void handleExportSchemaSQL(node, false)
      },
      {
          key: 'backup-schema-sql',
          label: t('sidebar.menu.backup_current_schema_sql'),
          icon: <SaveOutlined />,
          onClick: () => void handleExportSchemaSQL(node, true)
      },
      { type: 'divider' },
      {
          key: 'drop-schema',
          label: t('sidebar.menu.delete_schema'),
          icon: <DeleteOutlined />,
          danger: true,
          onClick: () => handleDeleteSchema(node)
      },
  ];
};
