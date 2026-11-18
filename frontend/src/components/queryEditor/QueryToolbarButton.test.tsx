import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { QueryToolbarButton } from './QueryToolbarButton';

vi.mock('antd', () => ({
  Button: React.forwardRef<HTMLButtonElement, Record<string, unknown>>((props, ref) => (
    <button
      ref={ref}
      type="button"
      disabled={Boolean(props.disabled)}
      onClick={props.onClick as React.MouseEventHandler<HTMLButtonElement>}
      onPointerUp={props.onPointerUp as React.PointerEventHandler<HTMLButtonElement>}
    >
      {props.children as React.ReactNode}
    </button>
  )),
}));

describe('QueryToolbarButton', () => {
  it('runs once when pointerup is followed by click', () => {
    const onClick = vi.fn();
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(<QueryToolbarButton onClick={onClick} />);
    });
    const button = renderer!.root.findByType('button');
    act(() => {
      button.props.onPointerUp({ button: 0 });
      button.props.onClick({ button: 0 });
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('still runs from click alone', () => {
    const onClick = vi.fn();
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(<QueryToolbarButton onClick={onClick} />);
    });
    act(() => {
      renderer!.root.findByType('button').props.onClick({ button: 0 });
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
