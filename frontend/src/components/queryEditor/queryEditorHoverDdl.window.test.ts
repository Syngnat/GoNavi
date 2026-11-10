import { describe, expect, it } from 'vitest';
import { buildQueryEditorObjectResolveContext } from './queryEditorHoverDdl';

const buildModel = (text: string) => {
    const lines = text.split('\n');
    return {
        getValueLength: () => text.length,
        getLineCount: () => lines.length,
        getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
        getOffsetAt: (position: { lineNumber: number; column: number }) => {
            let offset = 0;
            for (let index = 0; index < position.lineNumber - 1; index += 1) {
                offset += (lines[index] ?? '').length + 1;
            }
            return offset + position.column - 1;
        },
        getPositionAt: (offset: number) => {
            let remaining = offset;
            for (let index = 0; index < lines.length; index += 1) {
                const lineLength = lines[index].length;
                if (remaining <= lineLength) {
                    return { lineNumber: index + 1, column: remaining + 1 };
                }
                remaining -= lineLength + 1;
            }
            const last = lines.length;
            return { lineNumber: last, column: lines[last - 1].length + 1 };
        },
        getValue: () => text,
        getValueInRange: (range: any) => {
            const start = buildModel(text).getOffsetAt({
                lineNumber: range.startLineNumber,
                column: range.startColumn,
            });
            const end = buildModel(text).getOffsetAt({
                lineNumber: range.endLineNumber,
                column: range.endColumn,
            });
            return text.slice(start, end);
        },
    };
};

describe('buildQueryEditorObjectResolveContext', () => {
    it('returns the whole short document as before', () => {
        const text = 'SELECT * FROM users';
        const model = buildModel(text);
        const context = buildQueryEditorObjectResolveContext(model as any, { lineNumber: 1, column: 15 }, text);
        expect(context.text).toBe(text);
        expect(context.lineNumber).toBe(1);
        expect(context.documentContext.offset).toBe(14);
    });

    // 单行 10MB 压缩 SQL：整篇就是一行，行窗口回退等于全文扫描。
    it('windows a huge single-line document around the cursor', () => {
        const padding = 'a'.repeat(2_000_000);
        const text = `${padding}SELECT * FROM users WHERE id = 1`;
        const model = buildModel(text);
        // Monaco 列号是 1-based：'i' 的列号 = 其 0-based 偏移 + 1。
        const column = text.length - 'id = 1'.length + 1;
        const context = buildQueryEditorObjectResolveContext(model as any, { lineNumber: 1, column }, text);

        expect(context.text.length).toBeLessThan(200_000);
        expect(context.text.length).toBeGreaterThan(0);
        // 光标处的局部 offset 必须指向同一段文本。
        const atCursor = context.text.slice(
            context.documentContext.offset,
            context.documentContext.offset + 'id = 1'.length,
        );
        expect(atCursor).toBe('id = 1');
    });

    it('keeps multi-line documents on the existing line-window path', () => {
        const text = `${'SELECT 1;\n'.repeat(50_000)}SELECT * FROM users`;
        const model = buildModel(text);
        const lineNumber = 50_001;
        const lineContent = 'SELECT * FROM users';
        const context = buildQueryEditorObjectResolveContext(model as any, { lineNumber, column: 15 }, lineContent);
        expect(context.text.length).toBeLessThan(1000);
        expect(context.text).toContain('SELECT * FROM users');
    });
});
