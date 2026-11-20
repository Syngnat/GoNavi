import { describe, expect, it } from 'vitest';
import {
  buildScriptWorkbenchTab,
  buildScriptWorkbenchTabId,
  resolveScriptWorkbenchNodeConnectionId,
} from './scriptWorkbenchTab';

describe('script workbench tabs', () => {
  it('opens a saved script by its stable identity', () => {
    expect(buildScriptWorkbenchTabId({ scriptId: 'script-7' })).toBe('script-workbench:script-7');
    expect(buildScriptWorkbenchTabId({ requestKey: 'ai-request-2' })).toBe('script-workbench:ai-request-2');
    const draftId = buildScriptWorkbenchTabId({ source: 'const value = 1;' });
    expect(draftId).toMatch(/^script-workbench:draft:/);
    expect(buildScriptWorkbenchTabId({ source: 'const value = 1;' })).toBe(draftId);
    expect(buildScriptWorkbenchTabId({})).toBe('script-workbench:new');
  });

  it('carries script metadata while leaving preview source transient', () => {
    const tab = buildScriptWorkbenchTab({
      scriptId: 'script-7',
      folderId: 'folder-2',
      visibility: 'shared',
      displayName: 'Nightly audit',
      source: 'const value = 1;',
      connectionId: 'conn-1',
      dbName: 'app',
      title: 'Script Workbench',
    });
    expect(tab).toMatchObject({
      id: 'script-workbench:script-7',
      title: 'Nightly audit',
      type: 'script-workbench',
      connectionId: 'conn-1',
      dbName: 'app',
      scriptId: 'script-7',
      scriptFolderId: 'folder-2',
      scriptVisibility: 'shared',
      scriptDisplayName: 'Nightly audit',
      scriptPreviewSource: 'const value = 1;',
      preserveUnboundConnection: true,
    });
  });

  it('prefers the saved connection reference over a node-local id', () => {
    const connections = [{ id: 'saved-connection-1' }];
    expect(resolveScriptWorkbenchNodeConnectionId({
      type: 'database',
      key: 'orders',
      dataRef: { id: 'database-node-9', connectionId: 'saved-connection-1' },
    }, connections)).toBe('saved-connection-1');
    expect(resolveScriptWorkbenchNodeConnectionId({
      type: 'connection',
      key: 'saved-connection-1',
      dataRef: { id: 'unsaved-node' },
    }, connections)).toBe('saved-connection-1');
    expect(resolveScriptWorkbenchNodeConnectionId({
      type: 'database',
      dataRef: { id: 'unsaved-node' },
    }, connections)).toBe('');
  });
});
