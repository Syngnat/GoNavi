import React from 'react';
import type { SavedConnection, SavedQuery } from '../../types';
import {
  type SidebarConnectionState,
  type SidebarTreeNode as TreeNode,
} from '../sidebarV2Utils';
import {
  normalizeDriverType,
  formatSidebarDriverAgentUpdateWarning,
  type SidebarTreeLoadOptions,
  SIDEBAR_DATABASE_TREE_FIRST_COMMIT_GRACE_MS,
} from './sidebarTreeLoaderHelpers';
import { useSidebarTreeLoadState } from './useSidebarTreeLoadState';
import { useSidebarDatabaseLoader } from './useSidebarDatabaseLoader';
import { useSidebarJvmResourceLoader } from './useSidebarJvmResourceLoader';
import { useSidebarTableLoader } from './useSidebarTableLoader';
import { useSidebarNacosLoaders } from './useSidebarNacosLoaders';
export {
  formatSidebarDriverAgentUpdateWarning,
  normalizeDriverType,
  SIDEBAR_DATABASE_TREE_FIRST_COMMIT_GRACE_MS,
} from './sidebarTreeLoaderHelpers';
export type { SidebarTreeLoadOptions } from './sidebarTreeLoaderHelpers';

export type UseSidebarTreeLoadersOptions = {
  savedQueries: SavedQuery[];
  tableSortPreference: Record<string, any>;
  tableAccessCount: Record<string, any>;
  pinnedSidebarTables: any[];
  pinnedSidebarDatabases: string[];
  loadingNodesRef: React.MutableRefObject<Set<string>>;
  setConnectionStates: React.Dispatch<React.SetStateAction<Record<string, SidebarConnectionState>>>;
  setLoadedKeys: React.Dispatch<React.SetStateAction<React.Key[]>>;
  replaceTreeNodeChildren: (key: React.Key, children: TreeNode[] | undefined, dataRef?: unknown) => TreeNode[];
  buildRuntimeConfig: (conn: any, overrideDatabase?: string, clearDatabase?: boolean) => any;
  buildJVMRuntimeConfig: (conn: SavedConnection & { dbName?: string }, providerMode: string) => any;
  buildJVMDiagnosticTreeNodes: (conn: SavedConnection) => TreeNode[];
  resolveSavedQueryDisplayName: (name: string | null | undefined) => string;
  onDatabaseTreeLoaded?: (databaseKey: string) => void;
};

export const useSidebarTreeLoaders = ({
  savedQueries,
  tableSortPreference,
  tableAccessCount,
  pinnedSidebarTables,
  pinnedSidebarDatabases,
  loadingNodesRef,
  setConnectionStates,
  setLoadedKeys,
  replaceTreeNodeChildren,
  buildRuntimeConfig,
  buildJVMRuntimeConfig,
  buildJVMDiagnosticTreeNodes,
  resolveSavedQueryDisplayName,
  onDatabaseTreeLoaded,
}: UseSidebarTreeLoadersOptions) => {
  const {
    databaseRequestIdsRef, nacosServiceGroupRequestIdsRef, nacosNamespaceRequestIdsRef,
    nacosNamespaceActiveRequestsRef, databaseLoadsRef, tableLoadsRef, beginLoadGeneration,
    isCurrentLoadGeneration, getConnectionLoadEpoch, isCurrentConnectionLoadEpoch,
    invalidateConnectionLoads,
  } = useSidebarTreeLoadState({ loadingNodesRef });
	  const { loadDatabases } = useSidebarDatabaseLoader({
	    loadingNodesRef, setConnectionStates, buildRuntimeConfig, buildJVMDiagnosticTreeNodes,
	    replaceTreeNodeChildren, setLoadedKeys, pinnedSidebarDatabases, getConnectionLoadEpoch,
	    isCurrentConnectionLoadEpoch, nacosNamespaceActiveRequestsRef, beginLoadGeneration,
	    nacosNamespaceRequestIdsRef, isCurrentLoadGeneration, databaseRequestIdsRef, databaseLoadsRef,
	  });

  const { loadJVMResources } = useSidebarJvmResourceLoader({
    loadingNodesRef, buildJVMRuntimeConfig, replaceTreeNodeChildren, setLoadedKeys,
    getConnectionLoadEpoch, beginLoadGeneration, isCurrentConnectionLoadEpoch,
    isCurrentLoadGeneration,
  });

	  const { loadTables } = useSidebarTableLoader({
	    loadingNodesRef, setConnectionStates, setLoadedKeys, savedQueries,
	    resolveSavedQueryDisplayName, replaceTreeNodeChildren, onDatabaseTreeLoaded,
	    tableSortPreference, tableAccessCount, pinnedSidebarTables, getConnectionLoadEpoch,
	    isCurrentConnectionLoadEpoch, beginLoadGeneration, isCurrentLoadGeneration, tableLoadsRef,
	  });

  const { loadNacosConfigGroups, loadNacosServiceGroups } = useSidebarNacosLoaders({
    loadingNodesRef, setLoadedKeys, replaceTreeNodeChildren, pinnedSidebarDatabases,
    getConnectionLoadEpoch, beginLoadGeneration, isCurrentConnectionLoadEpoch,
    isCurrentLoadGeneration, nacosServiceGroupRequestIdsRef,
  });

  return {
      loadDatabases,
      loadJVMResources,
      loadTables,
      loadNacosConfigGroups,
      loadNacosServiceGroups,
      invalidateConnectionLoads,
  };
};
