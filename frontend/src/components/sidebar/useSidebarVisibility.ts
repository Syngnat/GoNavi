import { useCallback } from 'react';
import { SavedConnection } from '../../types';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import type { DatabaseSchemaVisibilityDraft } from './databaseSchemaVisibility';
import { t } from '../../i18n';
import { buildConnectionReloadSignature, isConnectionTreeKey } from './sidebarRootHelpers';
import { message } from 'antd';
import {
  moveSchemaVisibilityRule,
  updateSchemaVisibilityRule,
  moveSchemaVisibilityEntry,
  removeSchemaVisibilityEntry,
} from '../../utils/schemaVisibility';
import {
  moveExactDatabaseVisibilityEntry,
  removeExactDatabaseVisibilityEntry,
} from '../../utils/databaseVisibility';
import { isSidebarDatabasePinned } from '../sidebarV2Utils';
import type { SidebarStoreStateApi } from './useSidebarStoreState';
import type { SidebarTreeViewStateApi } from './useSidebarTreeViewState';
import type { SidebarSearchStateApi } from './useSidebarSearchState';
import type { SidebarTreeDataApi } from './useSidebarTreeData';
import type { SidebarJvmAndSavedQueriesApi } from './useSidebarJvmAndSavedQueries';

export interface UseSidebarVisibilityInput {
  connections: SidebarStoreStateApi['connections'];
  setConnectionVisibilityTarget: SidebarTreeViewStateApi['setConnectionVisibilityTarget'];
  connectionVisibilityTarget: SidebarTreeViewStateApi['connectionVisibilityTarget'];
  setIsSavingConnectionVisibility: SidebarTreeViewStateApi['setIsSavingConnectionVisibility'];
  connectionReloadSignaturesRef: SidebarSearchStateApi['connectionReloadSignaturesRef'];
  updateConnection: SidebarStoreStateApi['updateConnection'];
  setLoadedKeys: SidebarSearchStateApi['setLoadedKeys'];
  replaceTreeNodeChildren: SidebarTreeDataApi['replaceTreeNodeChildren'];
  loadDatabases: SidebarJvmAndSavedQueriesApi['loadDatabases'];
  setExpandedKeys: SidebarTreeViewStateApi['setExpandedKeys'];
  findTreeNodeByKeyRef: SidebarTreeViewStateApi['findTreeNodeByKeyRef'];
  treeDataRef: SidebarTreeViewStateApi['treeDataRef'];
  pinnedSidebarDatabases: SidebarStoreStateApi['pinnedSidebarDatabases'];
  setSidebarDatabasePinned: SidebarStoreStateApi['setSidebarDatabasePinned'];
}

export const useSidebarVisibility = ({
  connections, setConnectionVisibilityTarget, connectionVisibilityTarget,
  setIsSavingConnectionVisibility, connectionReloadSignaturesRef, updateConnection, setLoadedKeys,
  replaceTreeNodeChildren, loadDatabases, setExpandedKeys, findTreeNodeByKeyRef, treeDataRef,
  pinnedSidebarDatabases, setSidebarDatabasePinned,
}: UseSidebarVisibilityInput) => {
  const supportsConnectionVisibility = useCallback((connection: SavedConnection): boolean => (
      getDataSourceCapabilities(connection.config).supportsPrimaryVisibility
  ), []);

  const openConnectionVisibilitySettings = useCallback((connection: SavedConnection, initialDatabase?: string) => {
      const currentConnection = connections.find((item) => item.id === connection.id) || connection;
      if (!supportsConnectionVisibility(currentConnection)) return;
      setConnectionVisibilityTarget({
          connection: currentConnection,
          initialDatabase: String(initialDatabase || '').trim() || undefined,
      });
  }, [connections, supportsConnectionVisibility]);

  const openSchemaVisibilitySettings = useCallback((node: any) => {
      const dbName = String(node?.dataRef?.dbName || node?.title || '').trim();
      const connectionId = String(node?.dataRef?.id || '').trim();
      const connection = connections.find((item) => item.id === connectionId) || node?.dataRef;
      if (!connection || !dbName) return;
      const capabilities = getDataSourceCapabilities((connection as SavedConnection).config);
      if (!capabilities.supportsSecondarySchemaVisibility) return;
      openConnectionVisibilitySettings(connection as SavedConnection, dbName);
  }, [connections, openConnectionVisibilitySettings]);

  const handleSaveConnectionVisibility = useCallback(async (
      draft: DatabaseSchemaVisibilityDraft,
  ) => {
      if (!connectionVisibilityTarget) return;
      setIsSavingConnectionVisibility(true);
      try {
          const target = connections.find(
              (item) => item.id === connectionVisibilityTarget.connection.id,
          ) || connectionVisibilityTarget.connection;
          const isRedis = target.config.type === 'redis';
          const backendApp = (window as any).go?.app?.App;
          if (typeof backendApp?.UpdateConnectionVisibility !== 'function') {
              throw new Error(t('connection_modal.message.save_failed'));
          }
          const saved = await backendApp.UpdateConnectionVisibility({
              id: target.id,
              includeDatabases: isRedis ? target.includeDatabases : draft.includeDatabases,
              includeDatabasePatterns: isRedis ? target.includeDatabasePatterns : draft.includeDatabasePatterns,
              excludeDatabasePatterns: isRedis ? target.excludeDatabasePatterns : draft.excludeDatabasePatterns,
              includeRedisDatabases: isRedis
                  ? draft.includeDatabases
                      .map((database) => Number(String(database).replace(/^db/i, '')))
                      .filter((database) => Number.isInteger(database) && database >= 0)
                  : target.includeRedisDatabases,
              schemaVisibilityByDatabase: isRedis
                  ? target.schemaVisibilityByDatabase
                  : draft.schemaVisibilityByDatabase,
          });
          const persistedConnection = saved as SavedConnection;
          connectionReloadSignaturesRef.current[persistedConnection.id] =
              buildConnectionReloadSignature(persistedConnection);
          updateConnection(persistedConnection);
          const connectionNodeKey = persistedConnection.id;
          setLoadedKeys((previous) => previous.filter(
              (key) => !isConnectionTreeKey(String(key), connectionNodeKey),
          ));
          replaceTreeNodeChildren(connectionNodeKey, undefined, persistedConnection);
          await loadDatabases(
              { key: connectionNodeKey, type: 'connection', dataRef: persistedConnection },
              { ensureFresh: true },
          );
          setExpandedKeys((previous) => previous.includes(connectionNodeKey)
              ? previous
              : [...previous, connectionNodeKey]);
          setConnectionVisibilityTarget(null);
          message.success(t('sidebar.database_schema_visibility.message.saved'));
      } catch (error: any) {
          message.error(t('sidebar.database_schema_visibility.message.save_failed', {
              error: error?.message || String(error),
          }));
      } finally {
          setIsSavingConnectionVisibility(false);
      }
  }, [connectionVisibilityTarget, connections, loadDatabases, updateConnection]);

  const persistConnectionVisibilityMetadata = useCallback(async (
      currentConnection: SavedConnection,
      nextConnection: SavedConnection,
  ): Promise<SavedConnection> => {
      if (
          JSON.stringify(nextConnection.includeDatabases || []) === JSON.stringify(currentConnection.includeDatabases || [])
          && JSON.stringify(nextConnection.schemaVisibilityByDatabase || {}) === JSON.stringify(currentConnection.schemaVisibilityByDatabase || {})
      ) {
          return currentConnection;
      }

      const backendApp = (window as any).go?.app?.App;
      if (typeof backendApp?.UpdateConnectionVisibility !== 'function') {
          message.warning(t('sidebar.schema_visibility.message.save_failed', {
              error: t('connection_modal.message.save_failed'),
          }));
          return currentConnection;
      }

      try {
          const saved = await backendApp.UpdateConnectionVisibility({
              id: nextConnection.id,
              includeDatabases: nextConnection.includeDatabases,
              includeDatabasePatterns: nextConnection.includeDatabasePatterns,
              excludeDatabasePatterns: nextConnection.excludeDatabasePatterns,
              includeRedisDatabases: nextConnection.includeRedisDatabases,
              schemaVisibilityByDatabase: nextConnection.schemaVisibilityByDatabase,
          });
          const persistedConnection = saved as SavedConnection;
          connectionReloadSignaturesRef.current[persistedConnection.id] =
              buildConnectionReloadSignature(persistedConnection);
          updateConnection(persistedConnection);
          return persistedConnection;
      } catch (error: any) {
          message.warning(t('sidebar.schema_visibility.message.save_failed', {
              error: error?.message || String(error),
          }));
          return currentConnection;
      }
  }, [updateConnection]);

  const migrateVisibilityForRenamedDatabase = useCallback(async (
      connection: SavedConnection,
      oldDbName: string,
      newDbName: string,
  ): Promise<SavedConnection> => {
      const currentConnection = connections.find((item) => item.id === connection.id) || connection;
      const capabilities = getDataSourceCapabilities(currentConnection.config);
      const nextConnection = {
          ...moveSchemaVisibilityRule(
              currentConnection,
              oldDbName,
              newDbName,
              { caseSensitive: capabilities.schemaIdentifierCaseSensitive },
          ),
          includeDatabases: moveExactDatabaseVisibilityEntry(
              currentConnection,
              oldDbName,
              newDbName,
          ),
      };
      return persistConnectionVisibilityMetadata(currentConnection, nextConnection);
  }, [connections, persistConnectionVisibilityMetadata]);

  const removeVisibilityForDeletedDatabase = useCallback(async (
      connection: SavedConnection,
      dbName: string,
  ): Promise<SavedConnection> => {
      const currentConnection = connections.find((item) => item.id === connection.id) || connection;
      const capabilities = getDataSourceCapabilities(currentConnection.config);
      const connectionNode = findTreeNodeByKeyRef.current(
          treeDataRef.current,
          currentConnection.id,
      );
      const remainingLoadedDatabases = Array.from(new Set(
          (connectionNode?.children || [])
              .filter((child) => child.type === 'database')
              .map((child) => String(child.dataRef?.dbName || child.title || '').trim())
              .filter((name) => name && name !== dbName),
      ));
      const exactIncludes = removeExactDatabaseVisibilityEntry(currentConnection, dbName);
      const nextConnection = {
          ...updateSchemaVisibilityRule(
              currentConnection,
              dbName,
              undefined,
              { caseSensitive: capabilities.schemaIdentifierCaseSensitive },
          ),
          includeDatabases: Array.isArray(currentConnection.includeDatabases)
              && currentConnection.includeDatabases.length > 0
              && exactIncludes?.length === 0
              ? (remainingLoadedDatabases.length > 0 ? remainingLoadedDatabases : [dbName])
              : exactIncludes,
      };
      return persistConnectionVisibilityMetadata(currentConnection, nextConnection);
  }, [connections, persistConnectionVisibilityMetadata]);

  const migrateVisibilityForRenamedSchema = useCallback(async (
      connection: SavedConnection,
      dbName: string,
      oldSchemaName: string,
      newSchemaName: string,
  ): Promise<SavedConnection> => {
      const currentConnection = connections.find((item) => item.id === connection.id) || connection;
      const capabilities = getDataSourceCapabilities(currentConnection.config);
      const nextConnection = moveSchemaVisibilityEntry(
          currentConnection,
          dbName,
          oldSchemaName,
          newSchemaName,
          { caseSensitive: capabilities.schemaIdentifierCaseSensitive },
      );
      return persistConnectionVisibilityMetadata(currentConnection, nextConnection);
  }, [connections, persistConnectionVisibilityMetadata]);

  const removeVisibilityForDeletedSchema = useCallback(async (
      connection: SavedConnection,
      dbName: string,
      schemaName: string,
  ): Promise<SavedConnection> => {
      const currentConnection = connections.find((item) => item.id === connection.id) || connection;
      const capabilities = getDataSourceCapabilities(currentConnection.config);
      const databaseNode = findTreeNodeByKeyRef.current(
          treeDataRef.current,
          `${currentConnection.id}-${dbName}`,
      );
      const normalizeSchemaName = (name: string) => (
          capabilities.schemaIdentifierCaseSensitive
              ? name
              : name.toLocaleLowerCase()
      );
      const deletedSchemaKey = normalizeSchemaName(schemaName);
      const remainingLoadedSchemas = (databaseNode?.children || [])
          .filter((child) => (
              child.type === 'object-group'
              && child.dataRef?.groupKey === 'schema'
              && String(child.dataRef?.id || '') === currentConnection.id
              && String(child.dataRef?.dbName || '') === dbName
          ))
          .map((child) => String(child.dataRef?.schemaName ?? '').trim())
          .filter((name) => name && normalizeSchemaName(name) !== deletedSchemaKey);
      const nextConnection = removeSchemaVisibilityEntry(
          currentConnection,
          dbName,
          schemaName,
          { caseSensitive: capabilities.schemaIdentifierCaseSensitive },
          remainingLoadedSchemas,
      );
      return persistConnectionVisibilityMetadata(currentConnection, nextConnection);
  }, [connections, persistConnectionVisibilityMetadata]);

  const migratePinnedDatabaseKey = useCallback((
      connectionId: string,
      oldDbName: string,
      newDbName?: string,
  ) => {
      if (!isSidebarDatabasePinned(pinnedSidebarDatabases, connectionId, oldDbName)) return;
      setSidebarDatabasePinned(connectionId, oldDbName, false);
      if (newDbName) {
          setSidebarDatabasePinned(connectionId, newDbName, true);
      }
  }, [pinnedSidebarDatabases, setSidebarDatabasePinned]);
  return {
    supportsConnectionVisibility, openConnectionVisibilitySettings, openSchemaVisibilitySettings,
    handleSaveConnectionVisibility, migrateVisibilityForRenamedDatabase,
    removeVisibilityForDeletedDatabase, migrateVisibilityForRenamedSchema,
    removeVisibilityForDeletedSchema, migratePinnedDatabaseKey,
  };
};

export type SidebarVisibilityApi = ReturnType<typeof useSidebarVisibility>;
