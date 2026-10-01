import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const selectState = vi.hoisted(() => ({ props: null as any }));

vi.mock('../../i18n/provider', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('../data-sync/DataSyncConnectionTreeSelect', async (importOriginal) => {
  const original = await importOriginal<typeof import('../data-sync/DataSyncConnectionTreeSelect')>();
  return {
    ...original,
    BrowserSafeTreeSelect: (props: any) => {
      selectState.props = props;
      return <div data-tree-select="true" />;
    },
  };
});

import { useStore } from '../../store';
import SessionConnectionSelect from './SessionConnectionSelect';

const connection = (id: string, name: string) => ({
  id,
  name,
  config: { id, type: 'mysql', host: `${id}.local`, port: 3306, user: 'root' },
}) as any;

const render = (value: string, onChange: (id: string) => void) => {
  selectState.props = null;
  act(() => {
    create(
      <SessionConnectionSelect
        connections={[connection('c1', 'Local'), connection('c2', 'Prod A'), connection('c3', 'Loose')]}
        value={value}
        onChange={onChange}
      />,
    );
  });
  return selectState.props;
};

describe('SessionConnectionSelect', () => {
  it('nests connections under their sidebar group and expands the selected group', () => {
    useStore.setState({
      connectionTags: [{ id: 'g1', name: 'Production', connectionIds: ['c2'] }],
      sidebarRootOrder: [],
    } as any);
    const props = render('c2', vi.fn());

    const group = props.treeData.find((node: any) => node.value === 'group:g1');
    expect(group.selectable).toBe(false);
    expect(group.children.map((node: any) => node.value)).toEqual(['connection:c2']);
    const rootValues = props.treeData.map((node: any) => node.value);
    expect(rootValues).toEqual(expect.arrayContaining(['connection:c1', 'connection:c3']));
    expect(props.value).toBe('connection:c2');
    expect(props.treeExpandedKeys).toEqual(['group:g1']);
  });

  it('reports a connection pick as a plain id and ignores group nodes', () => {
    const onChange = vi.fn();
    const props = render('c1', onChange);

    act(() => props.onChange('group:g1'));
    expect(onChange).not.toHaveBeenCalled();
    act(() => props.onChange('connection:missing'));
    expect(onChange).not.toHaveBeenCalled();
    act(() => props.onChange('connection:c3'));
    expect(onChange).toHaveBeenCalledWith('c3');
  });
});
