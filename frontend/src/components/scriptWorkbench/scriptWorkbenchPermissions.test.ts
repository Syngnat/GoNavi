import { describe, expect, it } from 'vitest';
import {
  canEditFolderItem,
  canEditScriptItem,
  canShareScriptItem,
} from './scriptWorkbenchPermissions';
import type {
  ScriptLibraryFolder,
  ScriptLibraryScript,
  ScriptLibrarySnapshot,
} from './scriptWorkbenchTypes';

const snapshot: ScriptLibrarySnapshot = {
  owner: 'local',
  scripts: [],
  folders: [],
  canWrite: true,
  canShare: true,
  sharedOnly: false,
};

const script = (overrides: Partial<ScriptLibraryScript>): ScriptLibraryScript => ({
  id: 'script-1',
  name: 'Script',
  description: '',
  code: '',
  owner: 'someone-else',
  visibility: 'shared',
  connections: [],
  inputs: [],
  allowWrite: false,
  batchSize: 500,
  inListLimit: 1_000,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const folder = (overrides: Partial<ScriptLibraryFolder>): ScriptLibraryFolder => ({
  id: 'folder-1',
  name: 'Folder',
  owner: 'someone-else',
  visibility: 'shared',
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe('script workbench item permissions', () => {
  it('prefers backend canEdit/canShare over owner string fallback', () => {
    expect(canEditScriptItem(snapshot, script({ canEdit: true }))).toBe(true);
    expect(canEditScriptItem(snapshot, script({ canEdit: false }))).toBe(false);
    expect(canShareScriptItem(snapshot, script({ canEdit: true, canShare: false }))).toBe(false);
    expect(canShareScriptItem(snapshot, script({ canEdit: true, canShare: true }))).toBe(true);
  });

  it('does not grant owner fallback when the owner principal is empty', () => {
    expect(canEditScriptItem({ ...snapshot, owner: '' }, script({ owner: '' }))).toBe(false);
    expect(canEditFolderItem({ ...snapshot, owner: '' }, folder({ owner: '' }))).toBe(false);
  });
});
