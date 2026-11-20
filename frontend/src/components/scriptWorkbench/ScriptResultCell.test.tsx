/** @vitest-environment jsdom */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { ScriptResultCell } from './ScriptResultCell';

const textOf = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

describe('ScriptResultCell', () => {
  it('truncates very long values and expands them on demand', async () => {
    const t = (key: string) => key;
    const value = `${'x'.repeat(2_010)}UNIQUE_TAIL`;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ScriptResultCell value={value} t={t} />);
    });

    expect(textOf(renderer)).not.toContain('UNIQUE_TAIL');
    const toggle = renderer.root.findByProps({ className: 'gn-script-result-cell-toggle' });
    expect(toggle.props['aria-expanded']).toBe(false);
    await act(async () => {
      toggle.props.onClick();
    });

    expect(textOf(renderer)).toContain('UNIQUE_TAIL');
    expect(renderer.root.findByProps({ className: 'gn-script-result-cell-toggle' }).props['aria-expanded'])
      .toBe(true);
    act(() => renderer.unmount());
  });

  it('renders undefined as an empty value rather than the NULL marker', async () => {
    const t = (key: string) => key;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ScriptResultCell value={undefined} t={t} />);
    });

    expect(textOf(renderer)).toContain('script_workbench.results.empty_value');
    expect(textOf(renderer)).not.toContain('script_workbench.results.null');
    act(() => renderer.unmount());
  });
});
