import { useCallback } from 'react';
import { message, Button, Tooltip } from 'antd';
import {
  HistoryOutlined,
  FileTextOutlined,
  RightOutlined,
  ConsoleSqlOutlined,
  PushpinOutlined,
  DatabaseOutlined,
  FolderOpenOutlined,
} from '@ant-design/icons';
import type { SavedQuery } from '../../../types';
import { t } from '../../../i18n';
import type { RecentSQLFile } from '../../../store';
import {
  resolveExternalSQLFileBinding,
  buildExternalSQLTabId,
} from '../../../utils/externalSqlTree';
import { ReadSQLFile } from '../../../../wailsjs/go/app/App';
import { buildSQLFileExecutionWorkbenchTab } from '../../../utils/sqlFileExecutionTab';
import { normalizeSQLFileReadContent } from '../../../utils/sqlFileTabDirty';
import { GnNewConnectionIcon, GnNewQueryIcon, GnSearchIcon } from '../../icons/gnIcons';
import AiSparkOutlined from '../../icons/AiSparkOutlined';
import { RecentConnectionShortcutItem } from '../tabManagerShortcuts';
import type { TabManagerItemsApi } from './useTabManagerItems';
import type { TabManagerStateApi } from './useTabManagerState';

export interface UseTabManagerEmptyWorkbenchInput {
  connectionById: TabManagerItemsApi['connectionById'];
  addTab: TabManagerStateApi['addTab'];
  externalSQLDirectories: TabManagerStateApi['externalSQLDirectories'];
  setOpeningRecentSQLFileKey: TabManagerStateApi['setOpeningRecentSQLFileKey'];
  connections: TabManagerStateApi['connections'];
  handleOpenConnectionModal: TabManagerItemsApi['handleOpenConnectionModal'];
  handleFocusObjectSearch: TabManagerItemsApi['handleFocusObjectSearch'];
  handleOpenAI: TabManagerItemsApi['handleOpenAI'];
  recentConnectionShortcuts: TabManagerItemsApi['recentConnectionShortcuts'];
  handleOpenRecentConnection: TabManagerItemsApi['handleOpenRecentConnection'];
  recentSavedQueries: TabManagerItemsApi['recentSavedQueries'];
  recentSQLFileShortcuts: TabManagerItemsApi['recentSQLFileShortcuts'];
  openingRecentSQLFileKey: TabManagerStateApi['openingRecentSQLFileKey'];
  pinnedTableShortcuts: TabManagerItemsApi['pinnedTableShortcuts'];
  handleOpenPinnedTable: TabManagerItemsApi['handleOpenPinnedTable'];
  linkedExternalSQLDirectoryShortcuts: TabManagerItemsApi['linkedExternalSQLDirectoryShortcuts'];
  handleCreateQueryForConnection: TabManagerItemsApi['handleCreateQueryForConnection'];
  handleAddExternalSQLDirectory: TabManagerItemsApi['handleAddExternalSQLDirectory'];
}

export const useTabManagerEmptyWorkbench = ({
  connectionById, addTab, externalSQLDirectories, setOpeningRecentSQLFileKey, connections,
  handleOpenConnectionModal, handleFocusObjectSearch, handleOpenAI, recentConnectionShortcuts,
  handleOpenRecentConnection, recentSavedQueries, recentSQLFileShortcuts, openingRecentSQLFileKey,
  pinnedTableShortcuts, handleOpenPinnedTable, linkedExternalSQLDirectoryShortcuts,
  handleCreateQueryForConnection, handleAddExternalSQLDirectory,
}: UseTabManagerEmptyWorkbenchInput) => {
  const handleOpenSavedQuery = useCallback((query: SavedQuery) => {
    if (!connectionById.has(query.connectionId)) {
      message.error(t('sidebar.message.connection_config_not_found'));
      return;
    }
    addTab({
      id: query.id,
      title: query.name || t('sidebar.tree.untitled_query'),
      type: 'query',
      connectionId: query.connectionId,
      dbName: query.dbName,
      query: query.sql,
      savedQueryId: query.id,
    });
  }, [addTab, connectionById]);

  const handleOpenRecentSQLFile = useCallback(async (file: RecentSQLFile) => {
    const filePath = String(file.filePath || '').trim();
    const fileBinding = resolveExternalSQLFileBinding(externalSQLDirectories, filePath, {
      connectionId: file.connectionId,
      dbName: file.dbName,
    });
    const connectionId = String(
      fileBinding ? fileBinding.connectionId : file.connectionId || '',
    ).trim();
    const dbName = String(
      fileBinding ? fileBinding.dbName : file.dbName || '',
    ).trim();
    if (!connectionId || !connectionById.has(connectionId)) {
      message.error(t('sidebar.message.connection_config_not_found'));
      return;
    }
    if (!filePath) {
      message.error(t('sidebar.message.sql_file_path_incomplete'));
      return;
    }

    const openKey = `${connectionId}::${dbName}::${filePath}`;
    setOpeningRecentSQLFileKey(openKey);
    try {
      const res = await ReadSQLFile(filePath);
      if (!res.success) {
        message.error(t('sidebar.message.read_sql_file_failed', { error: res.message }));
        return;
      }

      const data = res.data;
      if (data && typeof data === 'object' && (data as Record<string, unknown>).isLargeFile === true) {
        const payload = data as Record<string, unknown>;
        addTab(buildSQLFileExecutionWorkbenchTab({
          connectionId,
          dbName: dbName || undefined,
          filePath: String(payload.filePath || '').trim() || filePath,
          fileName: file.fileName,
          fileSizeMB: String(payload.fileSizeMB || '').trim() || undefined,
          autoStart: false,
        }));
        return;
      }

      addTab({
        id: buildExternalSQLTabId(connectionId, dbName, filePath),
        title: file.fileName,
        type: 'query',
        connectionId,
        dbName: dbName || undefined,
        query: normalizeSQLFileReadContent(data),
        filePath,
      });
    } catch (error) {
      message.error(t('sidebar.message.read_sql_file_failed', {
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setOpeningRecentSQLFileKey((current) => current === openKey ? null : current);
    }
  }, [addTab, connectionById, externalSQLDirectories]);

  const EmptyWorkbench = (
    <div className="gn-v2-empty-workbench">
      <section className="gn-v2-empty-hero" aria-label={t('tab_manager.empty.aria.start_workbench')}>
        <div className="gn-v2-empty-eyebrow">
          <span>{t('tab_manager.empty.eyebrow.workbench')}</span>
          <span>{t('tab_manager.empty.eyebrow.connections', { count: connections.length })}</span>
        </div>
        <h1>{t('tab_manager.empty.hero.title')}</h1>
        <p>{t('tab_manager.empty.hero.description')}</p>
        <div className="gn-v2-empty-actions">
          <Button type="primary" icon={<GnNewConnectionIcon />} onClick={handleOpenConnectionModal}>
            {t('connection.new')}
          </Button>
          <Button icon={<GnNewQueryIcon />} onClick={() => window.dispatchEvent(new CustomEvent('gonavi:create-query-tab'))}>
            {t('query.new')}
          </Button>
          <Tooltip title={t('tab_manager.empty.quick.search.description')}>
            <Button icon={<GnSearchIcon />} onClick={handleFocusObjectSearch}>
              {t('tab_manager.empty.quick.search.title')}
            </Button>
          </Tooltip>
          <Button icon={<AiSparkOutlined />} onClick={handleOpenAI}>
            {t('tab_manager.empty.action.open_ai')}
          </Button>
        </div>
      </section>
      <section className="gn-v2-empty-recent" aria-label={t('tab_manager.empty.recent.aria')}>
        <section className="gn-v2-empty-recent-card">
          <div className="gn-v2-empty-recent-heading">
            <span><HistoryOutlined />{t('tab_manager.empty.recent.connection.heading')}</span>
            <em>{recentConnectionShortcuts.length}</em>
          </div>
          {recentConnectionShortcuts.length > 0 ? (
            <div className="gn-v2-empty-recent-list">
              {recentConnectionShortcuts.map((shortcut) => (
                <RecentConnectionShortcutItem
                  key={`${shortcut.connection.id}::${shortcut.dbName || ''}`}
                  shortcut={shortcut}
                  onOpen={handleOpenRecentConnection}
                />
              ))}
            </div>
          ) : (
            <p className="gn-v2-empty-recent-empty">{t('tab_manager.empty.recent.connection.empty')}</p>
          )}
        </section>
        <section className="gn-v2-empty-recent-card">
          <div className="gn-v2-empty-recent-heading">
            <span><FileTextOutlined />{t('tab_manager.empty.recent.saved_query.heading')}</span>
            <em>{recentSavedQueries.length}</em>
          </div>
          {recentSavedQueries.length > 0 ? (
            <div className="gn-v2-empty-recent-list">
              {recentSavedQueries.map((query) => {
                const connection = connectionById.get(query.connectionId);
                return (
                  <button
                    key={query.id}
                    type="button"
                    className="gn-v2-empty-recent-item"
                    onClick={() => handleOpenSavedQuery(query)}
                  >
                    <FileTextOutlined />
                    <span>
                      <strong title={query.name || t('sidebar.tree.untitled_query')}>
                        {query.name || t('sidebar.tree.untitled_query')}
                      </strong>
                      <small>{`${connection?.name || query.connectionId} · ${query.dbName || t('tab_manager.empty.recent.connection.default_database')}`}</small>
                    </span>
                    <RightOutlined className="gn-v2-empty-recent-arrow" />
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="gn-v2-empty-recent-empty">{t('tab_manager.empty.recent.saved_query.empty')}</p>
          )}
        </section>
        <section className="gn-v2-empty-recent-card">
          <div className="gn-v2-empty-recent-heading">
            <span><ConsoleSqlOutlined />{t('tab_manager.empty.recent.sql_file.heading')}</span>
            <em>{recentSQLFileShortcuts.length}</em>
          </div>
          {recentSQLFileShortcuts.length > 0 ? (
            <div className="gn-v2-empty-recent-list">
              {recentSQLFileShortcuts.map((file) => {
                const connection = connectionById.get(file.connectionId);
                const openKey = `${file.connectionId}::${file.dbName || ''}::${file.filePath}`;
                return (
                  <button
                    key={openKey}
                    type="button"
                    className="gn-v2-empty-recent-item"
                    disabled={openingRecentSQLFileKey === openKey}
                    onClick={() => void handleOpenRecentSQLFile(file)}
                  >
                    <FileTextOutlined />
                    <span>
                      <strong title={file.fileName}>{file.fileName}</strong>
                      <small>{`${connection?.name || file.connectionId} · ${file.dbName || t('tab_manager.empty.recent.connection.default_database')}`}</small>
                    </span>
                    <RightOutlined className="gn-v2-empty-recent-arrow" />
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="gn-v2-empty-recent-empty">{t('tab_manager.empty.recent.sql_file.empty')}</p>
          )}
        </section>
      </section>
      <section className="gn-v2-empty-resources" aria-label={t('tab_manager.empty.recent.aria')}>
        <section className="gn-v2-empty-resource-card">
          <div className="gn-v2-empty-recent-heading">
            <span><PushpinOutlined />{t('sidebar.action.pin_table')}</span>
            <em>{pinnedTableShortcuts.length}</em>
          </div>
          {pinnedTableShortcuts.length > 0 ? (
            <div className="gn-v2-empty-recent-list">
              {pinnedTableShortcuts.map((shortcut) => {
                const displayName = shortcut.schemaName
                  ? `${shortcut.schemaName}.${shortcut.tableName}`
                  : shortcut.tableName;
                return (
                  <button
                    key={`${shortcut.connection.id}::${shortcut.dbName}::${shortcut.schemaName || ''}::${shortcut.tableName}`}
                    type="button"
                    className="gn-v2-empty-recent-item"
                    onClick={() => handleOpenPinnedTable(shortcut)}
                  >
                    <DatabaseOutlined />
                    <span>
                      <strong title={displayName}>{displayName}</strong>
                      <small>{`${shortcut.connection.name} · ${shortcut.dbName}`}</small>
                    </span>
                    <RightOutlined className="gn-v2-empty-recent-arrow" />
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="gn-v2-empty-resource-empty">
              <PushpinOutlined />
              <p>{t('tab_manager.empty.resource.pinned_tables.empty')}</p>
              <Button type="link" onClick={handleFocusObjectSearch}>{t('sidebar.command_search.label')}</Button>
            </div>
          )}
        </section>
        <section className="gn-v2-empty-resource-card">
          <div className="gn-v2-empty-recent-heading">
            <span><FolderOpenOutlined />{t('sidebar.external_sql.root')}</span>
            <em>{linkedExternalSQLDirectoryShortcuts.length}</em>
          </div>
          {linkedExternalSQLDirectoryShortcuts.length > 0 ? (
            <div className="gn-v2-empty-recent-list">
              {linkedExternalSQLDirectoryShortcuts.map((shortcut) => (
                <button
                  key={shortcut.directory.id}
                  type="button"
                  className="gn-v2-empty-recent-item"
                  onClick={() => handleCreateQueryForConnection(shortcut)}
                >
                  <FolderOpenOutlined />
                  <span>
                    <strong title={shortcut.directory.name}>{shortcut.directory.name}</strong>
                    <small>{`${shortcut.connection.name} · ${shortcut.dbName || t('tab_manager.empty.recent.connection.default_database')}`}</small>
                  </span>
                  <RightOutlined className="gn-v2-empty-recent-arrow" />
                </button>
              ))}
            </div>
          ) : (
            <div className="gn-v2-empty-resource-empty">
              <FolderOpenOutlined />
              <p>{t('tab_manager.empty.resource.sql_directory.empty')}</p>
              <Button type="link" onClick={handleAddExternalSQLDirectory}>{t('sidebar.menu.add_sql_directory')}</Button>
            </div>
          )}
        </section>
      </section>
    </div>
  );
  return { EmptyWorkbench };
};

export type TabManagerEmptyWorkbenchApi = ReturnType<typeof useTabManagerEmptyWorkbench>;
