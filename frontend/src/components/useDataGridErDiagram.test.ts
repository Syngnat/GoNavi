import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForeignKeyDefinition } from '../types';
import type { ErDiagramTableSnapshot } from './dataGridErDiagramModel';
import { collectErDiagramNeighborhood, useDataGridErDiagram } from './useDataGridErDiagram';

const backendApp = vi.hoisted(() => ({
  DBGetColumns: vi.fn(),
  DBGetDatabaseForeignKeys: vi.fn(),
  DBGetForeignKeys: vi.fn(),
  DBGetIndexes: vi.fn(),
  DBGetTables: vi.fn(),
}));

vi.mock('../../wailsjs/go/app/App', () => backendApp);

const SNAPSHOTS: Record<string, ErDiagramTableSnapshot> = {
  orders: {
    tableName: 'orders',
    columns: [
      { name: 'id', type: 'bigint', nullable: 'NO', key: 'PRI', extra: '', comment: '' },
      { name: 'customer_id', type: 'bigint', nullable: 'NO', key: '', extra: '', comment: '' },
    ],
    foreignKeys: [
      {
        name: 'fk_orders_customer',
        columnName: 'customer_id',
        refTableName: 'customers',
        refColumnName: 'id',
        constraintName: 'fk_orders_customer',
      },
    ],
    uniqueKeyGroups: [['id']],
  },
  customers: {
    tableName: 'customers',
    columns: [
      { name: 'id', type: 'bigint', nullable: 'NO', key: 'PRI', extra: '', comment: '' },
      { name: 'region_id', type: 'bigint', nullable: 'NO', key: '', extra: '', comment: '' },
    ],
    foreignKeys: [
      {
        name: 'fk_customers_region',
        columnName: 'region_id',
        refTableName: 'regions',
        refColumnName: 'id',
        constraintName: 'fk_customers_region',
      },
    ],
    uniqueKeyGroups: [['id']],
  },
  order_items: {
    tableName: 'order_items',
    columns: [
      { name: 'id', type: 'bigint', nullable: 'NO', key: 'PRI', extra: '', comment: '' },
      { name: 'order_id', type: 'bigint', nullable: 'NO', key: '', extra: '', comment: '' },
    ],
    foreignKeys: [
      {
        name: 'fk_items_order',
        columnName: 'order_id',
        refTableName: 'orders',
        refColumnName: 'id',
        constraintName: 'fk_items_order',
      },
    ],
    uniqueKeyGroups: [['id']],
  },
  regions: {
    tableName: 'regions',
    columns: [
      { name: 'id', type: 'bigint', nullable: 'NO', key: 'PRI', extra: '', comment: '' },
      { name: 'name', type: 'varchar(64)', nullable: 'NO', key: '', extra: '', comment: '' },
    ],
    foreignKeys: [],
    uniqueKeyGroups: [['id']],
  },
};

describe('collectErDiagramNeighborhood', () => {
  it('expands the graph hop by hop and reports whether another layer exists', async () => {
    const loadSnapshot = vi.fn(async (tableName: string) => {
      const snapshot = SNAPSHOTS[tableName];
      if (!snapshot) {
        throw new Error(`Unknown snapshot: ${tableName}`);
      }
      return snapshot;
    });
    const loadForeignKeys = vi.fn(async (tableName: string) => {
      const snapshot = SNAPSHOTS[tableName];
      if (!snapshot) {
        throw new Error(`Unknown foreign keys: ${tableName}`);
      }
      return snapshot.foreignKeys;
    });

    const oneHop = await collectErDiagramNeighborhood({
      currentSnapshot: SNAPSHOTS.orders,
      schemaTableNames: ['orders', 'customers', 'order_items', 'regions'],
      relationDepth: 1,
      loadSnapshot,
      loadForeignKeys,
      resolveTableName: (tableName) => tableName,
    });

    expect(oneHop.relatedSnapshots.map((snapshot) => snapshot.tableName)).toEqual(
      expect.arrayContaining(['customers', 'order_items']),
    );
    expect(oneHop.relatedSnapshots.map((snapshot) => snapshot.tableName)).not.toContain('regions');
    expect(oneHop.relations.map((relation) => `${relation.sourceTableName}->${relation.targetTableName}`)).toEqual(
      expect.arrayContaining(['orders->customers', 'order_items->orders']),
    );
    expect(oneHop.canExpandRelations).toBe(true);

    const twoHop = await collectErDiagramNeighborhood({
      currentSnapshot: SNAPSHOTS.orders,
      schemaTableNames: ['orders', 'customers', 'order_items', 'regions'],
      relationDepth: 2,
      loadSnapshot,
      loadForeignKeys,
      resolveTableName: (tableName) => tableName,
    });

    expect(twoHop.relatedSnapshots.map((snapshot) => snapshot.tableName)).toEqual(
      expect.arrayContaining(['customers', 'order_items', 'regions']),
    );
    expect(twoHop.relations.map((relation) => `${relation.sourceTableName}->${relation.targetTableName}`)).toEqual(
      expect.arrayContaining(['customers->regions']),
    );
    expect(twoHop.canExpandRelations).toBe(false);
  });

  it('uses a prefetched foreign-key snapshot instead of scanning every table', async () => {
    const unrelatedTables = Array.from({ length: 500 }, (_, index) => `unrelated_${index}`);
    const schemaTableNames = ['orders', 'customers', 'order_items', ...unrelatedTables];
    const loadSnapshot = vi.fn(async (tableName: string) => ({
      tableName,
      columns: [],
      foreignKeys: [],
      uniqueKeyGroups: [],
    }));
    const loadForeignKeys = vi.fn(async () => []);
    const prefetchedForeignKeysByTable = new Map<string, ForeignKeyDefinition[]>(
      schemaTableNames.map((tableName) => [tableName, []]),
    );
    prefetchedForeignKeysByTable.set('orders', [{
      name: 'fk_orders_customer',
      columnName: 'customer_id',
      refTableName: 'customers',
      refColumnName: 'id',
      constraintName: 'fk_orders_customer',
    }]);
    prefetchedForeignKeysByTable.set('order_items', [{
      name: 'fk_items_order',
      columnName: 'order_id',
      refTableName: 'orders',
      refColumnName: 'id',
      constraintName: 'fk_items_order',
    }]);

    const result = await collectErDiagramNeighborhood({
      currentSnapshot: {
        tableName: 'orders',
        columns: [],
        foreignKeys: [],
        uniqueKeyGroups: [],
      },
      schemaTableNames,
      relationDepth: 1,
      loadSnapshot,
      loadForeignKeys,
      resolveTableName: (tableName) => tableName,
      prefetchedForeignKeysByTable,
    });

    expect(result.relations.map((relation) => `${relation.sourceTableName}->${relation.targetTableName}`)).toEqual(
      expect.arrayContaining(['orders->customers', 'order_items->orders']),
    );
    expect(loadForeignKeys).not.toHaveBeenCalled();
  });
});

describe('useDataGridErDiagram cache invalidation', () => {
  beforeEach(() => {
    Object.values(backendApp).forEach((mock) => mock.mockReset());
    backendApp.DBGetColumns.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetDatabaseForeignKeys.mockResolvedValue({ success: true, data: {} });
    backendApp.DBGetForeignKeys.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetIndexes.mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetTables.mockResolvedValue({ success: true, data: [{ table: 'orders' }] });
  });

  it('reuses cached metadata until reload invalidates the active connection and database prefix', async () => {
    let controller: ReturnType<typeof useDataGridErDiagram> | null = null;
    let renderer: ReactTestRenderer | null = null;
    const params = {
      connections: [{
        id: 'er-cache-invalidation-test',
        config: { type: 'mysql', host: '127.0.0.1', port: 3306 },
      }],
      connectionId: 'er-cache-invalidation-test',
      dbName: 'app',
      tableName: 'orders',
    };
    const Harness = () => {
      controller = useDataGridErDiagram(params);
      return null;
    };
    const waitForLoad = async () => {
      await vi.waitFor(() => {
        expect(controller?.loading).toBe(false);
        expect(controller?.graph).not.toBeNull();
      });
    };

    await act(async () => {
      renderer = create(React.createElement(Harness));
      await waitForLoad();
    });

    expect(backendApp.DBGetColumns).toHaveBeenCalledTimes(1);
    expect(backendApp.DBGetForeignKeys).toHaveBeenCalledTimes(1);
    expect(backendApp.DBGetIndexes).toHaveBeenCalledTimes(1);
    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(1);

    act(() => {
      renderer?.unmount();
      renderer = null;
    });

    await act(async () => {
      renderer = create(React.createElement(Harness));
      await waitForLoad();
    });

    expect(backendApp.DBGetColumns).toHaveBeenCalledTimes(1);
    expect(backendApp.DBGetForeignKeys).toHaveBeenCalledTimes(1);
    expect(backendApp.DBGetIndexes).toHaveBeenCalledTimes(1);
    expect(backendApp.DBGetTables).toHaveBeenCalledTimes(1);

    await act(async () => {
      controller?.reload();
      await vi.waitFor(() => {
        expect(backendApp.DBGetColumns).toHaveBeenCalledTimes(2);
        expect(backendApp.DBGetForeignKeys).toHaveBeenCalledTimes(2);
        expect(backendApp.DBGetIndexes).toHaveBeenCalledTimes(2);
        expect(backendApp.DBGetTables).toHaveBeenCalledTimes(2);
      });
    });

    act(() => {
      renderer?.unmount();
    });
  });

  it('loads one Kingbase foreign-key snapshot instead of querying every table', async () => {
    const unrelatedTables = Array.from({ length: 500 }, (_, index) => ({
      table: `ldf_server.unrelated_${index}`,
    }));
    backendApp.DBGetTables.mockResolvedValue({
      success: true,
      data: [{ table: 'ldf_server.orders' }, ...unrelatedTables],
    });

    let controller: ReturnType<typeof useDataGridErDiagram> | null = null;
    let renderer: ReactTestRenderer | null = null;
    const params = {
      connections: [{
        id: 'kingbase-er-snapshot-test',
        config: {
          type: 'kingbase',
          host: '127.0.0.1',
          port: 54321,
          database: 'ldf_server_dbs_dev',
        },
      }],
      connectionId: 'kingbase-er-snapshot-test',
      dbName: 'ldf_server_dbs_dev',
      tableName: 'ldf_server.orders',
    };
    const Harness = () => {
      controller = useDataGridErDiagram(params);
      return null;
    };

    await act(async () => {
      renderer = create(React.createElement(Harness));
      await vi.waitFor(() => {
        expect(controller?.loading).toBe(false);
        expect(controller?.graph).not.toBeNull();
      });
    });

    expect(backendApp.DBGetDatabaseForeignKeys).toHaveBeenCalledTimes(1);
    expect(backendApp.DBGetForeignKeys).not.toHaveBeenCalled();

    act(() => {
      renderer?.unmount();
    });
  });
});
