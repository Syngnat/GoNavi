import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import {
  createStaticDataSyncWorkbenchGateway,
  dataSyncEndpointMetadataKey,
  dataSyncObjectMetadataKey,
  type DataSyncWorkbenchGateway,
} from './gateway';
import {
  createDataSyncTableMapping,
  createDataSyncTaskDraft,
  reviseDataSyncTask,
  type DataSyncDatabaseMetadata,
} from './model';
import { DataSyncWorkbenchShell } from './DataSyncWorkbenchShell';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const stageButton = (renderer: TestRenderer.ReactTestRenderer, label: string) =>
  renderer.root
    .findAllByType('button')
    .find(
      (button) =>
        String(button.props['aria-label'] || '').startsWith(`${label} ·`) ||
        button.children.includes(label) ||
        button.findAll((node) => node.children.includes(label)).length > 0,
    )!;

describe('data sync metadata selectors', () => {
  it('reveals database controls after selecting a connection without exposing prompt rows', async () => {
    const task = createDataSyncTaskDraft({
      id: 'empty-endpoint-options',
      kind: 'reconcile',
    });
    const gateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      savedConnections: [
        { id: 'source', name: 'Source', type: 'mysql', readable: true, writable: true },
      ],
    });
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="zh-CN" />,
    );
    await flush();

    const sourceEndpoint = renderer.root.findByProps({
      'data-endpoint-role': 'source',
    });
    const connection = sourceEndpoint.findByProps({
      'data-endpoint-control': 'connection',
    });
    expect(
      sourceEndpoint.findAllByProps({ 'data-endpoint-control': 'database' }),
    ).toHaveLength(0);
    expect(connection.props.value).toBeUndefined();
    expect(connection.props.placeholder).toBe('选择连接');
    expect(connection.props.treeData.map((node: { value: string }) => node.value)).toEqual([
      'connection:source',
    ]);

    await act(async () => {
      connection.props.onChange('connection:source');
    });
    await flush();

    const expandedSourceEndpoint = renderer.root.findByProps({
      'data-endpoint-role': 'source',
    });
    const database = expandedSourceEndpoint.findByProps({
      'data-endpoint-control': 'database',
    });
    const databasePrompt = database
      .findAllByType('option')
      .find((option) => option.props.value === '')!;

    expect(connection.props.value).toBe('connection:source');
    expect(connection.props.allowClear).toBe(true);
    expect(database.props.value).toBe('');
    expect(databasePrompt.props).toEqual(
      expect.objectContaining({ disabled: true, hidden: true }),
    );

    act(() => connection.props.onChange(undefined));
    expect(
      renderer.root
        .findByProps({ 'data-endpoint-role': 'source' })
        .findAllByProps({ 'data-endpoint-control': 'database' }),
    ).toHaveLength(0);
  });

  it('does not expose empty prompt rows after a connection and database are selected', async () => {
    const draft = createDataSyncTaskDraft({
      id: 'selected-endpoint-options',
      kind: 'reconcile',
    });
    const task = reviseDataSyncTask(draft, {
      source: {
        connectionId: 'source',
        connectionName: 'Source',
        type: 'mysql',
        database: 'sales',
        schema: '',
      },
      target: {
        connectionId: 'target',
        connectionName: 'Target',
        type: 'postgresql',
        database: 'warehouse',
        schema: 'public',
      },
    });
    const gateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      savedConnections: [
        { id: 'source', name: 'Source', type: 'mysql', readable: true, writable: true },
        { id: 'target', name: 'Target', type: 'postgresql', readable: true, writable: true },
      ],
      databasesByConnection: {
        source: [{ name: 'sales' }],
        target: [{ name: 'warehouse' }],
      },
    });
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="zh-CN" />,
    );
    await flush();

    const sourceEndpoint = renderer.root.findByProps({
      'data-endpoint-role': 'source',
    });
    const connectionValues = sourceEndpoint
      .findByProps({ 'data-endpoint-control': 'connection' })
      .props.treeData.map((node: { value: string }) => node.value);
    const databaseValues = sourceEndpoint
      .findByProps({ 'data-endpoint-control': 'database' })
      .findAllByType('option')
      .map((option) => option.props.value);

    expect(connectionValues).not.toContain('');
    expect(connectionValues).toContain('connection:source');
    expect(databaseValues).not.toContain('');
  });

  it('commits a schema edit once instead of clearing mappings on every keystroke', async () => {
    const base = createDataSyncTaskDraft({ id: 'schema-edit-task', kind: 'reconcile' });
    const task = reviseDataSyncTask(base, {
      source: {
        connectionId: 'source',
        connectionName: 'Source',
        type: 'mysql',
        database: 'sales',
        schema: 'sales',
      },
      target: {
        connectionId: 'target',
        connectionName: 'Target',
        type: 'postgresql',
        database: 'warehouse',
        schema: 'public',
      },
      mappings: [
        {
          ...createDataSyncTableMapping('schema-edit-map', 'orders', 'orders'),
          keyColumns: ['id'],
        },
      ],
    });
    const gateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      savedConnections: [
        { id: 'source', name: 'Source', type: 'mysql', readable: true, writable: true },
        { id: 'target', name: 'Target', type: 'postgresql', readable: true, writable: true },
      ],
      databasesByConnection: {
        source: [{ name: 'sales' }],
        target: [{ name: 'warehouse' }],
      },
    });
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="en-US" />,
    );
    await flush();

    const schema = renderer.root
      .findByProps({ 'data-endpoint-role': 'source' })
      .findByProps({ 'data-endpoint-control': 'schema' });
    act(() => schema.props.onChange({ target: { value: 'sales_v2' } }));

    expect(schema.props.value).toBe('sales_v2');
    expect(renderer.root.findByProps({ 'data-dirty': 'false' })).toBeTruthy();

    act(() => schema.props.onBlur());
    expect(renderer.root.findByProps({ 'data-dirty': 'true' })).toBeTruthy();
    act(() => stageButton(renderer, 'Choose data').props.onClick());
    expect(
      renderer.root.findByProps({ 'data-mapping-id': 'schema-edit-map' })
        .findByProps({ 'data-object-side': 'source' }).props.value,
    ).toBe('');
  });

  it('ignores stale database responses and clears source-side descendants', async () => {
    const draft = createDataSyncTaskDraft({
      id: 'stale-task',
      kind: 'reconcile',
      name: 'Stale response test',
    });
    const task = reviseDataSyncTask(draft, {
      source: {
        connectionId: 'source-a',
        connectionName: 'Source A',
        type: 'mysql',
        database: 'a-db',
        schema: 'sales',
      },
      target: {
        connectionId: 'target',
        connectionName: 'Target',
        type: 'postgresql',
        database: 'target-db',
        schema: 'public',
      },
      mappings: [
        {
          ...createDataSyncTableMapping('stale-map', 'orders', 'fact_orders'),
          keyColumns: ['id'],
          fields: [
            {
              id: 'field-id',
              sourceField: 'id',
              targetField: 'id',
              sourceType: 'bigint',
              targetType: 'int8',
              transform: 'CAST({value} AS BIGINT)',
              nullable: false,
            },
          ],
        },
      ],
    });
    const sourceA = deferred<DataSyncDatabaseMetadata[]>();
    const sourceB = deferred<DataSyncDatabaseMetadata[]>();
    const baseGateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      savedConnections: [
        { id: 'source-a', name: 'Source A', type: 'mysql', readable: true, writable: true },
        { id: 'source-b', name: 'Source B', type: 'oracle', readable: true, writable: true },
        { id: 'target', name: 'Target', type: 'postgresql', readable: true, writable: true },
      ],
    });
    const gateway: DataSyncWorkbenchGateway = {
      ...baseGateway,
      listDatabases: (connectionId) => {
        if (connectionId === 'source-a') return sourceA.promise;
        if (connectionId === 'source-b') return sourceB.promise;
        return Promise.resolve([{ name: 'target-db' }]);
      },
    };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="en-US" />,
    );
    await flush();

    const sourceEndpoint = renderer.root.findByProps({ 'data-endpoint-role': 'source' });
    const connectionSelect = sourceEndpoint.findByProps({
      'data-endpoint-control': 'connection',
    });
    act(() => {
      connectionSelect.props.onChange('connection:source-b');
    });
    await flush();

    await act(async () => {
      sourceB.resolve([{ name: 'b-db' }]);
      await sourceB.promise;
    });
    const databaseSelect = renderer.root
      .findByProps({ 'data-endpoint-role': 'source' })
      .findByProps({ 'data-endpoint-control': 'database' });
    expect(
      databaseSelect.findAllByType('option').map((option) => option.props.value),
    ).toContain('b-db');

    await act(async () => {
      sourceA.resolve([{ name: 'late-a-db' }]);
      await sourceA.promise;
    });
    expect(
      renderer.root
        .findByProps({ 'data-endpoint-role': 'source' })
        .findByProps({ 'data-endpoint-control': 'database' })
        .findAllByType('option')
        .map((option) => option.props.value),
    ).toEqual(['', 'b-db']);

    act(() => stageButton(renderer, 'Choose data').props.onClick());
    const sourceObjectInput = renderer.root.findByProps({ 'data-object-side': 'source' });
    expect(sourceObjectInput.props.value).toBe('');
    expect(renderer.root.findByProps({ 'data-dirty': 'true' })).toBeTruthy();
  });

  it('auto-matches gateway fields and keeps transforms editable', async () => {
    const draft = createDataSyncTaskDraft({
      id: 'field-task',
      kind: 'migration',
      name: 'Field mapping test',
    });
    const source = {
      connectionId: 'source',
      connectionName: 'Source',
      type: 'mysql',
      database: 'sales',
      schema: '',
    };
    const target = {
      connectionId: 'target',
      connectionName: 'Target',
      type: 'postgresql',
      database: 'warehouse',
      schema: 'public',
    };
    const task = reviseDataSyncTask(draft, {
      source,
      target,
      mappings: [createDataSyncTableMapping('field-map', 'orders', 'fact_orders')],
    });
    const gateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      savedConnections: [
        { id: 'source', name: 'Source', type: 'mysql', readable: true, writable: true },
        { id: 'target', name: 'Target', type: 'postgresql', readable: true, writable: true },
      ],
      databasesByConnection: {
        source: [{ name: 'sales' }],
        target: [{ name: 'warehouse' }],
      },
      objectsByEndpoint: {
        [dataSyncEndpointMetadataKey(source)]: [{ name: 'orders', kind: 'table' }],
        [dataSyncEndpointMetadataKey(target)]: [{ name: 'fact_orders', kind: 'table' }],
      },
      fieldsByObject: {
        [dataSyncObjectMetadataKey(source, 'orders')]: [
          { name: 'id', type: 'bigint', nullable: false, ordinal: 1, key: true },
          { name: 'amount', type: 'decimal', nullable: false, ordinal: 2, key: false },
        ],
        [dataSyncObjectMetadataKey(target, 'fact_orders')]: [
          { name: 'ID', type: 'int8', nullable: false, ordinal: 1, key: true },
          { name: 'amount', type: 'numeric', nullable: true, ordinal: 2, key: false },
        ],
      },
    });
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="en-US" />,
    );
    await flush();
    act(() => stageButton(renderer, 'Choose data').props.onClick());
    await flush();

    act(() => stageButton(renderer, 'Edit exception').props.onClick());
    act(() => stageButton(renderer, 'Automatic same-name fields').props.onClick());
    await flush();
    const fieldMappingDialog = renderer.root.findByProps({
      'data-data-sync-field-mapping': 'field-map',
    });
    expect(fieldMappingDialog.props).toEqual(
      expect.objectContaining({ role: 'dialog', 'aria-modal': 'true' }),
    );
    expect(
      renderer.root.findByProps({ 'data-data-sync-overlay': 'field-mapping' }),
    ).toBeTruthy();
    act(() => stageButton(renderer, 'Match same names').props.onClick());

    expect(renderer.root.findAllByProps({ 'data-field-control': 'transform' })).toHaveLength(2);
    const transform = renderer.root.findAllByProps({
      'data-field-control': 'transform',
    })[1];
    act(() => {
      transform.props.onChange({ target: { value: 'upper' } });
    });

    expect(
      renderer.root.findAllByProps({ 'data-field-control': 'transform' })[1].props.value,
    ).toBe('upper');
    expect(stageButton(renderer, '2 fields')).toBeTruthy();
  });

  it('surfaces metadata errors and retries without discarding the draft endpoint', async () => {
    const draft = createDataSyncTaskDraft({
      id: 'retry-task',
      kind: 'migration',
      name: 'Retry metadata',
    });
    const task = reviseDataSyncTask(draft, {
      source: {
        connectionId: 'broken-source',
        connectionName: 'Broken source',
        type: 'mysql',
        database: 'remembered-db',
        schema: '',
      },
    });
    let attempts = 0;
    const baseGateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      savedConnections: [
        {
          id: 'broken-source',
          name: 'Broken source',
          type: 'mysql',
          readable: true,
          writable: true,
        },
      ],
    });
    const gateway: DataSyncWorkbenchGateway = {
      ...baseGateway,
      listDatabases: async (connectionId) => {
        if (connectionId !== 'broken-source') return [];
        attempts += 1;
        if (attempts === 1) throw new Error('temporary metadata outage');
        return [{ name: 'recovered-db' }];
      },
    };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="en-US" />,
    );
    await flush();

    const errorState = renderer.root.findByProps({
      'data-metadata-scope': 'source-databases',
      'data-status': 'error',
    });
    expect(
      renderer.root
        .findByProps({ 'data-endpoint-role': 'source' })
        .findByProps({ 'data-endpoint-control': 'database' }).props.value,
    ).toBe('remembered-db');

    act(() => {
      errorState
        .findAllByType('button')
        .find((button) => button.children.includes('Retry'))!
        .props.onClick();
    });
    await flush();

    expect(
      renderer.root
        .findByProps({ 'data-endpoint-role': 'source' })
        .findByProps({ 'data-endpoint-control': 'database' })
        .findAllByType('option')
        .map((option) => option.props.value),
    ).toContain('recovered-db');
    expect(attempts).toBe(2);
  });
});
