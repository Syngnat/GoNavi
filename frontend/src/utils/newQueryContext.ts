export interface NewQueryContextLike {
  connectionId?: unknown;
  dbName?: unknown;
}

export interface NewQueryContext {
  connectionId: string;
  dbName: string;
}

const normalizeValidContext = (
  context: NewQueryContextLike | null | undefined,
  validConnectionIds: ReadonlySet<string>,
): NewQueryContext | null => {
  const connectionId = String(context?.connectionId || '').trim();
  if (!connectionId || !validConnectionIds.has(connectionId)) {
    return null;
  }
  return {
    connectionId,
    dbName: String(context?.dbName ?? ''),
  };
};

export const resolveNewQueryContext = ({
  sidebarContext,
  activeTab,
  validConnectionIds,
}: {
  sidebarContext?: NewQueryContextLike | null;
  activeTab?: NewQueryContextLike | null;
  validConnectionIds: ReadonlySet<string>;
}): NewQueryContext => (
  normalizeValidContext(sidebarContext, validConnectionIds)
  || normalizeValidContext(activeTab, validConnectionIds)
  || { connectionId: '', dbName: '' }
);
export interface NewQueryTableContextLike extends NewQueryContextLike {
  type?: unknown;
  tableName?: unknown;
}

export const canInheritNewQueryTableContext = ({
  activeTab,
  targetContext,
}: {
  activeTab?: NewQueryTableContextLike | null;
  targetContext: NewQueryContext;
}): boolean => {
  const tabType = String(activeTab?.type || '');
  return (tabType === 'table' || tabType === 'design')
    && String(activeTab?.connectionId || '').trim() === targetContext.connectionId
    && String(activeTab?.dbName || '').trim() === targetContext.dbName;
};
