import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('./api', () => ({ pluginAPI: api }));
import { usePluginConnectionActions } from './usePluginConnectionActions';
import type { PluginConnectionActionEntry } from './connectionActions';
import { PLUGIN_LIFECYCLE_EVENT } from './events';

const listeners = new Map<string, Set<() => void>>();
const status = (id: string, actionId: string) => ({
  manifest: { id, name: id, contributes: { connectionActions: [{ id: actionId, title: actionId, connectionTypes: ['mongodb'], scopes: ['connection'], target: { type: 'window' } }] } },
  state: 'running', desiredEnabled: true,
});
let actions: PluginConnectionActionEntry[] = [];
function Harness() { actions = usePluginConnectionActions().actions; return null; }

beforeEach(() => {
  api.list.mockReset();
  listeners.clear();
  vi.stubGlobal('window', {
    addEventListener: (type: string, listener: () => void) => { const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set); },
    removeEventListener: (type: string, listener: () => void) => { listeners.get(type)?.delete(listener); },
    dispatchEvent: (event: Event) => { listeners.get(event.type)?.forEach((listener) => listener()); return true; },
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('plugin connection action refresh', () => {
  it('replays lifecycle changes received while the initial list is loading', async () => {
    let finish: (value: unknown[]) => void = () => {};
    api.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    api.list.mockResolvedValueOnce([status('com.example.new', 'open')]);
    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => { renderer = create(<Harness />); });
    await act(async () => {
      window.dispatchEvent(new Event(PLUGIN_LIFECYCLE_EVENT));
      window.dispatchEvent(new Event(PLUGIN_LIFECYCLE_EVENT));
      finish([]);
    });
    expect(actions.map((entry) => entry.pluginID)).toEqual(['com.example.new']);
    expect(api.list).toHaveBeenCalledTimes(2);
    act(() => renderer!.unmount());
  });
  it('never publishes a stale list after a lifecycle event requested a newer snapshot', async () => {
    let finishOld: (value: unknown[]) => void = () => {};
    let finishNew: (value: unknown[]) => void = () => {};
    api.list.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    api.list.mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => { renderer = create(<Harness />); });
    await act(async () => { window.dispatchEvent(new Event(PLUGIN_LIFECYCLE_EVENT)); finishOld([status('stale', 'old')]); });
    expect(actions).toEqual([]);
    await act(async () => { finishNew([status('fresh', 'new')]); });
    expect(actions.map((entry) => entry.pluginID)).toEqual(['fresh']);
    act(() => renderer!.unmount());
  });
  it('reloads after a plugin lifecycle change without a window focus event', async () => {
    api.list.mockResolvedValueOnce([status('com.example.one', 'open')]);
    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => { renderer = create(<Harness />); });
    expect(actions.map((entry) => entry.pluginID)).toEqual(['com.example.one']);
    api.list.mockResolvedValueOnce([status('com.example.one', 'open'), status('com.example.two', 'run')]);
    await act(async () => { window.dispatchEvent(new Event(PLUGIN_LIFECYCLE_EVENT)); await Promise.resolve(); });
    expect(actions.map((entry) => entry.pluginID)).toEqual(['com.example.one', 'com.example.two']);
    act(() => renderer!.unmount());
  });
});
