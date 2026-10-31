import { useCallback, useEffect, useRef, useState } from 'react';

import {
  dataSyncEndpointMetadataKey,
  dataSyncObjectMetadataKey,
  type DataSyncWorkbenchGateway,
} from './gateway';
import type {
  DataSyncDatabaseMetadata,
  DataSyncEndpointRef,
  DataSyncFieldMetadata,
  DataSyncObjectMetadata,
  DataSyncSavedConnectionView,
} from './model';
import type { WebRPCRequestOptions } from '../../utils/webRpc';

export type DataSyncMetadataState<T> = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  items: T[];
  error: string;
};

export type DataSyncMetadataResult<T> = DataSyncMetadataState<T> & {
  reload: () => void;
};

const idleState = <T,>(): DataSyncMetadataState<T> => ({
  status: 'idle',
  items: [],
  error: '',
});

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error || 'unknown');

const useMetadataCollection = <T,>(
  gateway: DataSyncWorkbenchGateway,
  requestKey: string,
  enabled: boolean,
  load: (options: WebRPCRequestOptions) => Promise<T[]>,
): DataSyncMetadataResult<T> => {
  const [state, setState] = useState<DataSyncMetadataState<T>>(idleState);
  const [reloadRevision, setReloadRevision] = useState(0);
  const requestSequence = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const requestId = ++requestSequence.current;
    if (!enabled) {
      setState(idleState());
      return undefined;
    }

    let active = true;
    const controller = new AbortController();
    setState({ status: 'loading', items: [], error: '' });
    void Promise.resolve()
      .then(() => loadRef.current({ signal: controller.signal }))
      .then(
        (items) => {
          if (!active || requestSequence.current !== requestId) return;
          setState({ status: 'ready', items, error: '' });
        },
        (error) => {
          if (!active || requestSequence.current !== requestId) return;
          setState({ status: 'error', items: [], error: errorMessage(error) });
        },
      );

    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, gateway, reloadRevision, requestKey]);

  const reload = useCallback(() => {
    setReloadRevision((current) => current + 1);
  }, []);

  return { ...state, reload };
};

export const useDataSyncSavedConnections = (
  gateway: DataSyncWorkbenchGateway,
): DataSyncMetadataResult<DataSyncSavedConnectionView> =>
  useMetadataCollection(gateway, 'saved-connections', true, () =>
    gateway.listSavedConnections(),
  );

export const useDataSyncDatabases = (
  gateway: DataSyncWorkbenchGateway,
  connectionId: string,
  available = true,
): DataSyncMetadataResult<DataSyncDatabaseMetadata> => {
  const normalizedConnectionId = connectionId.trim();
  return useMetadataCollection(
    gateway,
    normalizedConnectionId,
    Boolean(normalizedConnectionId && available),
    (options) => gateway.listDatabases(normalizedConnectionId, options),
  );
};

export const useDataSyncObjects = (
  gateway: DataSyncWorkbenchGateway,
  endpoint: DataSyncEndpointRef,
  // 对比任务按整库在服务端展开表清单，前端不需要这份对象列表：千表库上
  // 拉一次就是几千行元数据，白占内存也拖慢首屏。
  allowLoad = true,
): DataSyncMetadataResult<DataSyncObjectMetadata> => {
  const requestKey = dataSyncEndpointMetadataKey(endpoint);
  const enabled = allowLoad && Boolean(endpoint.connectionId.trim());
  return useMetadataCollection(gateway, requestKey, enabled, (options) =>
    gateway.listObjects({ ...endpoint }, options),
  );
};

export const useDataSyncFields = (
  gateway: DataSyncWorkbenchGateway,
  endpoint: DataSyncEndpointRef,
  objectName: string,
): DataSyncMetadataResult<DataSyncFieldMetadata> => {
  const requestKey = dataSyncObjectMetadataKey(endpoint, objectName);
  const enabled = Boolean(endpoint.connectionId.trim() && objectName.trim());
  return useMetadataCollection(gateway, requestKey, enabled, (options) =>
    gateway.listFields({ ...endpoint }, objectName, options),
  );
};
