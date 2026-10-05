import { useRef, useCallback } from 'react';
import {
  type DriverStatusSnapshot,
  type TrackedSidebarLoad,
  DRIVER_STATUS_CACHE_TTL_MS,
  normalizeDriverType,
  resolveSavedConnectionDriverType,
  formatSidebarDriverAgentUpdateWarning,
} from './sidebarTreeLoaderHelpers';
import { GetDriverStatusList } from '../../../wailsjs/go/app/App';
import type { SavedConnection } from '../../types';
import { message } from 'antd';
import type { UseSidebarTreeLoadersOptions } from './useSidebarTreeLoaders';

export interface UseSidebarTreeLoadStateInput {
  loadingNodesRef: UseSidebarTreeLoadersOptions['loadingNodesRef'];
}

export const useSidebarTreeLoadState = ({ loadingNodesRef }: UseSidebarTreeLoadStateInput) => {
  const driverStatusCacheRef = useRef<{
      fetchedAt: number;
      items: Record<string, DriverStatusSnapshot>;
  } | null>(null);
  const driverUpdateWarningKeysRef = useRef<Set<string>>(new Set());
  const databaseRequestIdsRef = useRef<Record<string, number>>({});
  const nacosServiceGroupRequestIdsRef = useRef<Record<string, number>>({});
  const nacosNamespaceRequestIdsRef = useRef<Record<string, number>>({});
  // A connection can be disconnected or refreshed while a metadata request
  // is still in flight. Keep a generation per resource load so a late
  // response cannot resurrect the old Host success state.
  const loadGenerationsRef = useRef<Record<string, number>>({});
  // Unlike a per-resource generation, this epoch also invalidates loads that
  // are queued behind an in-flight request in scheduleSidebarLoad.
  const connectionLoadEpochsRef = useRef<Record<string, number>>({});
  const nacosNamespaceActiveRequestsRef = useRef<
      Record<string, { requestId: number; signature: string }>
  >({});
  const databaseLoadsRef = useRef<Map<string, TrackedSidebarLoad>>(new Map());
  const tableLoadsRef = useRef<Map<string, TrackedSidebarLoad>>(new Map());

  const beginLoadGeneration = (loadKey: string): number => {
      const nextGeneration = (loadGenerationsRef.current[loadKey] || 0) + 1;
      loadGenerationsRef.current[loadKey] = nextGeneration;
      return nextGeneration;
  };

  const isCurrentLoadGeneration = (loadKey: string, generation: number): boolean => (
      loadGenerationsRef.current[loadKey] === generation
  );

  const getConnectionLoadEpoch = (connectionId: string): number => {
      const normalizedConnectionId = String(connectionId || '').trim();
      return connectionLoadEpochsRef.current[normalizedConnectionId] || 0;
  };

  const isCurrentConnectionLoadEpoch = (
      connectionId: string,
      epoch: number,
  ): boolean => getConnectionLoadEpoch(connectionId) === epoch;

  const invalidateConnectionLoads = useCallback((connectionId: string): void => {
      const normalizedConnectionId = String(connectionId || '').trim();
      if (!normalizedConnectionId) return;

      connectionLoadEpochsRef.current[normalizedConnectionId] =
          (connectionLoadEpochsRef.current[normalizedConnectionId] || 0) + 1;

      const isConnectionLoadKey = (loadKey: string): boolean => (
          loadKey === `dbs-${normalizedConnectionId}`
          || loadKey.startsWith(`tables-${normalizedConnectionId}-`)
          || loadKey.startsWith(`nacos-groups-${normalizedConnectionId}-`)
          || loadKey.startsWith(`nacos-service-groups-${normalizedConnectionId}-`)
          || loadKey.startsWith(`jvm-resources-${normalizedConnectionId}-`)
      );

      Object.keys(loadGenerationsRef.current).forEach((loadKey) => {
          if (isConnectionLoadKey(loadKey)) {
              loadGenerationsRef.current[loadKey] += 1;
          }
      });
      // These request counters are used by the existing loaders to reject
      // stale payloads before they touch the tree.
      databaseRequestIdsRef.current[normalizedConnectionId] =
          (databaseRequestIdsRef.current[normalizedConnectionId] || 0) + 1;
      nacosNamespaceRequestIdsRef.current[normalizedConnectionId] =
          (nacosNamespaceRequestIdsRef.current[normalizedConnectionId] || 0) + 1;
      Object.keys(nacosServiceGroupRequestIdsRef.current).forEach((loadKey) => {
          if (isConnectionLoadKey(loadKey)) {
              nacosServiceGroupRequestIdsRef.current[loadKey] += 1;
          }
      });

      Array.from(loadingNodesRef.current).forEach((loadKey) => {
          if (isConnectionLoadKey(loadKey)) {
              loadingNodesRef.current.delete(loadKey);
          }
      });

      // Prevent a queued ensureFresh load from blocking a subsequent explicit
      // reconnect. Its eventual callback is rejected by the connection epoch.
      databaseLoadsRef.current.delete(`dbs-${normalizedConnectionId}`);
      Array.from(tableLoadsRef.current.keys()).forEach((loadKey) => {
          if (isConnectionLoadKey(loadKey)) {
              tableLoadsRef.current.delete(loadKey);
          }
      });
      delete nacosNamespaceActiveRequestsRef.current[normalizedConnectionId];
  }, [loadingNodesRef]);

	  const fetchDriverStatusMap = async (): Promise<Record<string, DriverStatusSnapshot>> => {
	      const cached = driverStatusCacheRef.current;
	      if (cached && Date.now() - cached.fetchedAt < DRIVER_STATUS_CACHE_TTL_MS) {
	          return cached.items;
	      }
	      const result: Record<string, DriverStatusSnapshot> = {};
	      const res = await GetDriverStatusList('', '');
	      if (!res?.success) {
	          return result;
	      }
	      const data = (res.data || {}) as any;
	      const drivers = Array.isArray(data.drivers) ? data.drivers : [];
	      drivers.forEach((item: any) => {
	          const type = normalizeDriverType(String(item.type || '').trim());
	          if (!type) return;
	          result[type] = {
	              type,
	              name: String(item.name || item.type || type).trim(),
	              connectable: !!item.connectable,
	              expectedRevision: String(item.expectedRevision || '').trim() || undefined,
	              needsUpdate: !!item.needsUpdate,
	              updateReason: String(item.updateReason || '').trim() || undefined,
	              message: String(item.message || '').trim() || undefined,
	          };
	      });
	      driverStatusCacheRef.current = { fetchedAt: Date.now(), items: result };
	      return result;
	  };

	  const warnIfConnectionDriverAgentNeedsUpdate = async (conn: SavedConnection) => {
	      try {
	          const driverType = resolveSavedConnectionDriverType(conn);
	          if (!driverType || driverType === 'custom') {
	              return;
	          }
	          const statusMap = await fetchDriverStatusMap();
	          const status = statusMap[driverType];
	          if (!status?.connectable || !status.needsUpdate) {
	              return;
	          }
	          const revisionKey = status.expectedRevision || status.updateReason || status.message || 'unknown';
	          const warningKey = `${conn.id}:${driverType}:${revisionKey}`;
	          if (driverUpdateWarningKeysRef.current.has(warningKey)) {
	              return;
	          }
	          driverUpdateWarningKeysRef.current.add(warningKey);
	          const driverName = status.name || driverType;
	          message.warning({
	              content: formatSidebarDriverAgentUpdateWarning(driverName, status),
	              key: `driver-agent-update-${conn.id}`,
	              duration: 10,
	          });
	      } catch (error) {
	          console.warn('检查驱动代理更新状态失败', error);
	      }
	  };
  return {
    databaseRequestIdsRef, nacosServiceGroupRequestIdsRef, nacosNamespaceRequestIdsRef,
    nacosNamespaceActiveRequestsRef, databaseLoadsRef, tableLoadsRef, beginLoadGeneration,
    isCurrentLoadGeneration, getConnectionLoadEpoch, isCurrentConnectionLoadEpoch,
    invalidateConnectionLoads,
  };
};

export type SidebarTreeLoadStateApi = ReturnType<typeof useSidebarTreeLoadState>;
