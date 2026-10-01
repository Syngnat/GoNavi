// @vitest-environment jsdom
import React from 'react';
import { act, Simulate } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { TableDesignerCommentField } from './tableDesignerCommentField';

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('TableDesignerCommentField', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('lets Oracle-style filled comments be edited by click or double-click without a display overlay', () => {
    const onChange = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(<TableDesignerCommentField text="明细ID，主键自增" readOnly={false} onChange={onChange} />);
    });

    const input = host.querySelector<HTMLInputElement>('.table-designer-comment-field input');
    expect(input).not.toBeNull();
    expect(input?.value).toBe('明细ID，主键自增');
    expect(host.querySelector('.table-designer-comment-display')).toBeNull();

    act(() => {
      input!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(host.querySelector('.table-designer-comment-field input')).not.toBeNull();

    act(() => {
      Simulate.change(input!, { target: { value: '订单主键' } } as never);
    });
    expect(onChange).toHaveBeenCalledWith('订单主键');

    act(() => { root.unmount(); });
    host.remove();
  });

  it('keeps read-only comments as text', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(<TableDesignerCommentField text="创建时间" readOnly onChange={() => undefined} />);
    });
    expect(host.querySelector('.table-designer-comment-field input')).toBeNull();
    expect(host.textContent).toBe('创建时间');
    act(() => { root.unmount(); });
    host.remove();
  });
});
