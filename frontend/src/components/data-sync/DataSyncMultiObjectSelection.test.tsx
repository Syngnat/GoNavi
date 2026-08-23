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
  type DataSyncFieldMetadata,
  type DataSyncObjectMetadata,
} from './model';
import { DataSyncWorkbenchShell } from './DataSyncWorkbenchShell';

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const buttonWithText = (
  renderer: TestRenderer.ReactTestRenderer,
  text: string,
) =>
  renderer.root
    .findAllByType('button')
    .find((button) => button.children.includes(text))!;

describe('data sync multi-object selection', () => {
  it('adds all current source tables, matches targets, and detects keys in one action', async () => {
    const draft = createDataSyncTaskDraft({
      id: 'multi-table-task',
      kind: 'reconcile',
      name: 'Migrate selected tables',
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
      schema: '',
    };
    const task = reviseDataSyncTask(draft, { source, target });
    const names = ['admin_users', 'messages', 'push_records'];
    const fieldsByObject = Object.fromEntries(
      names.map((name) => [
        dataSyncObjectMetadataKey(source, name),
        [
          { name: 'id', type: 'bigint', nullable: false, ordinal: 1, key: true },
          { name: 'payload', type: 'text', nullable: true, ordinal: 2, key: false },
        ],
      ]),
    );
    const gateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      savedConnections: [
        { id: 'source', name: 'Source', type: 'mysql', readable: true, writable: true },
        { id: 'target', name: 'Target', type: 'postgresql', readable: true, writable: true },
      ],
      objectsByEndpoint: {
        [dataSyncEndpointMetadataKey(source)]: names.map((name) => ({
          name,
          kind: 'table' as const,
        })),
        [dataSyncEndpointMetadataKey(target)]: names.map((name) => ({
          name,
          kind: 'table' as const,
        })),
      },
      fieldsByObject,
      capabilities: {
        [task.id]: {
          level: 'full',
          canExecute: true,
          supportsAutoCreate: true,
          supportsAutoAddColumns: true,
          requiresExistingTarget: false,
          supportsCdc: false,
        },
      },
    });
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell
        initialTasks={[task]}
        gateway={gateway}
        locale="zh-CN"
      />,
    );
    await flush();

    act(() => buttonWithText(renderer, '选择同步数据').props.onClick());
    await flush();
    act(() => buttonWithText(renderer, '选择源对象').props.onClick());
    const selectAll = renderer.root.findByProps({
      'data-object-picker-control': 'select-filtered',
    });
    act(() => selectAll.props.onChange({ target: { checked: true } }));
    act(() => buttonWithText(renderer, '添加 3 个对象').props.onClick());
    await flush();
    await flush();

    expect(renderer.root.findAllByProps({ 'data-ready': 'true' })).toHaveLength(3);
    expect(
      renderer.root
        .findAllByProps({ 'data-object-side': 'source' })
        .map((input) => input.props.value),
    ).toEqual(names);
  });

  it('waits for target metadata before offering safe automatic matching', async () => {
    const draft = createDataSyncTaskDraft({
      id: 'wait-for-target-task',
      kind: 'reconcile',
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
      schema: '',
    };
    const task = reviseDataSyncTask(draft, { source, target });
    const targetObjects = deferred<DataSyncObjectMetadata[]>();
    const baseGateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      objectsByEndpoint: {
        [dataSyncEndpointMetadataKey(source)]: [{ name: 'orders', kind: 'table' }],
      },
    });
    const gateway: DataSyncWorkbenchGateway = {
      ...baseGateway,
      listObjects: (endpoint) =>
        endpoint.connectionId === 'target'
          ? targetObjects.promise
          : baseGateway.listObjects(endpoint),
    };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="zh-CN" />,
    );
    await flush();
    act(() => buttonWithText(renderer, '选择同步数据').props.onClick());
    await flush();

    expect(buttonWithText(renderer, '选择源对象').props.disabled).toBe(true);
    await act(async () => {
      targetObjects.resolve([{ name: 'orders', kind: 'table' }]);
      await targetObjects.promise;
    });
    expect(buttonWithText(renderer, '选择源对象').props.disabled).toBe(false);
  });

  it('preserves edits made while asynchronous key detection is running', async () => {
    const draft = createDataSyncTaskDraft({
      id: 'merge-late-metadata-task',
      kind: 'reconcile',
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
      schema: '',
    };
    const existing = {
      ...createDataSyncTableMapping('existing-map', 'customers', 'customers'),
      keyColumns: ['id'],
    };
    const task = reviseDataSyncTask(draft, {
      source,
      target,
      mappings: [existing],
    });
    const orderFields = deferred<DataSyncFieldMetadata[]>();
    const names = ['customers', 'orders'];
    const baseGateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      objectsByEndpoint: {
        [dataSyncEndpointMetadataKey(source)]: names.map((name) => ({
          name,
          kind: 'table' as const,
        })),
        [dataSyncEndpointMetadataKey(target)]: names.map((name) => ({
          name,
          kind: 'table' as const,
        })),
      },
    });
    const gateway: DataSyncWorkbenchGateway = {
      ...baseGateway,
      listFields: (endpoint, objectName) =>
        endpoint.connectionId === 'source' && objectName === 'orders'
          ? orderFields.promise
          : baseGateway.listFields(endpoint, objectName),
    };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="zh-CN" />,
    );
    await flush();
    act(() => buttonWithText(renderer, '选择同步数据').props.onClick());
    await flush();
    act(() => buttonWithText(renderer, '选择源对象').props.onClick());
    act(() =>
      renderer.root
        .findByProps({ 'data-object-name': 'orders' })
        .findByType('input')
        .props.onChange({ target: { checked: true } }),
    );
    act(() => buttonWithText(renderer, '添加 1 个对象').props.onClick());

    const existingTarget = renderer.root.findAllByProps({
      'data-object-side': 'target',
    })[0];
    act(() =>
      existingTarget.props.onChange({ target: { value: 'customers_archive' } }),
    );
    await act(async () => {
      orderFields.resolve([
        { name: 'id', type: 'bigint', nullable: false, ordinal: 1, key: true },
      ]);
      await orderFields.promise;
      await Promise.resolve();
    });

    expect(
      renderer.root
        .findAllByProps({ 'data-object-side': 'target' })
        .map((input) => input.props.value),
    ).toEqual(['customers_archive', 'orders']);
    expect(
      renderer.root.findByProps({ 'data-mapping-id': 'existing-map' }).props[
        'data-ready'
      ],
    ).toBe('false');
  });

  it('does not label an incomplete CDC mapping as configured', async () => {
    const source = {
      connectionId: 'source',
      connectionName: 'Source',
      type: 'mongodb',
      database: 'sales',
      schema: '',
    };
    const target = {
      connectionId: 'target',
      connectionName: 'Target',
      type: 'postgresql',
      database: 'warehouse',
      schema: '',
    };
    const draft = createDataSyncTaskDraft({
      id: 'cdc-ready-state-task',
      kind: 'cdc',
    });
    const mapping = {
      ...createDataSyncTableMapping('cdc-map', 'users', 'users'),
      keyColumns: ['id'],
      fields: [],
    };
    const task = reviseDataSyncTask(draft, {
      source,
      target,
      mappings: [mapping],
    });
    const gateway = createStaticDataSyncWorkbenchGateway({
      tasks: [task],
      objectsByEndpoint: {
        [dataSyncEndpointMetadataKey(source)]: [{ name: 'users', kind: 'collection' }],
        [dataSyncEndpointMetadataKey(target)]: [{ name: 'users', kind: 'table' }],
      },
      capabilities: {
        [task.id]: {
          level: 'full',
          canExecute: true,
          supportsAutoCreate: false,
          supportsAutoAddColumns: false,
          requiresExistingTarget: true,
          supportsCdc: true,
        },
      },
    });
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="zh-CN" />,
    );
    await flush();
    act(() => buttonWithText(renderer, '选择同步数据').props.onClick());
    await flush();

    expect(renderer.root.findAllByProps({ 'data-ready': 'true' })).toHaveLength(0);
    expect(buttonWithText(renderer, '需要确认同步字段')).toBeTruthy();
  });
});
