import React, { useCallback, useMemo, useState } from 'react';
import { Tree } from 'antd';

/** One file or folder node. The host renders it as text and never touches disk. */
export interface GonaviFileNode {
  key: string;
  title: string;
  kind: 'file' | 'folder';
  isLeaf?: boolean;
  children?: GonaviFileNode[];
}

/** Sorts folders before files and keeps declarations stable inside each group. */
export function normalizeGonaviFileNodes(nodes: readonly GonaviFileNode[]): GonaviFileNode[] {
  return [...nodes]
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
      return left.title.localeCompare(right.title);
    })
    .map((node) => ({
      ...node,
      isLeaf: node.kind === 'file' ? true : (node.isLeaf ?? (node.children ? false : undefined)),
      ...(node.children ? { children: normalizeGonaviFileNodes(node.children) } : {}),
    }));
}

function mergeLoaded(nodes: readonly GonaviFileNode[], loaded: Record<string, GonaviFileNode[]>): GonaviFileNode[] {
  return normalizeGonaviFileNodes(nodes).map((node) => {
    const children = loaded[node.key] ?? node.children;
    return children ? { ...node, children: mergeLoaded(children, loaded) } : node;
  });
}

export interface GonaviFileTreeProps {
  nodes: readonly GonaviFileNode[];
  height?: number;
  selectedKeys?: string[];
  onSelect?: (node: GonaviFileNode) => void;
  /** Lazy folder children. Return [] for an empty folder; errors keep the folder closed. */
  onLoadChildren?: (node: GonaviFileNode) => Promise<GonaviFileNode[]> | GonaviFileNode[];
  /** Double-click or Enter on a file. Folders only expand. */
  onOpen?: (node: GonaviFileNode) => void;
  className?: string;
}

/**
 * Host-styled file tree for plugin windows (SFTP, archives, remote browsers).
 * Expansion state and loaded children stay in this component; the plugin owns
 * all I/O and only supplies node data through `onLoadChildren`.
 */
export const GonaviFileTree: React.FC<GonaviFileTreeProps> = ({
  nodes,
  height = 360,
  selectedKeys,
  onSelect,
  onLoadChildren,
  onOpen,
  className,
}) => {
  const [loaded, setLoaded] = useState<Record<string, GonaviFileNode[]>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const treeData = useMemo(() => mergeLoaded(nodes, loaded), [nodes, loaded]);

  const loadData = useCallback(async (node: { key: React.Key; children?: unknown[] }) => {
    if (!onLoadChildren || (node.children && node.children.length > 0)) return;
    const source = node as unknown as GonaviFileNode;
    if (source.kind !== 'folder') return;
    const children = await onLoadChildren(source);
    setLoaded((previous) => ({ ...previous, [String(node.key)]: children }));
  }, [onLoadChildren]);

  const openNode = useCallback((node: { key: React.Key } & Partial<GonaviFileNode>) => {
    const source = node as unknown as GonaviFileNode;
    if (source.kind === 'file') onOpen?.(source);
  }, [onOpen]);

  return (
    <div className={`gonavi-file-tree${className ? ' ' + className : ''}`} style={{ height }}>
      <Tree
        treeData={treeData as never}
        expandedKeys={expanded}
        selectedKeys={selectedKeys}
        loadData={onLoadChildren ? loadData : undefined}
        onExpand={(keys) => setExpanded(keys.map(String))}
        onSelect={(keys, info) => {
          const key = keys[0];
          if (key === undefined) return;
          onSelect?.(info.node as unknown as GonaviFileNode);
        }}
        onDoubleClick={(_, node) => openNode(node as unknown as GonaviFileNode)}
      />
    </div>
  );
};
