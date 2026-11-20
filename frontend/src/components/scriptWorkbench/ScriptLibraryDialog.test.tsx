/** @vitest-environment jsdom */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ScriptLibraryDialog } from './ScriptLibraryDialog';
import {
  ScriptLibraryFolderRow,
  ScriptLibraryScriptRow,
} from './ScriptLibraryRows';
import type {
  ScriptLibraryFolder,
  ScriptLibraryScript,
  ScriptLibrarySnapshot,
  ScriptWorkbenchAdapter,
} from './scriptWorkbenchTypes';

const folder: ScriptLibraryFolder = {
  id: 'folder-1',
  name: 'Reports',
  parentId: 'folder-parent',
  owner: 'local',
  visibility: 'private',
  revision: 1,
  canEdit: true,
  canShare: true,
  createdAt: 1,
  updatedAt: 1,
};

const snapshot: ScriptLibrarySnapshot = {
  owner: 'local',
  scripts: [],
  folders: [folder],
  canWrite: true,
  canShare: true,
  sharedOnly: false,
};

const script: ScriptLibraryScript = {
  id: 'script-1',
  name: 'Reports',
  description: '',
  code: 'gonavi.log("x");',
  owner: 'local',
  visibility: 'private',
  connections: [],
  inputs: [],
  allowWrite: false,
  batchSize: 500,
  inListLimit: 1_000,
  revision: 2,
  createdAt: 1,
  updatedAt: 1,
};

describe('ScriptLibraryDialog folder operations', () => {
  it('renames a folder with its current revision and parent', async () => {
    const saveFolder = vi.fn(async (input) => ({
      ...folder,
      ...input,
      revision: 2,
    }));
    const adapter = { saveFolder } as unknown as ScriptWorkbenchAdapter;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ScriptLibraryDialog
          open={false}
          snapshot={snapshot}
          loading={false}
          error=""
          adapter={adapter}
          t={(key) => key}
          onClose={vi.fn()}
          refresh={vi.fn(async () => snapshot)}
          onOpenScript={vi.fn()}
          onScriptDeleted={vi.fn()}
        />,
      );
    });

    act(() => renderer.root.findByType(ScriptLibraryFolderRow).props.onStartRename());
    act(() => {
      renderer.root.findByProps({ 'aria-label': 'script_workbench.library.folder_name' })
        .props.onKeyDown({ key: 'Escape' });
    });
    expect(saveFolder).not.toHaveBeenCalled();
    act(() => renderer.root.findByType(ScriptLibraryFolderRow).props.onStartRename());
    act(() => {
      renderer.root.findByProps({ 'aria-label': 'script_workbench.library.folder_name' })
        .props.onChange({ target: { value: 'Renamed reports' } });
    });
    await act(async () => {
      renderer.root.findByType(ScriptLibraryFolderRow).props.onFinishRename();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveFolder).toHaveBeenCalledWith({
      id: 'folder-1',
      name: 'Renamed reports',
      parentId: 'folder-parent',
      visibility: 'private',
      revision: 1,
    });
    act(() => renderer.unmount());
  });

  it('resolves and saves the current script before deleting it', async () => {
    const deleteScript = vi.fn(async () => undefined);
    const resolveScriptBeforeMutation = vi.fn(async () => ({
      script: { ...script, revision: 3 },
      draftInstanceId: 'draft:current',
    }));
    const onScriptDeleted = vi.fn();
    const adapter = { deleteScript } as unknown as ScriptWorkbenchAdapter;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ScriptLibraryDialog
          open={false}
          snapshot={{ ...snapshot, scripts: [script] }}
          loading={false}
          error=""
          currentScriptId="script-1"
          adapter={adapter}
          t={(key) => key}
          onClose={vi.fn()}
          refresh={vi.fn(async () => snapshot)}
          onOpenScript={vi.fn()}
          resolveScriptBeforeMutation={resolveScriptBeforeMutation}
          onScriptDeleted={onScriptDeleted}
        />,
      );
    });

    act(() => renderer.root.findByType(ScriptLibraryScriptRow).props.onDelete());
    await act(async () => {
      renderer.root.findByProps({ testId: 'script-library-delete-dialog' })
        .props.onResolve(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolveScriptBeforeMutation).toHaveBeenCalledTimes(1);
    expect(deleteScript).toHaveBeenCalledWith({ id: 'script-1', revision: 3 });
    expect(onScriptDeleted).toHaveBeenCalledWith('script-1');
    act(() => renderer.unmount());
  });

  it('shows a permission-specific message and retry for a failed load', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ScriptLibraryDialog
          open={false}
          snapshot={null}
          loading={false}
          error="forbidden"
          errorCode="forbidden"
          adapter={{} as ScriptWorkbenchAdapter}
          t={(key) => key}
          onClose={vi.fn()}
          refresh={vi.fn(async () => null)}
          onOpenScript={vi.fn()}
          onScriptDeleted={vi.fn()}
        />,
      );
    });

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('script_workbench.library.no_permission');
    expect(text).toContain('script_workbench.library.retry');
    act(() => renderer.unmount());
  });
});
