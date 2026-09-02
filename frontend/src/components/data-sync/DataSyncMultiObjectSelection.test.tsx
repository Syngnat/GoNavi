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

const buttonsWithText = (
  renderer: TestRenderer.ReactTestRenderer,
  text: string,
) =>
  renderer.root
    .findAllByType('button')
    .filter(
      (button) =>
        button.children.includes(text) ||
        button.findAll((node) => node.children.includes(text)).length > 0,
    );

const buttonWithText = (
  renderer: TestRenderer.ReactTestRenderer,
  text: string,
) => buttonsWithText(renderer, text)[0]!;

const sourceObjectAction = (renderer: TestRenderer.ReactTestRenderer) =>
  buttonsWithText(renderer, '选择源对象')[0] ??
  buttonsWithText(renderer, '添加源对象')[0]!;

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

    expect(buttonsWithText(renderer, '选择源对象')).toHaveLength(0);
    await act(async () => {
      targetObjects.resolve([{ name: 'orders', kind: 'table' }]);
      await targetObjects.promise;
    });
    expect(buttonWithText(renderer, '选择源对象').props.disabled).toBeUndefined();
  });

  it('preserves edits and deletions made while background key detection is running', async () => {
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
    act(() => buttonWithText(renderer, '添加源对象').props.onClick());
    act(() =>
      renderer.root
        .findByProps({ 'data-object-name': 'orders' })
        .findByType('input')
        .props.onChange({ target: { checked: true } }),
    );
    act(() => buttonWithText(renderer, '添加 1 个对象').props.onClick());
    await flush();

    expect(
      renderer.root.findAllByProps({ 'data-data-sync-object-picker': 'true' }),
    ).toHaveLength(0);
    expect(renderer.root.findByProps({ 'data-mapping-probe': 'running' })).toBeTruthy();

    const existingTarget = renderer.root
      .findByProps({ 'data-mapping-id': 'existing-map' })
      .findByProps({ 'data-object-side': 'target' });
    act(() =>
      existingTarget.props.onChange({ target: { value: 'customers_archive' } }),
    );
    const orderRow = renderer.root
      .findAll((node) => typeof node.props['data-mapping-id'] === 'string')
      .find((row) =>
        row
          .findAllByProps({ 'data-object-side': 'source' })
          .some((input) => input.props.value === 'orders'),
      )!;
    act(() =>
      orderRow
        .findAllByType('button')
        .find((button) => button.children.includes('删除'))!
        .props.onClick(),
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
    ).toEqual(['customers_archive']);
    expect(
      renderer.root
        .findAllByProps({ 'data-object-side': 'source' })
        .some((input) => input.props.value === 'orders'),
    ).toBe(false);
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
    const editExceptions = buttonWithText(renderer, '编辑例外');
    expect(editExceptions.props['aria-expanded']).toBe(false);
    act(() => editExceptions.props.onClick());
    expect(buttonWithText(renderer, '需要确认同步字段')).toBeTruthy();
  });

  it('keeps a second selection disabled until the active field probe finishes', async () => {
    const draft = createDataSyncTaskDraft({
      id: 'overlapping-probe-task',
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
    const alphaFields = deferred<DataSyncFieldMetadata[]>();
    const betaFields = deferred<DataSyncFieldMetadata[]>();
    const names = ['alpha', 'beta'];
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
      capabilities: {
        [task.id]: {
          level: 'full',
          canExecute: true,
          supportsAutoCreate: true,
          supportsCdc: false,
        },
      },
    });
    const gateway: DataSyncWorkbenchGateway = {
      ...baseGateway,
      listFields: (endpoint, objectName) => {
        if (endpoint.connectionId !== 'source') {
          return baseGateway.listFields(endpoint, objectName);
        }
        return objectName === 'alpha' ? alphaFields.promise : betaFields.promise;
      },
    };
    const renderer = TestRenderer.create(
      <DataSyncWorkbenchShell initialTasks={[task]} gateway={gateway} locale="zh-CN" />,
    );
    await flush();
    act(() => buttonWithText(renderer, '选择同步数据').props.onClick());
    await flush();

    const selectObject = async (name: string) => {
      act(() => sourceObjectAction(renderer).props.onClick());
      act(() =>
        renderer.root
          .findByProps({ 'data-object-name': name })
          .findByType('input')
          .props.onChange({ target: { checked: true } }),
      );
      act(() => buttonWithText(renderer, '添加 1 个对象').props.onClick());
      await flush();
    };
    await selectObject('alpha');
    expect(buttonWithText(renderer, '添加源对象').props.disabled).toBe(true);

    const detectedFields: DataSyncFieldMetadata[] = [
      { name: 'id', type: 'bigint', nullable: false, ordinal: 1, key: true },
    ];
    await act(async () => {
      alphaFields.resolve(detectedFields);
      await alphaFields.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(buttonWithText(renderer, '添加源对象').props.disabled).toBe(false);

    await selectObject('beta');
    await act(async () => {
      betaFields.resolve(detectedFields);
      await betaFields.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    const rows = renderer.root.findAll(
      (node) => typeof node.props['data-mapping-id'] === 'string',
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.props['data-ready'] === 'true')).toBe(true);
  });
});
