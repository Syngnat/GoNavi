import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number { return this.data.size; }
  clear(): void { this.data.clear(); }
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.data.keys())[index] ?? null; }
  removeItem(key: string): void { this.data.delete(key); }
  setItem(key: string, value: string): void { this.data.set(key, String(value)); }
}

const importStore = async () => {
  const store = await import('./store');
  await store.useStore.persist.rehydrate();
  return store;
};

describe('connection sidebar manual order', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('renders a root connection drag in the requested order', async () => {
    const { buildSidebarRootConnectionToken, useStore } = await importStore();
    const { buildSidebarConnectionTagTree } = await import('./components/sidebarV2Utils');
    useStore.getState().replaceConnections([
      { id: 'old', name: 'Old', createdAt: 1, config: { id: 'old', type: 'mysql', host: 'old', port: 3306, user: 'root' } },
      { id: 'new', name: 'New', createdAt: 2, config: { id: 'new', type: 'mysql', host: 'new', port: 3306, user: 'root' } },
    ]);

    useStore.getState().moveConnectionToTag('old', null, buildSidebarRootConnectionToken('new'), true);

    const state = useStore.getState();
    expect(state.rootConnectionSortMode).toBe('manual');
    expect(buildSidebarConnectionTagTree(
      state.connections,
      state.connectionTags,
      state.sidebarRootOrder,
      state.rootSortMode,
      state.rootConnectionSortMode,
    ).map((item) => item.id)).toEqual(['old', 'new']);

    useStore.getState().moveConnectionToTag('new', null, buildSidebarRootConnectionToken('old'), true);
    const movedAgain = useStore.getState();
    expect(buildSidebarConnectionTagTree(
      movedAgain.connections,
      movedAgain.connectionTags,
      movedAgain.sidebarRootOrder,
      movedAgain.rootSortMode,
      movedAgain.rootConnectionSortMode,
    ).map((item) => item.id)).toEqual(['new', 'old']);
  }, 30_000);

  it('materializes the visible automatic order before moving one of three connections', async () => {
    const { buildSidebarRootConnectionToken, useStore } = await importStore();
    const { buildSidebarConnectionTagTree } = await import('./components/sidebarV2Utils');
    useStore.getState().replaceConnections([
      { id: 'c', name: 'Charlie', config: { id: 'c', type: 'mysql', host: 'c', port: 3306, user: 'root' } },
      { id: 'b', name: 'Bravo', config: { id: 'b', type: 'mysql', host: 'b', port: 3306, user: 'root' } },
      { id: 'a', name: 'Alpha', config: { id: 'a', type: 'mysql', host: 'a', port: 3306, user: 'root' } },
    ]);
    useStore.getState().setConnectionDisplaySortMode(null, 'name');

    useStore.getState().moveConnectionToTag(
      'c',
      null,
      buildSidebarRootConnectionToken('b'),
      true,
    );

    const state = useStore.getState();
    expect(state.rootConnectionSortMode).toBe('manual');
    expect(buildSidebarConnectionTagTree(
      state.connections,
      state.connectionTags,
      state.sidebarRootOrder,
      state.rootSortMode,
      state.rootConnectionSortMode,
    ).map((item) => item.id)).toEqual(['a', 'c', 'b']);
  }, 30_000);

  it('keeps group order mode while a grouped connection drag switches only connection order', async () => {
    const { buildSidebarRootConnectionToken, useStore } = await importStore();
    const { buildSidebarConnectionTagTree } = await import('./components/sidebarV2Utils');
    useStore.getState().replaceConnections([
      { id: 'a', name: 'A', config: { id: 'a', type: 'mysql', host: 'a', port: 3306, user: 'root' } },
      { id: 'z', name: 'Z', config: { id: 'z', type: 'mysql', host: 'z', port: 3306, user: 'root' } },
    ]);
    useStore.getState().addConnectionTag({
      id: 'group',
      name: 'Group',
      connectionIds: ['a', 'z'],
    });
    useStore.getState().setConnectionDisplaySortMode('group', 'name');

    useStore.getState().moveConnectionToTag('z', 'group', buildSidebarRootConnectionToken('a'), true);

    const state = useStore.getState();
    const tag = state.connectionTags.find((item) => item.id === 'group')!;
    expect(tag.sortMode).toBe('manual');
    expect(tag.connectionSortMode).toBe('manual');
    const group = buildSidebarConnectionTagTree(
      state.connections,
      state.connectionTags,
      state.sidebarRootOrder,
      state.rootSortMode,
      state.rootConnectionSortMode,
    )[0];
    expect(group.kind === 'tag' ? group.children.map((item) => item.id) : []).toEqual(['z', 'a']);

    useStore.getState().moveConnectionToTag('a', 'group', buildSidebarRootConnectionToken('z'), true);
    const movedAgain = useStore.getState();
    const groupAfterSecondMove = buildSidebarConnectionTagTree(
      movedAgain.connections,
      movedAgain.connectionTags,
      movedAgain.sidebarRootOrder,
      movedAgain.rootSortMode,
      movedAgain.rootConnectionSortMode,
    )[0];
    expect(groupAfterSecondMove.kind === 'tag'
      ? groupAfterSecondMove.children.map((item) => item.id)
      : []).toEqual(['a', 'z']);
  }, 30_000);

  it('keeps existing import order and appends moved and new connections last', async () => {
    const { useStore } = await importStore();
    const { buildSidebarConnectionTagTree } = await import('./components/sidebarV2Utils');
    useStore.getState().replaceConnections([
      { id: 'target-z', name: 'Z', config: { id: 'target-z', type: 'mysql', host: 'z', port: 3306, user: 'root' } },
      { id: 'target-a', name: 'A', config: { id: 'target-a', type: 'mysql', host: 'a', port: 3306, user: 'root' } },
      { id: 'existing', name: 'Existing', config: { id: 'existing', type: 'mysql', host: 'e', port: 3306, user: 'root' } },
    ]);
    useStore.getState().addConnectionTag({ id: 'target', name: 'Target', connectionIds: ['target-z', 'target-a'] });
    useStore.getState().addConnectionTag({ id: 'other', name: 'Other', connectionIds: ['existing'] });
    useStore.getState().setConnectionDisplaySortMode('target', 'name');
    useStore.getState().setConnectionDisplaySortMode('target', 'manual');
    useStore.getState().replaceConnections([
      ...useStore.getState().connections,
      { id: 'new', name: 'New', config: { id: 'new', type: 'mysql', host: 'new', port: 3306, user: 'root' } },
    ]);
    useStore.getState().moveConnectionsToTag(['existing', 'new'], 'target');

    const state = useStore.getState();
    const target = buildSidebarConnectionTagTree(
      state.connections,
      state.connectionTags,
      state.sidebarRootOrder,
      state.rootSortMode,
      state.rootConnectionSortMode,
    ).find((item) => item.id === 'target');
    expect(target?.kind === 'tag' ? target.children.map((item) => item.id) : []).toEqual([
      'target-a',
      'target-z',
      'existing',
      'new',
    ]);
  }, 30_000);

  it('keeps the visible root order and appends a newly imported connection last', async () => {
    const { useStore } = await importStore();
    const { buildSidebarConnectionTagTree } = await import('./components/sidebarV2Utils');
    useStore.getState().replaceConnections([
      { id: 'old', name: 'Old', createdAt: 1, config: { id: 'old', type: 'mysql', host: 'old', port: 3306, user: 'root' } },
      { id: 'newer', name: 'Newer', createdAt: 2, config: { id: 'newer', type: 'mysql', host: 'newer', port: 3306, user: 'root' } },
    ]);
    useStore.getState().setConnectionDisplaySortMode(null, 'manual');
    useStore.getState().replaceConnections([
      ...useStore.getState().connections,
      { id: 'imported', name: 'Imported', createdAt: 3, config: { id: 'imported', type: 'mysql', host: 'imported', port: 3306, user: 'root' } },
    ]);

    const state = useStore.getState();
    expect(buildSidebarConnectionTagTree(
      state.connections,
      state.connectionTags,
      state.sidebarRootOrder,
      state.rootSortMode,
      state.rootConnectionSortMode,
    ).map((item) => item.id)).toEqual(['newer', 'old', 'imported']);
  }, 30_000);

  it('keeps an existing grouped connection in place when import updates sortable fields', async () => {
    const { useStore } = await importStore();
    const { buildSidebarConnectionTagTree } = await import('./components/sidebarV2Utils');
    const { resolveConnectionImportPlacement } = await import('./components/settings/ConnectionImportSettingsPanel');
    useStore.getState().replaceConnections([
      { id: 'z', name: 'Zulu', createdAt: 1, config: { id: 'z', type: 'mysql', host: 'z', port: 3306, user: 'root' } },
      { id: 'a', name: 'Alpha', createdAt: 2, config: { id: 'a', type: 'mysql', host: 'a', port: 3306, user: 'root' } },
    ]);
    useStore.getState().addConnectionTag({ id: 'group', name: 'Group', connectionIds: ['z', 'a'] });
    useStore.getState().setConnectionDisplaySortMode('group', 'name');

    const beforeImport = useStore.getState();
    const placement = resolveConnectionImportPlacement(['z'], '', beforeImport.connectionTags);
    placement.manualOrderTargetGroupIds.forEach((groupID) => {
      useStore.getState().setConnectionDisplaySortMode(groupID, 'manual');
    });
    useStore.getState().replaceConnections(beforeImport.connections.map((connection) => (
      connection.id === 'z'
        ? { ...connection, name: 'Aardvark', createdAt: 3 }
        : connection
    )));

    const state = useStore.getState();
    const group = buildSidebarConnectionTagTree(
      state.connections,
      state.connectionTags,
      state.sidebarRootOrder,
      state.rootSortMode,
      state.rootConnectionSortMode,
    ).find((item) => item.id === 'group');
    expect(group?.kind === 'tag' ? group.children.map((item) => item.id) : []).toEqual(['a', 'z']);
  }, 30_000);
});
