import { describe, expect, it, vi } from 'vitest';

import {
  buildConnectionTagParentOptions,
  buildConnectionTagSelectableConnections,
} from './sidebar/SidebarEntityModals';
import { buildSidebarLegacyNodeMenuItems } from './sidebar/sidebarLegacyNodeMenu';

describe('Sidebar nested group menu', () => {
  it('does not offer a group itself or its descendants as an editable parent', () => {
    const options = buildConnectionTagParentOptions([
      { id: 'root', name: 'Root', connectionIds: [] },
      { id: 'child', name: 'Child', parentTagId: 'root', connectionIds: [] },
      { id: 'grandchild', name: 'Grandchild', parentTagId: 'child', connectionIds: [] },
      { id: 'other', name: 'Other', connectionIds: [] },
    ], 'root');

    expect(options).toEqual([{ value: 'other', label: 'Other' }]);
  });

  it('only offers unassigned connections when creating and retains the edited group members', () => {
    const connections = [
      {
        id: 'host-current',
        name: 'Current group host',
        config: { type: 'mysql', host: 'current.local', port: 3306, user: 'root' },
      },
      {
        id: 'host-other',
        name: 'Other group host',
        config: { type: 'mysql', host: 'other.local', port: 3306, user: 'root' },
      },
      {
        id: 'host-unassigned',
        name: 'Ungrouped host',
        config: { type: 'mysql', host: 'unassigned.local', port: 3306, user: 'root' },
      },
    ];
    const connectionTags = [
      { id: 'current', name: 'Current', connectionIds: ['host-current'] },
      { id: 'other', name: 'Other', connectionIds: ['host-other'] },
    ];

    expect(
      buildConnectionTagSelectableConnections(connections, connectionTags, '')
        .map((connection) => connection.id),
    ).toEqual(['host-unassigned']);
    expect(
      buildConnectionTagSelectableConnections(connections, connectionTags, 'current')
        .map((connection) => connection.id),
    ).toEqual(['host-current', 'host-unassigned']);
    expect(
      buildConnectionTagSelectableConnections(connections.slice(0, 2), connectionTags, ''),
    ).toEqual([]);
  });

  it('preselects the clicked legacy group when creating a child group', () => {
    const createTagForm = {
      resetFields: vi.fn(),
      setFieldsValue: vi.fn(),
    };
    const setRenameViewTarget = vi.fn();
    const setIsCreateTagModalOpen = vi.fn();
    const node = {
      type: 'tag',
      title: 'Group 1',
      dataRef: {
        id: 'group-1',
        name: 'Group 1',
        parentTagId: 'root',
        connectionIds: ['host-1'],
        childOrder: ['connection:host-1'],
      },
    };
    const items = buildSidebarLegacyNodeMenuItems(node, {
      createTagForm,
      setRenameViewTarget,
      setIsCreateTagModalOpen,
      removeConnectionTag: vi.fn(),
    });
    const newChildItem = (items || []).find((item: any) => item?.key === 'new-child-tag') as any;
    const editItem = (items || []).find((item: any) => item?.key === 'edit-tag') as any;

    newChildItem.onClick();
    expect(createTagForm.resetFields).toHaveBeenCalledOnce();
    expect(createTagForm.setFieldsValue).toHaveBeenLastCalledWith({
      parentTagId: 'group-1',
      connectionIds: [],
    });
    expect(setRenameViewTarget).toHaveBeenLastCalledWith(null);
    expect(setIsCreateTagModalOpen).toHaveBeenLastCalledWith(true);

    editItem.onClick();
    expect(createTagForm.setFieldsValue).toHaveBeenLastCalledWith({
      name: 'Group 1',
      environmentType: 'local',
      parentTagId: 'root',
      connectionIds: ['host-1'],
    });
  });

  it('exposes saved query group actions from the saved-query tree', () => {
    const openSavedQueryGroupModal = vi.fn();
    const moveSavedQueryToGroup = vi.fn();
    const savedQueryGroups = [{
      id: 'group-1',
      name: 'Group 1',
      queryIds: ['query-1'],
      childOrder: ['query:query-1'],
    }];
    const context = {
      openSavedQueryGroupModal,
      deleteSavedQueryGroup: vi.fn(),
      moveSavedQueryToGroup,
      savedQueryGroups,
      connections: [],
      isSavedQueryUnmatched: () => false,
      addTab: vi.fn(),
      resolveSavedQueryDisplayName: (name: string) => name,
      deleteQuery: vi.fn(),
    };

    const rootItems = buildSidebarLegacyNodeMenuItems({ type: 'all-saved-queries' }, context) as any[];
    const newGroup = rootItems.find((item) => item?.key === 'new-saved-query-group');
    newGroup.onClick();
    expect(openSavedQueryGroupModal).toHaveBeenCalledWith(null, null);

    const groupItems = buildSidebarLegacyNodeMenuItems({
      type: 'saved-query-manual-group',
      dataRef: savedQueryGroups[0],
    }, context) as any[];
    const newSubgroup = groupItems.find((item) => item?.key === 'new-saved-query-subgroup');
    const editGroup = groupItems.find((item) => item?.key === 'edit-saved-query-group');
    newSubgroup.onClick();
    expect(openSavedQueryGroupModal).toHaveBeenLastCalledWith(null, 'group-1');
    editGroup.onClick();
    expect(openSavedQueryGroupModal).toHaveBeenLastCalledWith(savedQueryGroups[0]);

    const queryItems = buildSidebarLegacyNodeMenuItems({
      type: 'saved-query',
      dataRef: {
        id: 'query-1',
        name: 'Grouped query',
        sql: 'select 1',
        connectionId: 'conn-1',
        dbName: 'app',
        createdAt: 1,
      },
    }, context) as any[];
    const moveToGroup = queryItems.find((item) => item?.key === 'move-saved-query-to-group');
    const moveOut = queryItems.find((item) => item?.key === 'move-saved-query-to-ungrouped');
    expect(moveToGroup.children).toHaveLength(1);
    expect(moveOut).toBeDefined();
  });
});
