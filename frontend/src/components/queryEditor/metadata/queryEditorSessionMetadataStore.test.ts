import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../wailsjs/go/app/App', () => ({}));

import {
  QUERY_EDITOR_SESSION_METADATA_STALE_MS,
  QueryEditorSessionResource,
  buildQueryEditorSessionMetadataKey,
  buildQueryEditorSessionMetadataScope,
  type QueryEditorSessionLoadResult,
} from './queryEditorSessionMetadataStore';

const LIMITS = { maxEntries: 8, maxEntriesPerConnection: 4, maxBytes: 1024 * 1024 };
const scope = buildQueryEditorSessionMetadataScope('conn-1', 'Shop');

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('QueryEditorSessionResource', () => {
  it('keeps a loaded value for the next reader', async () => {
    const resource = new QueryEditorSessionResource<string[]>(LIMITS);
    const fetch = vi.fn(async () => ({ value: ['orders'], cacheable: true }));

    expect(resource.read('key')).toBeUndefined();
    await resource.load({ key: 'key', scope, fetch }).promise;

    expect(resource.read('key')).toEqual({ value: ['orders'], stale: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('joins a running load instead of fetching twice and hands a late joiner the progress so far', async () => {
    const resource = new QueryEditorSessionResource<string[]>(LIMITS);
    const gate = deferred<QueryEditorSessionLoadResult<string[]>>();
    let report!: (partial: string[]) => void;
    const fetch = vi.fn((onReport: (partial: string[]) => void) => {
      report = onReport;
      return gate.promise;
    });
    const firstProgress = vi.fn();
    const lateProgress = vi.fn();

    const first = resource.load({ key: 'key', scope, fetch, onProgress: firstProgress });
    report(['orders']);
    const late = resource.load({ key: 'key', scope, fetch, onProgress: lateProgress });
    report(['orders', 'customers']);
    gate.resolve({ value: ['orders', 'customers'], cacheable: true });

    await expect(first.promise).resolves.toEqual({ value: ['orders', 'customers'], cacheable: true });
    await expect(late.promise).resolves.toEqual({ value: ['orders', 'customers'], cacheable: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(firstProgress.mock.calls).toEqual([[['orders']], [['orders', 'customers']]]);
    expect(lateProgress.mock.calls).toEqual([[['orders']], [['orders', 'customers']]]);
  });

  it('does not keep a result that is only partly loaded', async () => {
    const resource = new QueryEditorSessionResource<string[]>(LIMITS);

    const result = await resource.load({
      key: 'key',
      scope,
      fetch: async () => ({ value: ['orders'], cacheable: false }),
    }).promise;

    expect(result).toEqual({ value: ['orders'], cacheable: false });
    expect(resource.read('key')).toBeUndefined();
  });

  it('stops a load nobody waits for and starts over for the next consumer', async () => {
    const resource = new QueryEditorSessionResource<string[]>(LIMITS);
    const gate = deferred<void>();
    const stopped: boolean[] = [];
    const fetch = vi.fn(async (_report: unknown, shouldStop: () => boolean) => {
      await gate.promise;
      stopped.push(shouldStop());
      return shouldStop() ? null : { value: ['orders'], cacheable: true };
    });

    const abandoned = resource.load({ key: 'key', scope, fetch });
    abandoned.release();
    const next = resource.load({ key: 'key', scope, fetch });
    gate.resolve();

    await expect(abandoned.promise).resolves.toBeNull();
    await expect(next.promise).resolves.toEqual({ value: ['orders'], cacheable: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(stopped).toEqual([true, false]);
    expect(resource.read('key')?.value).toEqual(['orders']);
  });

  it('keeps a consumer that is still waiting when another one leaves', async () => {
    const resource = new QueryEditorSessionResource<string[]>(LIMITS);
    const gate = deferred<void>();
    const fetch = vi.fn(async (_report: unknown, shouldStop: () => boolean) => {
      await gate.promise;
      return shouldStop() ? null : { value: ['orders'], cacheable: true };
    });

    const leaving = resource.load({ key: 'key', scope, fetch });
    const waiting = resource.load({ key: 'key', scope, fetch });
    leaving.release();
    gate.resolve();

    await expect(waiting.promise).resolves.toEqual({ value: ['orders'], cacheable: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('finishes a keep-alive refresh after its only consumer left', async () => {
    const resource = new QueryEditorSessionResource<string[]>(LIMITS);
    const gate = deferred<void>();
    const fetch = vi.fn(async (_report: unknown, shouldStop: () => boolean) => {
      await gate.promise;
      return shouldStop() ? null : { value: ['orders', 'customers'], cacheable: true };
    });

    const refresh = resource.load({ key: 'key', scope, fetch, keepAlive: true });
    refresh.release();
    gate.resolve();

    await expect(refresh.promise).resolves.toEqual({ value: ['orders', 'customers'], cacheable: true });
    expect(resource.read('key')?.value).toEqual(['orders', 'customers']);
  });

  it('finishes short loads even when the editor that asked is gone', async () => {
    const resource = new QueryEditorSessionResource<string[]>({ ...LIMITS, stopWhenUnused: false });
    const gate = deferred<void>();
    const fetch = vi.fn(async (_report: unknown, shouldStop: () => boolean) => {
      await gate.promise;
      return shouldStop() ? null : { value: ['public'], cacheable: true };
    });

    const load = resource.load({ key: 'key', scope, fetch });
    load.release();
    gate.resolve();
    await load.promise;

    expect(resource.read('key')?.value).toEqual(['public']);
  });

  it('drops cached values and results of loads that started before an invalidation', async () => {
    const resource = new QueryEditorSessionResource<string[]>(LIMITS);
    await resource.load({ key: 'cached', scope, fetch: async () => ({ value: ['orders'], cacheable: true }) }).promise;
    const otherScope = buildQueryEditorSessionMetadataScope('conn-1', 'audit');
    await resource.load({
      key: 'other-db',
      scope: otherScope,
      fetch: async () => ({ value: ['events'], cacheable: true }),
    }).promise;
    const gate = deferred<QueryEditorSessionLoadResult<string[]>>();
    const running = resource.load({ key: 'running', scope, fetch: () => gate.promise });

    // Database names are matched case-insensitively.
    resource.invalidate('conn-1', buildQueryEditorSessionMetadataScope('conn-1', 'SHOP').databaseKey);
    gate.resolve({ value: ['stale'], cacheable: true });
    await running.promise;

    expect(resource.read('cached')).toBeUndefined();
    expect(resource.read('running')).toBeUndefined();
    expect(resource.read('other-db')?.value).toEqual(['events']);

    resource.invalidate('conn-1');
    expect(resource.read('other-db')).toBeUndefined();
  });

  it('serves an old value and asks one reader per window to refresh it', async () => {
    let now = 1_000;
    const resource = new QueryEditorSessionResource<string[]>({ ...LIMITS, now: () => now });
    await resource.load({ key: 'key', scope, fetch: async () => ({ value: ['orders'], cacheable: true }) }).promise;

    now += QUERY_EDITOR_SESSION_METADATA_STALE_MS - 1;
    expect(resource.read('key')).toEqual({ value: ['orders'], stale: false });

    now += 1;
    expect(resource.read('key')).toEqual({ value: ['orders'], stale: true });
    expect(resource.read('key')).toEqual({ value: ['orders'], stale: false });

    await resource.load({
      key: 'key',
      scope,
      fetch: async () => ({ value: ['orders', 'customers'], cacheable: true }),
    }).promise;
    expect(resource.read('key')).toEqual({ value: ['orders', 'customers'], stale: false });
  });
});

describe('buildQueryEditorSessionMetadataKey', () => {
  it('binds entries to the connection settings they were loaded with', () => {
    const config = { type: 'postgres', host: 'db-a', port: 5432, user: 'app' };

    expect(buildQueryEditorSessionMetadataKey('conn-1', config, 'shop'))
      .toBe(buildQueryEditorSessionMetadataKey('conn-1', { ...config }, 'shop'));
    expect(buildQueryEditorSessionMetadataKey('conn-1', config, 'shop'))
      .not.toBe(buildQueryEditorSessionMetadataKey('conn-1', { ...config, host: 'db-b' }, 'shop'));
    expect(buildQueryEditorSessionMetadataKey('conn-1', config, 'shop'))
      .not.toBe(buildQueryEditorSessionMetadataKey('conn-1', config, 'audit'));
    expect(buildQueryEditorSessionMetadataKey('conn-1', config, 'shop'))
      .not.toBe(buildQueryEditorSessionMetadataKey('conn-2', config, 'shop'));
  });
});
