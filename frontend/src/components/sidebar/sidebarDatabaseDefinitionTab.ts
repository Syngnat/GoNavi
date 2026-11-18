import type { TabData } from '../../types';

export interface SidebarDatabaseDefinitionTabInput {
  connectionId: string;
  dbName: string;
  nodeKey?: string;
  title: string;
}

export const buildSidebarDatabaseDefinitionTab = (
  input: SidebarDatabaseDefinitionTabInput,
): TabData | null => {
  const connectionId = String(input.connectionId || '').trim();
  const dbName = String(input.dbName || '').trim();
  if (!connectionId || !dbName) return null;
  return {
    id: `database-def-${connectionId}-${dbName}`,
    title: input.title,
    type: 'database-def',
    connectionId,
    dbName,
    readOnly: true,
    sidebarLocateKey: String(input.nodeKey || ''),
  };
};
