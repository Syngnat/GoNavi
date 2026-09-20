import {
  resolveCurrentSqlStatementRange,
  type SqlStatementRange,
} from '../../utils/sqlStatementSelection';
import { getNormalizedPositionAtOffset } from './QueryEditorHelpers';

export const STATEMENT_HIGHLIGHT_PADDING_PX = 3;

export type StatementHighlightMode = 'hover' | 'armed';

export type RunShortcutAction = 'run' | 'arm';

export type OverlayRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type StatementLineSlice = {
  lineNumber: number;
  startColumn: number;
  endColumn: number;
};

export type VisiblePosition = {
  left: number;
  top: number;
  height: number;
};

export const buildStatementHighlightKey = (range: SqlStatementRange): string => (
  `${range.start}:${range.end}:${range.text}`
);

export const resolveHighlightableStatementRange = (
  sql: string,
  cursorOffset: number,
  dbType = '',
): SqlStatementRange | null => {
  const range = resolveCurrentSqlStatementRange(sql, cursorOffset, dbType);
  if (!range || !range.text.trim()) {
    return null;
  }
  const text = String(sql || '').replace(/\r\n/g, '\n');
  const delimiter = text[range.end];
  if (delimiter === ';' || delimiter === '；') {
    const end = range.end + 1;
    return { start: range.start, end, text: text.slice(range.start, end) };
  }
  return range;
};

export const resolveRunShortcutAction = ({
  enabled,
  hasSelection,
  statementKey,
  armedKey,
}: {
  enabled: boolean;
  hasSelection: boolean;
  statementKey: string | null;
  armedKey: string | null;
}): RunShortcutAction => {
  if (!enabled || hasSelection || !statementKey) {
    return 'run';
  }
  if (armedKey === statementKey) {
    return 'run';
  }
  return 'arm';
};

export const shouldDisarmArmedHighlightOnClick = ({
  armedRange,
  clickOffset,
}: {
  armedRange: SqlStatementRange | null;
  clickOffset: number | null;
}): boolean => {
  if (!armedRange) {
    return false;
  }
  if (clickOffset === null || !Number.isFinite(clickOffset)) {
    return true;
  }
  return clickOffset < armedRange.start || clickOffset > armedRange.end;
};

export const getStatementLineSlices = (
  sql: string,
  range: SqlStatementRange,
): StatementLineSlice[] => {
  const text = String(sql || '').replace(/\r\n/g, '\n');
  const start = getNormalizedPositionAtOffset(text, range.start);
  const end = getNormalizedPositionAtOffset(text, range.end);
  const lines = text.split('\n');
  const slices: StatementLineSlice[] = [];
  for (let lineNumber = start.lineNumber; lineNumber <= end.lineNumber; lineNumber += 1) {
    const lineLength = lines[lineNumber - 1]?.length || 0;
    const startColumn = lineNumber === start.lineNumber ? start.column : 1;
    const endColumn = lineNumber === end.lineNumber
      ? Math.max(startColumn, end.column)
      : Math.max(startColumn, lineLength + 1);
    slices.push({ lineNumber, startColumn, endColumn });
  }
  return slices;
};

export const padOverlayRect = (
  rect: OverlayRect,
  padding = STATEMENT_HIGHLIGHT_PADDING_PX,
): OverlayRect => ({
  left: rect.left - padding,
  top: rect.top - padding,
  width: rect.width + padding * 2,
  height: rect.height + padding * 2,
});

export const padStackedOverlayRects = (
  rects: OverlayRect[],
  padding = STATEMENT_HIGHLIGHT_PADDING_PX,
): OverlayRect[] => rects.map((rect, index) => {
  const padTop = index === 0 ? padding : 0;
  const padBottom = index === rects.length - 1 ? padding : 0;
  return {
    left: rect.left - padding,
    top: rect.top - padTop,
    width: rect.width + padding * 2,
    height: rect.height + padTop + padBottom,
  };
});

export const alignMiddleOverlayRectsToLongest = (rects: OverlayRect[]): OverlayRect[] => {
  if (rects.length <= 2) {
    return rects;
  }
  const rest = rects.slice(1);
  const restLeft = rest.reduce((left, rect) => Math.min(left, rect.left), rest[0].left);
  const maxRight = rects.reduce((right, rect) => Math.max(right, rect.left + rect.width), 0);
  return rects.map((rect, index) => {
    if (index === 0) {
      return rect;
    }
    const right = index === rects.length - 1
      ? rect.left + rect.width
      : maxRight;
    return {
      ...rect,
      left: restLeft,
      width: Math.max(1, right - restLeft),
    };
  });
};

export const buildStatementOverlayRects = (
  slices: StatementLineSlice[],
  getVisiblePosition: (lineNumber: number, column: number) => VisiblePosition | null,
  padding = STATEMENT_HIGHLIGHT_PADDING_PX,
): OverlayRect[] => {
  const rects: OverlayRect[] = [];
  slices.forEach((slice) => {
    const start = getVisiblePosition(slice.lineNumber, slice.startColumn);
    const end = getVisiblePosition(slice.lineNumber, slice.endColumn);
    if (!start || !end) {
      return;
    }
    rects.push({
      left: start.left,
      top: start.top,
      width: Math.max(1, end.left - start.left),
      height: Math.max(1, start.height || end.height || 1),
    });
  });
  return padStackedOverlayRects(alignMiddleOverlayRectsToLongest(rects), padding);
};

export const buildWrappedStatementPolygon = (
  rects: OverlayRect[],
): Array<{ x: number; y: number }> => {
  if (rects.length === 0) {
    return [];
  }
  const rightEdge = (rect: OverlayRect) => rect.left + rect.width;
  const bottomEdge = (rect: OverlayRect) => rect.top + rect.height;
  const last = rects[rects.length - 1];
  const points: Array<{ x: number; y: number }> = [
    { x: rects[0].left, y: rects[0].top },
    { x: rightEdge(rects[0]), y: rects[0].top },
  ];
  for (let index = 0; index < rects.length - 1; index += 1) {
    const seamY = bottomEdge(rects[index]);
    const currentRight = rightEdge(rects[index]);
    const nextRight = rightEdge(rects[index + 1]);
    points.push({ x: currentRight, y: seamY });
    if (currentRight !== nextRight) {
      points.push({ x: nextRight, y: seamY });
    }
  }
  points.push({ x: rightEdge(last), y: bottomEdge(last) });
  points.push({ x: last.left, y: bottomEdge(last) });
  for (let index = rects.length - 1; index > 0; index -= 1) {
    const seamY = rects[index].top;
    const currentLeft = rects[index].left;
    const previousLeft = rects[index - 1].left;
    points.push({ x: currentLeft, y: seamY });
    if (currentLeft !== previousLeft) {
      points.push({ x: previousLeft, y: seamY });
    }
  }
  return points;
};
