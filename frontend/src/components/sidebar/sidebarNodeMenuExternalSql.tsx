import { t } from '../../i18n';
import {
  ConsoleSqlOutlined, LinkOutlined, EditOutlined, FileAddOutlined, FolderAddOutlined,
  DeleteOutlined, ReloadOutlined, PlusOutlined,
} from '@ant-design/icons';
import type { SidebarNodeMenuContext } from './sidebarNodeMenuHelpers';
import type { MenuProps } from 'antd';

export interface BuildExternalSqlFileMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildExternalSqlFileMenuItems = ({ node, context }: BuildExternalSqlFileMenuItemsInput): MenuProps['items'] => {
  const {
    openExternalSQLFile, openExternalSQLBindingModal, openRenameExternalSQLFileModal,
    openCreateExternalSQLFileModal, openCreateExternalSQLDirectoryModal,
    handleDeleteExternalSQLFile,
  } = context;
  return [
      {
          key: 'open-external-sql-file',
          label: t('sidebar.menu.open_sql_file'),
          icon: <ConsoleSqlOutlined />,
          onClick: () => {
              void openExternalSQLFile(node);
          }
      },
      {
          key: 'bind-external-sql-file-database',
          label: t('sidebar.menu.bind_sql_file_database'),
          icon: <LinkOutlined />,
          onClick: () => {
              openExternalSQLBindingModal(node);
          }
      },
      {
          key: 'rename-external-sql-file',
          label: t('sidebar.menu.rename_sql_file'),
          icon: <EditOutlined />,
          onClick: () => {
              openRenameExternalSQLFileModal(node);
          }
      },
      {
          key: 'new-external-sql-file-sibling',
          label: t('sidebar.menu.new_sql_file_in_directory'),
          icon: <FileAddOutlined />,
          onClick: () => {
              openCreateExternalSQLFileModal(node);
          }
      },
      {
          key: 'new-external-sql-directory-sibling',
          label: t('sidebar.menu.new_sql_directory_in_directory'),
          icon: <FolderAddOutlined />,
          onClick: () => {
              openCreateExternalSQLDirectoryModal(node);
          }
      },
      { type: 'divider' },
      {
          key: 'delete-external-sql-file',
          label: t('sidebar.menu.delete_sql_file'),
          icon: <DeleteOutlined />,
          danger: true,
          onClick: () => {
              handleDeleteExternalSQLFile(node);
          }
      }
  ];
};

export interface BuildExternalSqlFolderMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildExternalSqlFolderMenuItems = ({ node, context }: BuildExternalSqlFolderMenuItemsInput): MenuProps['items'] => {
  const {
    openCreateExternalSQLFileModal, openCreateExternalSQLDirectoryModal,
    openRenameExternalSQLDirectoryModal, handleRefreshExternalSQLDirectory,
    handleDeleteExternalSQLDirectory,
  } = context;
  return [
      {
          key: 'new-external-sql-file',
          label: t('sidebar.menu.new_sql_file'),
          icon: <FileAddOutlined />,
          onClick: () => {
              openCreateExternalSQLFileModal(node);
          }
      },
      {
          key: 'new-external-sql-directory',
          label: t('sidebar.menu.new_sql_directory'),
          icon: <FolderAddOutlined />,
          onClick: () => {
              openCreateExternalSQLDirectoryModal(node);
          }
      },
      {
          key: 'rename-external-sql-directory',
          label: t('sidebar.menu.rename_sql_directory'),
          icon: <EditOutlined />,
          onClick: () => {
              openRenameExternalSQLDirectoryModal(node);
          }
      },
      {
          key: 'refresh-external-sql-directory',
          label: t('sidebar.menu.refresh_directory'),
          icon: <ReloadOutlined />,
          onClick: () => {
              void handleRefreshExternalSQLDirectory(node);
          }
      },
      { type: 'divider' },
      {
          key: 'delete-external-sql-directory',
          label: t('sidebar.menu.delete_sql_directory'),
          icon: <DeleteOutlined />,
          danger: true,
          onClick: () => {
              handleDeleteExternalSQLDirectory(node);
          }
      }
  ];
};

export interface BuildExternalSqlDirectoryMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildExternalSqlDirectoryMenuItems = ({ node, context }: BuildExternalSqlDirectoryMenuItemsInput): MenuProps['items'] => {
  const {
    openCreateExternalSQLFileModal, openCreateExternalSQLDirectoryModal,
    openRenameExternalSQLDirectoryModal, handleRefreshExternalSQLDirectory,
    handleRemoveExternalSQLDirectory, handleDeleteExternalSQLDirectory,
  } = context;
  return [
      {
          key: 'new-external-sql-file',
          label: t('sidebar.menu.new_sql_file'),
          icon: <FileAddOutlined />,
          onClick: () => {
              openCreateExternalSQLFileModal(node);
          }
      },
      {
          key: 'new-external-sql-directory',
          label: t('sidebar.menu.new_sql_directory'),
          icon: <FolderAddOutlined />,
          onClick: () => {
              openCreateExternalSQLDirectoryModal(node);
          }
      },
      {
          key: 'rename-external-sql-directory',
          label: t('sidebar.menu.rename_sql_directory'),
          icon: <EditOutlined />,
          onClick: () => {
              openRenameExternalSQLDirectoryModal(node);
          }
      },
      { type: 'divider' },
      {
          key: 'refresh-external-sql-directory',
          label: t('sidebar.menu.refresh_directory'),
          icon: <ReloadOutlined />,
          onClick: () => {
              void handleRefreshExternalSQLDirectory(node);
          }
      },
      { type: 'divider' },
      {
          key: 'remove-external-sql-directory',
          label: t('sidebar.menu.remove_directory'),
          icon: <DeleteOutlined />,
          danger: true,
          onClick: () => {
              void handleRemoveExternalSQLDirectory(node);
          }
      },
      {
          key: 'delete-external-sql-directory',
          label: t('sidebar.menu.delete_local_directory'),
          icon: <DeleteOutlined />,
          danger: true,
          onClick: () => {
              handleDeleteExternalSQLDirectory(node);
          }
      }
  ];
};

export interface BuildExternalSqlRootMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildExternalSqlRootMenuItems = ({ node, context }: BuildExternalSqlRootMenuItemsInput): MenuProps['items'] => {
  const { handleAddExternalSQLDirectory } = context;
  return [
      {
          key: 'add-external-sql-directory',
          label: t('sidebar.menu.add_sql_directory'),
          icon: <PlusOutlined />,
          onClick: () => {
              void handleAddExternalSQLDirectory(node);
          }
      }
  ];
};
