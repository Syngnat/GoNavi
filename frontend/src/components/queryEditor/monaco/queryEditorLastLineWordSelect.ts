// WKWebView（macOS）的 caretRangeFromPoint 对「最后一行下方的空白」返回空，
// Monaco 因此拿到 UNKNOWN 目标：单击不定位光标，双击选词整个不动作。
// Chromium 会返回最后一行文本，所以只有 mac 上单行 SQL 表现为「双击没反应、换行后才正常」。
// 这里只在 Monaco 自己没命中内容时兜底：把落点夹到最后一行中线再重新命中一次。

export type QueryEditorWordPosition = { lineNumber: number; column: number };

export interface QueryEditorLastLineWordSelectHost {
  getModel?: () => {
    getLineCount?: () => number;
    getWordAtPosition?: (position: QueryEditorWordPosition) => { startColumn: number; endColumn: number } | null | undefined;
  } | null;
  getTargetAtClientPoint?: (clientX: number, clientY: number) => { type?: number; position?: QueryEditorWordPosition } | null | undefined;
  queryLastRenderedLine?: () => Element | null | undefined;
  selectWord?: (lineNumber: number, startColumn: number, endColumn: number) => void;
  placeCaret?: (lineNumber: number, column: number) => void;
}

const CONTENT_TEXT = 6;
const CONTENT_EMPTY = 7;

type ClampedHit = { directHit: boolean; position: QueryEditorWordPosition };

const resolveClampedContentHit = (
  host: QueryEditorLastLineWordSelectHost,
  clientX: number,
  clientY: number,
  lineCount: number,
): ClampedHit | null => {
  const direct = host.getTargetAtClientPoint?.(clientX, clientY);
  if (direct && (direct.type === CONTENT_TEXT || direct.type === CONTENT_EMPTY) && direct.position) {
    return { directHit: true, position: direct.position };
  }
  const rect = host.queryLastRenderedLine?.()?.getBoundingClientRect?.();
  if (!rect || !Number.isFinite(rect.top) || !(rect.height > 0)) return null;
  const clampedY = rect.top + Math.max(1, Math.min(rect.height - 1, rect.height / 2));
  const target = host.getTargetAtClientPoint?.(clientX, clampedY);
  const position = target?.position;
  if (!position || position.lineNumber !== lineCount) return null;
  return { directHit: false, position };
};

// 返回 true 表示这次双击已由兜底逻辑完成选词；false 表示交给 Monaco 原生行为。
export const selectQueryEditorLastLineWord = (
  host: QueryEditorLastLineWordSelectHost,
  clientX: number,
  clientY: number,
): boolean => {
  const model = host.getModel?.();
  const lineCount = Number(model?.getLineCount?.() ?? 0);
  if (!model || lineCount <= 0) return false;
  const hit = resolveClampedContentHit(host, clientX, clientY, lineCount);
  if (!hit || hit.directHit) return false;
  const word = model.getWordAtPosition?.(hit.position);
  if (!word || !(word.endColumn > word.startColumn)) return false;
  host.selectWord?.(hit.position.lineNumber, word.startColumn, word.endColumn);
  return true;
};

// 返回 true 表示这次单击的光标位置已由兜底逻辑设置；false 表示 Monaco 自己会处理。
export const placeQueryEditorLastLineCaret = (
  host: QueryEditorLastLineWordSelectHost,
  clientX: number,
  clientY: number,
): boolean => {
  const model = host.getModel?.();
  const lineCount = Number(model?.getLineCount?.() ?? 0);
  if (!model || lineCount <= 0) return false;
  const hit = resolveClampedContentHit(host, clientX, clientY, lineCount);
  if (!hit || hit.directHit) return false;
  host.placeCaret?.(hit.position.lineNumber, hit.position.column);
  return true;
};
