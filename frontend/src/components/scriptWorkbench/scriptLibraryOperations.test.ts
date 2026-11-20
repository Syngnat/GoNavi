import { describe, expect, it, vi } from 'vitest';
import type { ScriptWorkbenchAdapter } from './scriptWorkbenchTypes';
import { createLibraryFolder, createLibraryScript } from './scriptLibraryOperations';

describe('script library operations', () => {
  it('creates a runnable starter script instead of an empty source that the backend rejects', async () => {
    const saveScript = vi.fn(async (input) => ({
      id: 'script-1',
      ...input,
      owner: 'local',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    }));
    const adapter = { saveScript } as unknown as ScriptWorkbenchAdapter;
    await createLibraryScript({
      adapter,
      name: 'daily audit',
      visibility: 'private',
      folderId: 'folder-1',
    });
    expect(saveScript).toHaveBeenCalledWith(expect.objectContaining({
      name: 'daily audit',
      code: expect.stringContaining('gonavi.db.query'),
      visibility: 'private',
      folderId: 'folder-1',
      revision: 0,
    }));
  });

  it('keeps the selected folder as the parent when creating a folder', async () => {
    const saveFolder = vi.fn(async (input) => ({
      id: 'folder-2',
      ...input,
      owner: 'local',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    }));
    const adapter = { saveFolder } as unknown as ScriptWorkbenchAdapter;

    await createLibraryFolder({
      adapter,
      name: 'child',
      visibility: 'private',
      parentId: 'folder-1',
    });
    expect(saveFolder).toHaveBeenCalledWith(expect.objectContaining({
      name: 'child',
      parentId: 'folder-1',
    }));
  });
});
