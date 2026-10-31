import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createGonaviClient, type GonaviClient } from './capabilityClient';

export interface GonaviPluginIdentity {
  pluginId: string;
  generation: number;
  title: string;
  context?: unknown;
}

export interface GonaviPageLaunch {
  kind: 'connectionAction';
  actionId: string;
  connectionId: string;
  connectionName: string;
  connectionType: string;
  database?: string;
  collection?: string;
  environmentType?: string;
  readOnly: boolean;
}

/** Reads the non-secret launch object injected into a connection-action page tab. */
export function useGonaviPageLaunch(): GonaviPageLaunch | null {
  return useMemo(() => readGonaviPageLaunch(
    (globalThis as unknown as { __gonaviLaunch?: unknown }).__gonaviLaunch,
  ), []);
}

export function readGonaviPageLaunch(value: unknown): GonaviPageLaunch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const launch = value as Record<string, unknown>;
  if (launch.kind !== 'connectionAction' || typeof launch.connectionId !== 'string' || !launch.connectionId) return null;
  return {
    kind: 'connectionAction',
    actionId: typeof launch.actionId === 'string' ? launch.actionId : '',
    connectionId: launch.connectionId,
    connectionName: typeof launch.connectionName === 'string' ? launch.connectionName : '',
    connectionType: typeof launch.connectionType === 'string' ? launch.connectionType : '',
    ...(typeof launch.database === 'string' && launch.database ? { database: launch.database } : {}),
    ...(typeof launch.collection === 'string' && launch.collection ? { collection: launch.collection } : {}),
    ...(typeof launch.environmentType === 'string' && launch.environmentType ? { environmentType: launch.environmentType } : {}),
    readOnly: launch.readOnly === true,
  };
}

export interface UsePluginContextResult {
  identity: GonaviPluginIdentity | null;
  loading: boolean;
  error: string;
}

/** Reads the host bootstrap identity, including a connection-action launch context. */
export function usePluginContext(): UsePluginContextResult {
  const [identity, setIdentity] = useState<GonaviPluginIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const bridge = (globalThis as unknown as { gonaviPlugin?: { ready?: Promise<GonaviPluginIdentity> } }).gonaviPlugin;
    if (!bridge?.ready) {
      setLoading(false);
      setError('bridge_unavailable');
      return () => { alive.current = false; };
    }
    void bridge.ready.then((next) => {
      if (alive.current) {
        setIdentity(next);
        setLoading(false);
      }
    }).catch((reason: unknown) => {
      if (!alive.current) return;
      setLoading(false);
      setError(reason instanceof Error ? reason.message : 'bootstrap_failed');
    });
    return () => { alive.current = false; };
  }, []);

  return { identity, loading, error };
}

export interface UseCapabilityResult<Result> {
  data: Result | null;
  loading: boolean;
  error: string;
  run: (args?: unknown) => Promise<Result | null>;
  reset: () => void;
}

/** Small state helper for one capability call; it does not wrap host state. */
export function useCapability<Result = unknown>(
  method: string,
  client?: GonaviClient,
): UseCapabilityResult<Result> {
  const [data, setData] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const resolvedClient = useRef<GonaviClient | null>(client ?? null);

  const run = useCallback(async (args: unknown = {}) => {
    const current = ++request.current;
    setLoading(true);
    setError('');
    try {
      resolvedClient.current ??= createGonaviClient();
      const result = await resolvedClient.current.call<Result>(method, args);
      if (current === request.current) setData(result);
      return result;
    } catch (reason) {
      if (current === request.current) {
        setError(reason instanceof Error ? reason.message : 'capability_failed');
      }
      return null;
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [method]);

  const reset = useCallback(() => {
    request.current += 1;
    setData(null);
    setError('');
    setLoading(false);
  }, []);

  return { data, loading, error, run, reset };
}
