// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTableOverviewInlineRename } from './useTableOverviewInlineRename';

let container: HTMLDivElement;
let root: Root;

type Api = ReturnType<typeof useTableOverviewInlineRename>;

const Harness = ({
  apiRef, commitRename, onRenamed,
}: {
  apiRef: React.MutableRefObject<Api | null>;
  commitRename: (oldName: string, newName: string) => Promise<boolean>;
  onRenamed?: (previous: string, next: string) => void;
}) => {
  const rename = useTableOverviewInlineRename({ commitRename, onRenamed });
  apiRef.current = rename;
  return (
    <div>
      {rename.renamingTable ? (
        <span ref={rename.editorRef} data-testid="editor">
          <input
            data-testid="editor-input"
            value={rename.renameDraft}
            onChange={(event) => rename.setRenameDraft(event.target.value)}
          />
        </span>
      ) : (
        <span data-testid="static">{rename.renamingTable ?? '—'}</span>
      )}
      <div data-testid="outside">外部</div>
    </div>
  );
};

const setup = async (commitRename = vi.fn(async () => true), onRenamed?: (a: string, b: string) => void) => {
  const apiRef = React.createRef<Api>() as React.MutableRefObject<Api | null>;
  act(() => root.render(<Harness apiRef={apiRef} commitRename={commitRename} onRenamed={onRenamed} />));
  return { apiRef, commitRename };
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('useTableOverviewInlineRename', () => {
  it('进入编辑时把当前表名填进草稿', async () => {
    const { apiRef } = await setup();
    act(() => { apiRef.current!.startRename('orders'); });
    expect(apiRef.current!.renamingTable).toBe('orders');
    expect(apiRef.current!.renameDraft).toBe('orders');
    expect(container.querySelector('[data-testid="editor-input"]')).toBeTruthy();
  });

  it('提交时调用改名并回调新名字', async () => {
    const onRenamed = vi.fn();
    const { apiRef, commitRename } = await setup(vi.fn(async () => true), onRenamed);
    act(() => { apiRef.current!.startRename('orders'); });
    act(() => { apiRef.current!.setRenameDraft('orders_v2'); });
    await act(async () => { await apiRef.current!.commitRename(); });

    expect(commitRename).toHaveBeenCalledWith('orders', 'orders_v2');
    expect(onRenamed).toHaveBeenCalledWith('orders', 'orders_v2');
    expect(apiRef.current!.renamingTable).toBeNull();
  });

  it('名字没变时只退出编辑，不调用改名接口', async () => {
    const { apiRef, commitRename } = await setup();
    act(() => { apiRef.current!.startRename('orders'); });
    await act(async () => { await apiRef.current!.commitRename(); });

    expect(commitRename).not.toHaveBeenCalled();
    expect(apiRef.current!.renamingTable).toBeNull();
  });

  it('改名失败时不回调新名字，但仍退出编辑', async () => {
    const onRenamed = vi.fn();
    const { apiRef } = await setup(vi.fn(async () => false), onRenamed);
    act(() => { apiRef.current!.startRename('orders'); });
    act(() => { apiRef.current!.setRenameDraft('orders_v2'); });
    await act(async () => { await apiRef.current!.commitRename(); });

    expect(onRenamed).not.toHaveBeenCalled();
    expect(apiRef.current!.renamingTable).toBeNull();
  });

  it('Esc 取消不提交', async () => {
    const { apiRef, commitRename } = await setup();
    act(() => { apiRef.current!.startRename('orders'); });
    act(() => { apiRef.current!.setRenameDraft('typo'); });
    act(() => { apiRef.current!.cancelRename(); });

    expect(commitRename).not.toHaveBeenCalled();
    expect(apiRef.current!.renamingTable).toBeNull();
  });

  it('点击编辑框以外的区域自动提交', async () => {
    const { apiRef, commitRename } = await setup();
    act(() => { apiRef.current!.startRename('orders'); });
    act(() => { apiRef.current!.setRenameDraft('orders_v2'); });

    const outside = container.querySelector('[data-testid="outside"]') as HTMLElement;
    await act(async () => {
      outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(commitRename).toHaveBeenCalledWith('orders', 'orders_v2');
    expect(apiRef.current!.renamingTable).toBeNull();
  });
});
