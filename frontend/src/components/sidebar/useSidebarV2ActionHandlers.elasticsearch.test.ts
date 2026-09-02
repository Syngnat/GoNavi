import { describe, expect, it, vi } from 'vitest';

import { buildElasticsearchConsoleTemplates } from '../../utils/elasticsearchConsole';
import { useSidebarV2ActionHandlers } from './useSidebarV2ActionHandlers';

const buildHandlers = () => {
  const addTab = vi.fn();
  const setTargetConnection = vi.fn();
  const setIsCreateDbModalOpen = vi.fn();
  const noop = vi.fn();
  const handlers = useSidebarV2ActionHandlers({
    connections: [],
    connectionTags: [],
    pinnedSidebarTables: [],
    pinnedSidebarDatabases: [],
    loadingNodesRef: { current: new Set() },
    treeDataRef: { current: [] },
    findTreeNodeByKeyRef: { current: () => null },
    refreshV2TableContextMenuStatsRef: { current: noop },
    addTab,
    setTargetConnection,
    setIsCreateDbModalOpen,
    buildConnectionRootQueryTabTitle: () => 'New query',
  } as any);
  return { handlers, addTab, setTargetConnection, setIsCreateDbModalOpen };
};

describe('useSidebarV2ActionHandlers Elasticsearch create action', () => {
  it('opens a prefilled Elasticsearch Console query instead of the database modal', () => {
    const { handlers, addTab, setTargetConnection, setIsCreateDbModalOpen } = buildHandlers();
    handlers.handleV2ConnectionContextMenuAction({
      key: 'elasticsearch-1',
      dataRef: {
        id: 'elasticsearch-1',
        name: 'Elasticsearch dev',
        config: { type: 'elasticsearch', host: '127.0.0.1', port: 9200 },
      },
    }, 'new-db');

    const createIndexSource = buildElasticsearchConsoleTemplates('')
      .find((template) => template.id === 'create_index')?.source;
    expect(addTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'query',
      connectionId: 'elasticsearch-1',
      dbName: undefined,
      query: createIndexSource,
    }));
    expect(setTargetConnection).not.toHaveBeenCalled();
    expect(setIsCreateDbModalOpen).not.toHaveBeenCalled();
  });

  it('does not open an executable create path for protected Elasticsearch connections', () => {
    [
      { readOnly: true },
      { protection: { restrictStructureEdit: true } },
    ].forEach((guard, index) => {
      const { handlers, addTab, setTargetConnection, setIsCreateDbModalOpen } = buildHandlers();
      handlers.handleV2ConnectionContextMenuAction({
        key: `elasticsearch-protected-${index}`,
        dataRef: {
          id: `elasticsearch-protected-${index}`,
          name: 'Elasticsearch protected',
          config: {
            type: 'elasticsearch',
            host: '127.0.0.1',
            port: 9200,
            ...guard,
          },
        },
      }, 'new-db');

      expect(addTab).not.toHaveBeenCalled();
      expect(setTargetConnection).not.toHaveBeenCalled();
      expect(setIsCreateDbModalOpen).not.toHaveBeenCalled();
    });
  });

  it('keeps the existing database modal path for SQL connections', () => {
    const { handlers, addTab, setTargetConnection, setIsCreateDbModalOpen } = buildHandlers();
    const node = {
      key: 'mysql-1',
      dataRef: {
        id: 'mysql-1',
        name: 'MySQL dev',
        config: { type: 'mysql', host: '127.0.0.1', port: 3306 },
      },
    };

    handlers.handleV2ConnectionContextMenuAction(node, 'new-db');

    expect(setTargetConnection).toHaveBeenCalledWith(node);
    expect(setIsCreateDbModalOpen).toHaveBeenCalledWith(true);
    expect(addTab).not.toHaveBeenCalled();
  });
});
