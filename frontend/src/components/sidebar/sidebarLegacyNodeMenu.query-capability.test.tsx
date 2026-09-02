import { describe, expect, it, vi } from 'vitest';

import { t } from '../../i18n';
import { buildElasticsearchConsoleTemplates } from '../../utils/elasticsearchConsole';
import { buildSidebarLegacyNodeMenuItems } from './sidebarLegacyNodeMenu';

const buildConnectionRootItems = (
  connection: any,
  connectionTags: any[] = [],
  overrides: Record<string, any> = {},
) =>
  buildSidebarLegacyNodeMenuItems({
    key: connection.id,
    type: 'connection',
    dataRef: connection,
  }, {
    addTab: vi.fn(),
    loadDatabases: vi.fn(),
    handleRunSQLFile: vi.fn(),
    buildConnectionRootQueryTabTitle: vi.fn(() => 'query'),
    resolveMessagePublishTarget: vi.fn(() => null),
    connectionTags,
    ...overrides,
  }) as any[];

const itemKeys = (items: any[]) => items.map((item) => item?.key);

describe('connection root menu query entry gating', () => {
  it('hides new query and run SQL file for JVM connections', () => {
    const items = buildConnectionRootItems({
      id: 'jvm-1',
      name: 'JVM workbench',
      config: { type: 'jvm', host: '127.0.0.1', port: 8080 },
    });
    expect(itemKeys(items)).not.toContain('new-query');
    expect(itemKeys(items)).not.toContain('open-sql-file');
  });

  it('keeps new query and run SQL file for SQL connections', () => {
    const items = buildConnectionRootItems({
      id: 'mysql-1',
      name: 'MySQL dev',
      config: { type: 'mysql', host: '127.0.0.1', port: 3306 },
    });
    expect(itemKeys(items)).toContain('new-query');
    expect(itemKeys(items)).toContain('open-sql-file');
  });

  it('routes messaging connections to the message workbench instead of generic queries', () => {
    [
      { type: 'mqtt', host: '127.0.0.1', port: 1883 },
      { type: 'rocketmq', host: '127.0.0.1', port: 9876 },
    ].forEach((config, index) => {
      const items = buildConnectionRootItems({
        id: `message-queue-${index}`,
        name: `message queue ${index}`,
        config,
      });
      expect(itemKeys(items), JSON.stringify(config)).toContain('open-message-workbench');
      expect(itemKeys(items), JSON.stringify(config)).toContain('consume-messages');
      expect(itemKeys(items), JSON.stringify(config)).not.toContain('new-query');
      expect(itemKeys(items), JSON.stringify(config)).not.toContain('open-sql-file');
    });
  });

  it('keeps new query for currently queryable vector and document connections', () => {
    [
      { type: 'chroma', host: '127.0.0.1', port: 8000 },
      { type: 'elasticsearch', host: '127.0.0.1', port: 9200 },
      { type: 'mongodb', host: '127.0.0.1', port: 27017 },
    ].forEach((config, index) => {
      const items = buildConnectionRootItems({
        id: `query-capable-${index}`,
        name: `query capable ${index}`,
        config,
      });
      expect(itemKeys(items), JSON.stringify(config)).toContain('new-query');
      expect(itemKeys(items), JSON.stringify(config)).toContain('open-sql-file');
    });
  });

  it('offers direct Elasticsearch index creation with index terminology', () => {
    const addTab = vi.fn();
    const setTargetConnection = vi.fn();
    const setIsCreateDbModalOpen = vi.fn();
    const items = buildConnectionRootItems({
      id: 'elasticsearch-1',
      name: 'Elasticsearch dev',
      config: { type: 'elasticsearch', host: '127.0.0.1', port: 9200 },
    }, [], { addTab, setTargetConnection, setIsCreateDbModalOpen });
    const createItem = items.find((item) => item?.key === 'new-db');

    expect(createItem).toBeDefined();
    expect(createItem.label).toBe(t('query_editor.elasticsearch.templates.create_index'));
    createItem.onClick();
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

  it('does not offer Elasticsearch index creation when structure editing is restricted', () => {
    [
      { readOnly: true },
      { protection: { restrictStructureEdit: true } },
    ].forEach((guard, index) => {
      const items = buildConnectionRootItems({
        id: `elasticsearch-readonly-${index}`,
        name: 'Elasticsearch guarded',
        config: {
          type: 'elasticsearch',
          host: '127.0.0.1',
          port: 9200,
          ...guard,
        },
      });
      expect(itemKeys(items)).not.toContain('new-db');
    });
  });

  it('only offers moving out of a group when the connection belongs to one', () => {
    const ungroupedItems = buildConnectionRootItems({
      id: 'mysql-ungrouped',
      name: 'MySQL ungrouped',
      config: { type: 'mysql', host: '127.0.0.1', port: 3306 },
    }, [{
      id: 'team',
      name: '团队环境',
      connectionIds: ['mysql-grouped'],
    }]);
    const ungroupedTagMenu = ungroupedItems.find((item) => item?.key === 'move-to-tag');

    expect(itemKeys(ungroupedTagMenu.children)).toContain('move-to-tag-team');
    expect(itemKeys(ungroupedTagMenu.children)).not.toContain('move-to-ungrouped');

    const groupedItems = buildConnectionRootItems({
      id: 'mysql-grouped',
      name: 'MySQL grouped',
      config: { type: 'mysql', host: '127.0.0.1', port: 3306 },
    }, [{
      id: 'team',
      name: '团队环境',
      connectionIds: ['mysql-grouped'],
    }]);
    const groupedTagMenu = groupedItems.find((item) => item?.key === 'move-to-tag');

    expect(itemKeys(groupedTagMenu.children)).toContain('move-to-ungrouped');
  });
});
