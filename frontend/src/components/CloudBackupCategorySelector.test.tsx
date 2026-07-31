import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import CloudBackupCategorySelector, { CLOUD_BACKUP_CATEGORY_IDS } from './CloudBackupCategorySelector';

vi.mock('antd', () => {
  const Checkbox: any = ({ children, value }: any) => <label data-value={value}>{children}</label>;
  Checkbox.Group = ({ children }: any) => <div>{children}</div>;
  return {
    Button: ({ children, disabled, onClick }: any) => (
      <button type="button" disabled={disabled} onClick={onClick}>{children}</button>
    ),
    Checkbox,
    Space: ({ children }: any) => <div>{children}</div>,
    Typography: {
      Text: ({ children }: any) => <span>{children}</span>,
    },
  };
});

describe('CloudBackupCategorySelector', () => {
  it('supports selecting every category and clearing the selection', async () => {
    const onChange = vi.fn();
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <CloudBackupCategorySelector
          categories={CLOUD_BACKUP_CATEGORY_IDS.map((id) => ({ id }))}
          selected={['connections']}
          title="Backup content"
          t={(key) => key}
          onChange={onChange}
        />,
      );
    });

    const buttons = renderer!.root.findAllByType('button');
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[0].props.onClick());
    expect(onChange).toHaveBeenLastCalledWith([...CLOUD_BACKUP_CATEGORY_IDS]);

    await act(async () => buttons[1].props.onClick());
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
