/** @vitest-environment jsdom */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { SavedConnection, TabData } from '../../types';
import { useScriptWorkbenchDraft } from './useScriptWorkbenchDraft';
import type {
  ScriptLibraryScript,
  ScriptWorkbenchAdapter,
} from './scriptWorkbenchTypes';

const tab: TabData = {
  id: 'script-workbench:new',
  title: 'Script',
  type: 'script-workbench',
  connectionId: 'conn-1',
  dbName: 'orders',
};

const connection: SavedConnection = {
  id: 'conn-1',
  name: 'prod',
  config: {
    type: 'mysql',
    host: 'db.internal',
    port: 3306,
    user: 'reader',
    database: 'orders',
    useSSH: false,
    ssh: { host: '', port: 22, user: '' },
  },
};

const adapter = {
  getScript: vi.fn(),
} as unknown as ScriptWorkbenchAdapter;

const sharedScript: ScriptLibraryScript = {
  id: 'shared-1',
  name: 'Shared',
  description: '',
  code: 'gonavi.log("shared");',
  owner: 'other',
  visibility: 'shared',
  connections: [
    { alias: 'a', connectionId: '', database: '' },
    { alias: 'b', connectionId: '', database: '' },
  ],
  inputs: [],
  allowWrite: false,
  batchSize: 500,
  inListLimit: 1_000,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

const mountDraft = async () => {
  let api!: ReturnType<typeof useScriptWorkbenchDraft>;
  const Probe: React.FC<{ connections: SavedConnection[] }> = ({ connections }) => {
    api = useScriptWorkbenchDraft({
      adapter,
      tab,
      defaultName: 'Script',
      defaultSource: 'gonavi.log("starter");',
      connectionIds: ['conn-1'],
      connections,
      t: (key) => key,
    });
    return null;
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Probe connections={[connection]} />);
  });
  return {
    getApi: () => api,
    rerender: async () => {
      await act(async () => {
        renderer.update(<Probe connections={[{ ...connection }]} />);
      });
    },
    unmount: () => act(() => renderer.unmount()),
  };
};

describe('useScriptWorkbenchDraft context handling', () => {
  it('keeps the draft instance stable across edits/save and rotates on apply/reset', async () => {
    const hook = await mountDraft();
    const initialInstance = hook.getApi().draft.draftInstanceId;
    act(() => hook.getApi().updateSource('gonavi.log("edited");'));
    expect(hook.getApi().draft.draftInstanceId).toBe(initialInstance);

    const snapshot = hook.getApi().getSnapshot();
    act(() => {
      hook.getApi().applySavedIfCurrent({
        ...sharedScript,
        id: 'script-saved',
        visibility: 'private',
      }, snapshot.epoch, initialInstance);
    });
    expect(hook.getApi().draft.draftInstanceId).toBe(initialInstance);

    act(() => hook.getApi().resetDraft());
    const resetInstance = hook.getApi().draft.draftInstanceId;
    expect(resetInstance).not.toBe(initialInstance);
    act(() => hook.getApi().applyScript(sharedScript));
    expect(hook.getApi().draft.draftInstanceId).not.toBe(resetInstance);
    hook.unmount();
  });

  it('rejects stale save/metadata responses from another draft instance', async () => {
    const hook = await mountDraft();
    const snapshot = hook.getApi().getSnapshot();
    const originalSource = hook.getApi().draft.source;

    act(() => {
      expect(hook.getApi().applySavedIfCurrent({
        ...sharedScript,
        id: 'script-wrong',
      }, snapshot.epoch, 'draft:stale')).toBe(false);
      hook.getApi().mergeServerMetadata({
        ...sharedScript,
        id: 'script-wrong',
      }, {
        includeName: true,
        expectedDraftInstanceId: 'draft:stale',
      });
    });

    expect(hook.getApi().draft.id).toBeUndefined();
    expect(hook.getApi().draft.source).toBe(originalSource);
    hook.unmount();
  });

  it('does not re-add a connection the user explicitly removed', async () => {
    const hook = await mountDraft();
    expect(hook.getApi().draft.connections).toHaveLength(1);

    act(() => hook.getApi().updateDraft({ connections: [] }));
    const epochAfterClear = hook.getApi().getSnapshot().epoch;
    await hook.rerender();

    expect(hook.getApi().draft.connections).toHaveLength(0);
    expect(hook.getApi().getSnapshot().epoch).toBe(epochAfterClear);
    hook.unmount();
  });

  it('fills database context for shared aliases without binding them to the tab connection', async () => {
    const hook = await mountDraft();

    act(() => hook.getApi().applyScript(sharedScript));
    expect(hook.getApi().draft.connections).toEqual([
      { alias: 'a', connectionId: '', database: 'orders' },
      { alias: 'b', connectionId: '', database: 'orders' },
    ]);
    hook.unmount();
  });
});
