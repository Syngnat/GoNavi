/**
 * 补全分析专用的文档读取（性能专项）
 *
 * SQL 补全每次触发都要拿「光标附近的语句文本」。旧实现直接 model.getValue() 复制整篇文档，
 * 大 SQL 下每次按键都产生一次 O(文档长度) 的拷贝与后续扫描，Monaco 主线程因此卡死。
 *
 * 这里在文档超过阈值时只读取光标前 16,000 / 后 256 个字符：
 * 语句上下文本身只需覆盖当前语句，超出窗口的部分对补全没有意义。
 * 小文档仍走全文读取，保持行为与原来完全一致。
 */

import { getNormalizedOffsetAtPosition } from '../queryEditorEditorState';
import {
    getQueryEditorModelValueLength,
    QUERY_EDITOR_LIVE_DECORATION_MAX_TEXT_LENGTH,
} from '../queryEditorIdentifierPaths';
import { normalizeQueryEditorCompletionAnalysisText } from '../queryEditorInlineMemory';

export const QUERY_EDITOR_COMPLETION_ANALYSIS_MAX_TEXT_LENGTH = QUERY_EDITOR_LIVE_DECORATION_MAX_TEXT_LENGTH;
export const QUERY_EDITOR_COMPLETION_ANALYSIS_PREFIX_CHARS = 16_000;
export const QUERY_EDITOR_COMPLETION_ANALYSIS_SUFFIX_CHARS = 256;

export interface QueryEditorCompletionAnalysisText {
    /** 规范化后的分析文本；大文档时只包含光标附近的窗口。 */
    text: string;
    /** 光标在上述 text 中的归一化偏移。 */
    cursorOffset: number;
}

export const readQueryEditorCompletionAnalysisText = (
    model: any,
    position: { lineNumber: number; column: number },
): QueryEditorCompletionAnalysisText => {
    const normalizedPosition = {
        lineNumber: Math.max(1, Math.floor(Number(position?.lineNumber) || 1)),
        column: Math.max(1, Math.floor(Number(position?.column) || 1)),
    };
    const modelLength = getQueryEditorModelValueLength(model);
    const canReadWindow = typeof model?.getOffsetAt === 'function'
        && typeof model?.getPositionAt === 'function'
        && typeof model?.getValueInRange === 'function';
    if (
        modelLength === null
        || modelLength <= QUERY_EDITOR_COMPLETION_ANALYSIS_MAX_TEXT_LENGTH
        || !canReadWindow
    ) {
        const text = normalizeQueryEditorCompletionAnalysisText(String(model?.getValue?.() || ''));
        return {
            text,
            cursorOffset: getNormalizedOffsetAtPosition(text, normalizedPosition),
        };
    }

    const rawCursorOffset = Number(model.getOffsetAt(normalizedPosition));
    const cursorOffset = Number.isFinite(rawCursorOffset)
        ? Math.max(0, Math.min(modelLength, rawCursorOffset))
        : 0;
    const startOffset = Math.max(0, cursorOffset - QUERY_EDITOR_COMPLETION_ANALYSIS_PREFIX_CHARS);
    const endOffset = Math.min(modelLength, cursorOffset + QUERY_EDITOR_COMPLETION_ANALYSIS_SUFFIX_CHARS);
    const start = model.getPositionAt(startOffset);
    const cursor = model.getPositionAt(cursorOffset);
    const end = model.getPositionAt(endOffset);
    const toRange = (from: any, to: any) => ({
        startLineNumber: from.lineNumber,
        startColumn: from.column,
        endLineNumber: to.lineNumber,
        endColumn: to.column,
    });
    const prefix = normalizeQueryEditorCompletionAnalysisText(
        String(model.getValueInRange(toRange(start, cursor)) || ''),
    );
    const suffix = normalizeQueryEditorCompletionAnalysisText(
        String(model.getValueInRange(toRange(cursor, end)) || ''),
    );
    return {
        text: `${prefix}${suffix}`,
        cursorOffset: prefix.length,
    };
};
