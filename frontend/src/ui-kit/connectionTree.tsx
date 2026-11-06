import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Tree } from 'antd';
import { createGonaviClient, GonaviCapabilityError, type GonaviClient } from './capabilityClient';
import { decodeGonaviConnections, type GonaviConnectionSummary } from './connectionPicker';
import { GonaviEmptyState } from './components';

export type GonaviConnectionNodeKind = 'connection' | 'database' | 'table' | 'view';

/** One read-only tree node. Identity is enough to resolve everything host-side. */
export interface GonaviConnectionNode {
  key: string;
  title: string;
  kind: GonaviConnectionNodeKind;
  connectionId: string;
  database?: string;
  table?: string;
  isLeaf?: boolean;
  children?: GonaviConnectionNode[];
}

export function gonaviConnectionNodes(
  connections: readonly GonaviConnectionSummary[],
  types?: readonly string[],
): GonaviConnectionNode[] {
  const allowed = types && types.length > 0 ? new Set(types.map((type) => type.toLowerCase())) : null;
  return connections
    .filter((connection) => !allowed || allowed.has(connection.type.toLowerCase()))
    .map((connection) => ({
      key: `connection:${connection.id}`,
      title: connection.host ? `${connection.name} · ${connection.host}` : connection.name,
      kind: 'connection',
      connectionId: connection.id,
    }));
}

export function gonaviDatabaseNodes(connectionId: string, names: readonly string[]): GonaviConnectionNode[] {
  return [...new Set(names)]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      key: `database:${connectionId}:${name}`,
      title: name,
      kind: 'database',
      connectionId,
      database: name,
    }));
}

export function gonaviTableNodes(
  connectionId: string,
  database: string,
  tables: readonly { name: string; type?: string }[],
): GonaviConnectionNode[] {
  const seen = new Set<string>();
  const nodes: GonaviConnectionNode[] = [];
  for (const table of tables) {
    if (!table || typeof table.name !== 'string' || !table.name || seen.has(table.name)) continue;
    seen.add(table.name);
    const kind = String(table.type ?? '').toLowerCase().includes('view') ? 'view' : 'table';
    nodes.push({
      key: `${kind}:${connectionId}:${database}:${table.name}`,
      title: table.name,
      kind,
      connectionId,
      database,
      table: table.name,
      isLeaf: true,
    });
  }
  return nodes.sort((left, right) => left.title.localeCompare(right.title));
}

/** Overlays lazily loaded children without mutating the declared roots. */
export function mergeGonaviConnectionTree(
  nodes: readonly GonaviConnectionNode[],
  loaded: Readonly<Record<string, GonaviConnectionNode[]>>,
): GonaviConnectionNode[] {
  return nodes.map((node) => {
    const children = loaded[node.key] ?? node.children;
    return children ? { ...node, children: mergeGonaviConnectionTree(children, loaded) } : node;
  });
}

export interface GonaviConnectionTreeProps {
  height?: number;
  /** Optional lower-case connection type filter, e.g. `['mysql', 'postgres']`. */
  connectionTypes?: readonly string[];
  onSelect?: (node: GonaviConnectionNode) => void;
  /** Double-click a table or view; the plugin resolves it further itself. */
  onOpenTable?: (node: GonaviConnectionNode) => void;
  client?: Pick<GonaviClient, 'call'>;
  className?: string;
}

/**
 * Read-only host connection tree for plugin windows. Connection summaries and
 * metadata come from host capabilities; the tree never receives credentials,
 * arbitrary paths or host state, and it never opens a connection itself.
 */
export const GonaviConnectionTree: React.FC<GonaviConnectionTreeProps> = ({
  height = 420,
  connectionTypes,
  onSelect,
  onOpenTable,
  client,
  className,
}) => {
  const [connections, setConnections] = useState<GonaviConnectionSummary[]>([]);
  const [loaded, setLoaded] = useState<Record<string, GonaviConnectionNode[]>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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

  const roots = useMemo(() => gonaviConnectionNodes(connections, connectionTypes), [connections, connectionTypes]);
  const treeData = useMemo(() => mergeGonaviConnectionTree(roots, loaded), [roots, loaded]);

  const loadData = useCallback(async (node: { key: React.Key }) => {
    const source = node as unknown as GonaviConnectionNode;
    if (loaded[source.key] || (source.children && source.children.length > 0)) return;
    try {
      const resolved = client ?? createGonaviClient();
      if (source.kind === 'connection') {
        const names = await resolved.call<unknown>('metadata.databases', { connectionId: source.connectionId });
        const databases = Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : [];
        setLoaded((previous) => ({ ...previous, [source.key]: gonaviDatabaseNodes(source.connectionId, databases) }));
      } else if (source.kind === 'database' && source.database) {
        const tables = await resolved.call<unknown>('metadata.tables', {
          connectionId: source.connectionId,
          database: source.database,
        });
        const items = Array.isArray(tables)
          ? tables.filter((item): item is { name: string; type?: string } => Boolean(item) && typeof (item as { name?: unknown }).name === 'string')
          : [];
        setLoaded((previous) => ({
          ...previous,
          [source.key]: gonaviTableNodes(source.connectionId, source.database!, items),
        }));
      }
    } catch {
      setLoaded((previous) => ({ ...previous, [source.key]: [] }));
    }
  }, [client, loaded]);

  if (error) {
    return <GonaviEmptyState title={`Connections unavailable (${error})`} />;
  }
  if (!loading && roots.length === 0) {
    return <GonaviEmptyState title="No connections" />;
  }

  return (
    <div className={`gonavi-connection-tree${className ? ' ' + className : ''}`} style={{ height }}>
      <Tree
        treeData={treeData as never}
        loadData={loadData}
        expandedKeys={expanded}
        onExpand={(keys) => setExpanded(keys.map(String))}
        onSelect={(_, info) => onSelect?.(info.node as unknown as GonaviConnectionNode)}
        onDoubleClick={(_, node) => {
          const source = node as unknown as GonaviConnectionNode;
          if (source.kind === 'table' || source.kind === 'view') onOpenTable?.(source);
        }}
      />
    </div>
  );
};
