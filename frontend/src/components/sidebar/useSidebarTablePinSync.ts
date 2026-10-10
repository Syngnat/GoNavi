import { useEffect, useRef } from 'react';
import type { SidebarTreeNode } from './sidebarV2TreeNodes';
import { syncLoadedSidebarTablePins } from './sidebarTablePinRefresh';

type ReplaceTreeNodeChildren = (key: React.Key, children: SidebarTreeNode[] | undefined) => void;

/**
 * Table overview pins the same store keys, then asks the sidebar to catch up.
 * Apply that catch-up in place so PostgreSQL schemas stay expanded.
 */
export const useSidebarTablePinSync = ({
  treeDataRef,
  replaceTreeNodeChildren,
}: {
  treeDataRef: { current: SidebarTreeNode[] };
  replaceTreeNodeChildren: ReplaceTreeNodeChildren;
}) => {
  const replaceRef = useRef(replaceTreeNodeChildren);
  replaceRef.current = replaceTreeNodeChildren;

  useEffect(() => {
    const handleSidebarTablePinChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      const connectionId = String(detail.connectionId || '').trim();
      const dbName = String(detail.dbName || '').trim();
      if (!connectionId || !dbName) return;
      syncLoadedSidebarTablePins(
        treeDataRef.current,
        { connectionId, dbName },
        (key, children) => replaceRef.current(key, children),
      );
    };
    window.addEventListener('gonavi:sidebar-table-pin-changed', handleSidebarTablePinChanged);
    return () => window.removeEventListener('gonavi:sidebar-table-pin-changed', handleSidebarTablePinChanged);
  }, [treeDataRef]);
};
