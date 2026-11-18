import type * as MonacoNS from 'monaco-editor';
import { getQueryEditorModelValueLength } from '../queryEditorIdentifierPaths';

// 参数高亮的两道上限。1MiB 与「键入分析上限」同一量级：普通 SQL 完全不受
// 影响；超限时整体清空（避免留下与最新文本不符的旧高亮）。
// 出现次数上限更关键：deltaDecorations 每条约 0.5–1μs，密集参数下仅长度
// 上限挡不住（1MB 可产出数十万条）。
const QUERY_EDITOR_PARAM_DECORATION_MAX_TEXT_LENGTH = 1_048_576;
const QUERY_EDITOR_PARAM_DECORATION_MAX_OCCURRENCES = 2_000;

// Monaco 参数装饰：为当前 SQL 中出现的 :name 记号加高亮，提示可填值。
// 位置来自后端 AnalyzeQueryParameters 的语句拆分结果不可用（后端返回的是
// 语句级文本），这里用轻量正则在纯文本层定位——只做展示，不参与执行判定。

// 装饰 id 池按编辑器实例隔离：多编辑器标签页各自维护，避免跨实例清理失效。
const decorationPools = new WeakMap<MonacoNS.editor.IStandaloneCodeEditor, string[]>();

export function applyParamNameDecorations(
  editor: MonacoNS.editor.IStandaloneCodeEditor | null | undefined,
  monaco: typeof MonacoNS | null | undefined,
  paramNames: string[],
): void {
  if (!editor || !monaco) {
    return;
  }
  const model = editor.getModel();
  if (!model) {
    return;
  }
  const modelLength = getQueryEditorModelValueLength(model);
  if (modelLength !== null && modelLength > QUERY_EDITOR_PARAM_DECORATION_MAX_TEXT_LENGTH) {
    clearParamNameDecorations(editor);
    return;
  }
  const decorations: MonacoNS.editor.IModelDeltaDecoration[] = [];
  if (paramNames.length > 0) {
    const alternation = paramNames
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const pattern = new RegExp(`:(?:${alternation})\\b`, 'g');
    const text = model.getValue();
    let match = pattern.exec(text);
    while (match) {
      if (decorations.length >= QUERY_EDITOR_PARAM_DECORATION_MAX_OCCURRENCES) {
        clearParamNameDecorations(editor);
        return;
      }
      const start = model.getPositionAt(match.index);
      const end = model.getPositionAt(match.index + match[0].length);
      decorations.push({
        range: new monaco.Range(
          start.lineNumber,
          start.column,
          end.lineNumber,
          end.column,
        ),
        options: {
          inlineClassName: 'gn-query-param-token',
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
      if (match[0].length === 0) {
        break;
      }
      match = pattern.exec(text);
    }
  }
  decorationPools.set(editor, editor.deltaDecorations(decorationPools.get(editor) || [], decorations));
}

export function clearParamNameDecorations(
  editor: MonacoNS.editor.IStandaloneCodeEditor | null | undefined,
): void {
  if (!editor) {
    return;
  }
  decorationPools.set(editor, editor.deltaDecorations(decorationPools.get(editor) || [], []));
}
