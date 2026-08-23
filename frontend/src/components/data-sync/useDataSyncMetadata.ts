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
  load: () => Promise<T[]>,
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
    setState({ status: 'loading', items: [], error: '' });
    void Promise.resolve()
      .then(() => loadRef.current())
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
): DataSyncMetadataResult<DataSyncDatabaseMetadata> => {
  const normalizedConnectionId = connectionId.trim();
  return useMetadataCollection(
    gateway,
    normalizedConnectionId,
    Boolean(normalizedConnectionId),
    () => gateway.listDatabases(normalizedConnectionId),
  );
};

export const useDataSyncObjects = (
  gateway: DataSyncWorkbenchGateway,
  endpoint: DataSyncEndpointRef,
): DataSyncMetadataResult<DataSyncObjectMetadata> => {
  const requestKey = dataSyncEndpointMetadataKey(endpoint);
  const enabled = Boolean(endpoint.connectionId.trim());
  return useMetadataCollection(gateway, requestKey, enabled, () =>
    gateway.listObjects({ ...endpoint }),
  );
};

export const useDataSyncFields = (
  gateway: DataSyncWorkbenchGateway,
  endpoint: DataSyncEndpointRef,
  objectName: string,
): DataSyncMetadataResult<DataSyncFieldMetadata> => {
  const requestKey = dataSyncObjectMetadataKey(endpoint, objectName);
  const enabled = Boolean(endpoint.connectionId.trim() && objectName.trim());
  return useMetadataCollection(gateway, requestKey, enabled, () =>
    gateway.listFields({ ...endpoint }, objectName),
  );
};
