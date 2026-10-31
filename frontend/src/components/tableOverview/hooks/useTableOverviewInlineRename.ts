import { useCallback, useEffect, useRef, useState } from 'react';

type UseTableOverviewInlineRenameArgs = {
  /** 真正提交改名（校验 + 生产库确认 + 落库 + 刷新），返回是否成功。 */
  commitRename: (tableName: string, newName: string) => Promise<boolean>;
  /** 改名成功后回调，调用方通常把选中集切到新名字。 */
  onRenamed?: (previousName: string, newName: string) => void;
};

/**
 * 表概览的表名就地编辑：
 *
 * 单选某张表后再次单击表名进入编辑；失焦 / 回车提交，Esc 放弃；
 * 点击编辑框以外的任何地方也会提交（不依赖 Input 的 blur 是否触发，
 * 例如点到列表外会先卸载编辑器，blur 不一定派发）。
 */
export const useTableOverviewInlineRename = ({ commitRename, onRenamed }: UseTableOverviewInlineRenameArgs) => {
  const [renamingTable, setRenamingTable] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const editorRef = useRef<HTMLSpanElement | null>(null);
  // 提交中 / 已放弃时不再重复提交（blur 与点击外部可能连续触发）。
  const committingRef = useRef(false);
  const renamingRef = useRef<string | null>(null);
  const draftRef = useRef('');
  const commitRenameRef = useRef(commitRename);
  const onRenamedRef = useRef(onRenamed);
  commitRenameRef.current = commitRename;
  onRenamedRef.current = onRenamed;
  renamingRef.current = renamingTable;
  draftRef.current = draft;

  const cancelRename = useCallback(() => {
    setRenamingTable(null);
    setDraft('');
  }, []);

  const startRename = useCallback((tableName: string) => {
    if (!tableName) return;
    setRenamingTable(tableName);
    setDraft(tableName);
  }, []);

  const commit = useCallback(async () => {
    const tableName = renamingRef.current;
    if (!tableName || committingRef.current) return;
    committingRef.current = true;
    const nextName = draftRef.current.trim();
    try {
      if (!nextName || nextName === tableName) {
        cancelRename();
        return;
      }
      const ok = await commitRenameRef.current(tableName, nextName);
      cancelRename();
      if (ok) onRenamedRef.current?.(tableName, nextName);
    } finally {
      committingRef.current = false;
    }
  }, [cancelRename]);

  // 编辑期间：在编辑器以外按下鼠标即提交。
  useEffect(() => {
    if (!renamingTable) return undefined;
    const handleMouseDown = (event: MouseEvent) => {
      const editor = editorRef.current;
      const target = event.target as Node | null;
      if (editor && target && editor.contains(target)) return;
      void commit();
    };
    document.addEventListener('mousedown', handleMouseDown, true);
    return () => document.removeEventListener('mousedown', handleMouseDown, true);
  }, [commit, renamingTable]);

  return {
    renamingTable,
    renameDraft: draft,
    editorRef,
    startRename,
    setRenameDraft: setDraft,
    commitRename: commit,
    cancelRename,
  };
};

export type TableOverviewInlineRenameApi = ReturnType<typeof useTableOverviewInlineRename>;
