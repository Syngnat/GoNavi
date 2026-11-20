/** @vitest-environment jsdom */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabData } from '../../types';
import { useStore } from '../../store';
import type {
  ScriptDraft,
  ScriptDraftSnapshot,
  ScriptLibraryScript,
  ScriptWorkbenchAdapter,
} from './scriptWorkbenchTypes';
import { useScriptWorkbenchPersistence } from './useScriptWorkbenchPersistence';

const tab: TabData = {
  id: 'script-workbench:script-1',
  title: 'Nightly',
  type: 'script-workbench',
  connectionId: '',
  scriptId: 'script-1',
};

const draft: ScriptDraft = {
  draftInstanceId: 'draft:test-persistence',
  id: 'script-1',
  name: 'Nightly',
  description: 'Keeps description',
  source: 'gonavi.log("new source");',
  visibility: 'private',
  revision: 1,
  connections: [],
  inputs: [],
  allowWrite: false,
  batchSize: 500,
  inListLimit: 1_000,
};

const saved: ScriptLibraryScript = {
  id: 'script-1',
  name: 'Nightly',
  description: '',
  code: draft.source,
  owner: 'local',
  visibility: 'private',
  connections: [],
  inputs: [],
  allowWrite: false,
  batchSize: 500,
  inListLimit: 1_000,
  revision: 2,
  createdAt: 1,
  updatedAt: 2,
};

describe('useScriptWorkbenchPersistence', () => {
  beforeEach(() => {
    useStore.setState({
      tabs: [tab, { ...tab, id: 'script-workbench:other', title: 'Other script' }],
      activeTabId: 'script-workbench:other',
    });
  });

  it('saves a dirty draft before toggling its visibility', async () => {
    const order: string[] = [];
    const adapter = {
      saveScript: vi.fn(async () => {
        order.push('save');
        return saved;
      }),
      shareScript: vi.fn(async () => {
        order.push('share');
        return { ...saved, visibility: 'shared' as const, revision: 3 };
      }),
    } as unknown as ScriptWorkbenchAdapter;
    let snapshot: ScriptDraftSnapshot = {
      draft,
      epoch: 1,
      dirty: true,
    };
    const applySavedIfCurrent = vi.fn((next: ScriptLibraryScript, expectedEpoch: number) => {
      if (snapshot.epoch !== expectedEpoch) return false;
      snapshot = {
        draft: { ...snapshot.draft, revision: next.revision, visibility: next.visibility },
        epoch: snapshot.epoch + 1,
        dirty: false,
      };
      return true;
    });
    let api!: ReturnType<typeof useScriptWorkbenchPersistence>;
    const Probe: React.FC = () => {
      api = useScriptWorkbenchPersistence({
        adapter,
        tab,
        t: (key) => key,
        getSnapshot: () => snapshot,
        applySavedIfCurrent,
        mergeServerMetadata: vi.fn(),
        refreshLibrary: vi.fn(async () => undefined),
      });
      return null;
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Probe />);
    });

    await act(async () => {
      await api.share();
    });

    expect(order).toEqual(['save', 'share']);
    expect(adapter.saveScript).toHaveBeenCalledWith(expect.objectContaining({
      id: 'script-1',
      code: 'gonavi.log("new source");',
      description: 'Keeps description',
      revision: 1,
    }));
    expect(adapter.shareScript).toHaveBeenCalledWith({
      id: 'script-1',
      revision: 2,
      visibility: 'shared',
    });
    expect(useStore.getState().activeTabId).toBe('script-workbench:other');
    expect(useStore.getState().tabs.find((candidate) => candidate.id === tab.id)).toMatchObject({
      scriptId: 'script-1',
      scriptVisibility: 'shared',
    });
    act(() => renderer.unmount());
  });

  it('keeps editing while a save is in flight and commits the latest source', async () => {
    let snapshot: ScriptDraftSnapshot = {
      draft: {
        ...draft,
        id: undefined,
        revision: 0,
        source: 'gonavi.log("first");',
      },
      epoch: 1,
      dirty: true,
    };
    const savedSources: string[] = [];
    const adapter = {
      saveScript: vi.fn(async (input: { code: string }) => {
        savedSources.push(input.code);
        if (savedSources.length === 1) {
          snapshot = {
            ...snapshot,
            draft: { ...snapshot.draft, source: 'gonavi.log("second");' },
            epoch: snapshot.epoch + 1,
          };
          return {
            ...saved,
            id: 'script-1',
            revision: 1,
            code: input.code,
          };
        }
        return {
          ...saved,
          id: 'script-1',
          revision: 2,
          code: input.code,
        };
      }),
    } as unknown as ScriptWorkbenchAdapter;
    const applySavedIfCurrent = vi.fn((next: ScriptLibraryScript, expectedEpoch: number) => {
      if (snapshot.epoch !== expectedEpoch) return false;
      snapshot = {
        draft: {
          ...snapshot.draft,
          id: next.id,
          revision: next.revision,
          source: next.code,
        },
        epoch: snapshot.epoch + 1,
        dirty: false,
      };
      return true;
    });
    const mergeServerMetadata = vi.fn((next: ScriptLibraryScript) => {
      snapshot = {
        ...snapshot,
        draft: {
          ...snapshot.draft,
          id: next.id,
          revision: next.revision,
        },
        epoch: snapshot.epoch + 1,
      };
    });
    let api!: ReturnType<typeof useScriptWorkbenchPersistence>;
    const Probe: React.FC = () => {
      api = useScriptWorkbenchPersistence({
        adapter,
        tab,
        t: (key) => key,
        getSnapshot: () => snapshot,
        applySavedIfCurrent,
        mergeServerMetadata,
        refreshLibrary: vi.fn(async () => undefined),
      });
      return null;
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Probe />);
    });

    await act(async () => {
      await api.save();
    });

    expect(savedSources).toEqual([
      'gonavi.log("first");',
      'gonavi.log("second");',
    ]);
    expect(snapshot.draft.source).toBe('gonavi.log("second");');
    expect(snapshot.draft.revision).toBe(2);
    expect(snapshot.dirty).toBe(false);
    act(() => renderer.unmount());
  });

  it('refuses to sync a library script into a replaced draft instance', async () => {
    const snapshot: ScriptDraftSnapshot = {
      draft,
      epoch: 1,
      dirty: false,
    };
    let api!: ReturnType<typeof useScriptWorkbenchPersistence>;
    const Probe: React.FC = () => {
      api = useScriptWorkbenchPersistence({
        adapter: {} as ScriptWorkbenchAdapter,
        tab,
        t: (key) => key,
        getSnapshot: () => snapshot,
        applySavedIfCurrent: vi.fn(),
        mergeServerMetadata: vi.fn(),
        refreshLibrary: vi.fn(async () => undefined),
      });
      return null;
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Probe />);
    });

    expect(api.syncLibraryScript({
      ...saved,
      name: 'Wrong instance',
    }, 'draft:other')).toBe(false);
    expect(api.syncLibraryScript({
      ...saved,
      name: 'Correct instance',
    }, draft.draftInstanceId)).toBe(true);
    expect(useStore.getState().tabs.find((candidate) => candidate.id === tab.id)?.title)
      .toBe('Correct instance');
    act(() => renderer.unmount());
  });
});
