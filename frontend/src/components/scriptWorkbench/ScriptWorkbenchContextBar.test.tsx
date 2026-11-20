/** @vitest-environment jsdom */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ScriptWorkbenchContextBar } from './ScriptWorkbenchContextBar';

describe('ScriptWorkbenchContextBar', () => {
  it('renders and removes every input binding, not only the first one', async () => {
    const onRemoveInput = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ScriptWorkbenchContextBar
          connections={[]}
          bindings={[]}
          inputs={[
            { alias: 'orders', name: 'orders.xlsx', sheetName: 'Sheet1' },
            { alias: 'customers', name: 'customers.xlsx', sheetName: 'Sheet1' },
          ]}
          t={(key) => key}
          onChooseInput={vi.fn()}
          onRemoveInput={onRemoveInput}
        />,
      );
    });

    const removeButtons = renderer.root.findAll((node) => (
      node.type === 'button'
      && node.props['aria-label'] === 'script_workbench.action.remove_file'
    ));
    expect(removeButtons).toHaveLength(2);
    act(() => removeButtons[1].props.onClick());
    expect(onRemoveInput).toHaveBeenCalledWith(1);
    act(() => renderer.unmount());
  });
});
