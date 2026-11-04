import React, { useEffect, useState } from 'react';
import { Select } from 'antd';
import { createGonaviClient, GonaviCapabilityError, type GonaviClient } from './capabilityClient';

/** Sanitised connection summary returned by `connections.list`; never credentials. */
export interface GonaviConnectionSummary {
  id: string;
  name: string;
  type: string;
  host?: string;
  port?: number;
  database?: string;
  environmentType?: string;
  readOnly?: boolean;
}

/** Keeps only records with a usable identity; malformed rows are dropped. */
export function decodeGonaviConnections(value: unknown): GonaviConnectionSummary[] {
  if (!Array.isArray(value)) return [];
  const connections: GonaviConnectionSummary[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id || typeof record.name !== 'string') continue;
    connections.push({
      id: record.id,
      name: record.name,
      type: typeof record.type === 'string' ? record.type : '',
      ...(typeof record.host === 'string' ? { host: record.host } : {}),
      ...(typeof record.port === 'number' ? { port: record.port } : {}),
      ...(typeof record.database === 'string' ? { database: record.database } : {}),
      ...(typeof record.environmentType === 'string' ? { environmentType: record.environmentType } : {}),
      ...(typeof record.readOnly === 'boolean' ? { readOnly: record.readOnly } : {}),
    });
  }
  return connections;
}

export interface GonaviConnectionPickerProps {
  selectedId?: string;
  onSelect: (connection: GonaviConnectionSummary) => void;
  placeholder?: string;
  /** Injected in tests; defaults to the bridge-backed client. */
  client?: Pick<GonaviClient, 'call'>;
  style?: React.CSSProperties;
}

/**
 * Host-resolved connection picker. The plugin never supplies connection
 * configuration: it receives only the sanitised summary and passes the id to
 * its own capabilities.
 */
export const GonaviConnectionPicker: React.FC<GonaviConnectionPickerProps> = ({
  selectedId,
  onSelect,
  placeholder = 'Select a connection',
  client,
  style,
}) => {
  const [connections, setConnections] = useState<GonaviConnectionSummary[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const resolved = client ?? createGonaviClient();
        const data = await resolved.call('connections.list', {});
        if (alive) setConnections(decodeGonaviConnections(data));
      } catch (cause) {
        if (alive) setError(cause instanceof GonaviCapabilityError ? cause.code : 'unavailable');
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    return () => { alive = false; };
  }, [client]);

  return (
    <Select
      style={{ minWidth: 240, ...style }}
      value={selectedId || undefined}
      loading={loading}
      placeholder={error ? `Connections unavailable (${error})` : placeholder}
      disabled={Boolean(error)}
      showSearch
      optionFilterProp="label"
      onChange={(value: string) => {
        const connection = connections.find((item) => item.id === value);
        if (connection) onSelect(connection);
      }}
      options={connections.map((connection) => ({
        value: connection.id,
        label: connection.host ? `${connection.name} · ${connection.host}` : connection.name,
      }))}
    />
  );
};
