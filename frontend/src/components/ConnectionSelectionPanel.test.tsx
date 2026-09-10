import React from 'react';
import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import ConnectionSelectionPanel from './ConnectionSelectionPanel';

vi.mock('../i18n', () => ({
  t: (key: string, params: Record<string, unknown> = {}) => {
    const catalog: Record<string, string> = {
      'app.connection_package.dialog.export_connections_summary': '已选 {{selected}} / {{total}} 个连接',
      'connection_health.selection.all': '全部连接（{{count}} 个）',
      'connection_health.selection.group': '连接组：{{name}}（{{count}} 个连接）',
      'connection_health.selection.title': '选择连接',
      'data_export.action.clear': '清空',
      'data_export.action.select_all': '全选',
    };
    let value = catalog[key] || key;
    Object.entries(params).forEach(([name, replacement]) => {
      value = value.split(`{{${name}}}`).join(String(replacement));
    });
    return value;
  },
}));

vi.mock('antd', () => ({
  Button: ({ children, onClick, disabled }: any) => <button disabled={disabled} onClick={onClick}>{children}</button>,
  Checkbox: ({ checked, onChange, disabled }: any) => (
    <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
  ),
}));

describe('ConnectionSelectionPanel', () => {
  it('renders grouped chips and a compact connection grid instead of a tag select', () => {
    const onChange = vi.fn();
    const renderer = create(
      <ConnectionSelectionPanel
        connections={[
          { id: 'one', name: 'Primary', type: 'mysql' },
          { id: 'two', name: 'Replica', type: 'postgres' },
        ]}
        groups={[{ id: 'prod', name: '生产', connectionIds: ['one', 'two'] }]}
        selectedIds={['one']}
        onChange={onChange}
      />,
    );

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('已选 1 / 2 个连接');
    expect(rendered).toContain('全部连接（2 个）');
    expect(rendered).toContain('生产');
    expect(rendered).toContain('mysql');
    expect(renderer.root.findAllByProps({ 'data-connection-picker-item': 'one' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-connection-selection-panel': 'true' })).toHaveLength(1);
  });

  it('selects every connection in a group chip', () => {
    const onChange = vi.fn();
    const renderer = create(
      <ConnectionSelectionPanel
        connections={[
          { id: 'one', name: 'Primary' },
          { id: 'two', name: 'Replica' },
        ]}
        groups={[{ id: 'prod', name: '生产', connectionIds: ['one', 'two'] }]}
        selectedIds={[]}
        onChange={onChange}
      />,
    );

    renderer.root.findByProps({ 'aria-label': '连接组：生产（2 个连接）' }).props.onClick();
    expect(onChange).toHaveBeenCalledWith(['one', 'two']);
  });
});
