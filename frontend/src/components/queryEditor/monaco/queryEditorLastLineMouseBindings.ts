import type { OnMount } from '../../MonacoEditor';
import { placeQueryEditorLastLineCaret, selectQueryEditorLastLineWord } from './queryEditorLastLineWordSelect';

// 保持鼠标兜底的焦点、默认行为与清理集中，避免扩展编辑器主接线函数。
export const bindQueryEditorLastLineMouseEvents = (
    editor: Parameters<OnMount>[0],
    monaco: Parameters<OnMount>[1],
    editorDomNode: HTMLElement | null,
): (() => void) => {
    const host = {
        getModel: () => editor.getModel(),
        getTargetAtClientPoint: (clientX: number, clientY: number) => editor.getTargetAtClientPoint(clientX, clientY),
        queryLastRenderedLine: () => {
            const lines = editorDomNode?.querySelectorAll('.view-lines .view-line');
            return lines?.length ? lines[lines.length - 1] : null;
        },
        selectWord: (lineNumber: number, startColumn: number, endColumn: number) => {
            editor.setSelection(new monaco.Selection(lineNumber, startColumn, lineNumber, endColumn));
        },
        placeCaret: (lineNumber: number, column: number) => editor.setPosition({ lineNumber, column }),
    };
    const handleMouseEvent = (rawEvent: Event) => {
        const event = rawEvent as MouseEvent;
        // 修饰键有扩展选区、导航或菜单语义，不能降级成单光标定位。
        if (event.button !== 0 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
        try {
            const handled = event.type === 'dblclick'
                ? selectQueryEditorLastLineWord(host, event.clientX, event.clientY)
                : placeQueryEditorLastLineCaret(host, event.clientX, event.clientY);
            if (!handled) return;
            event.preventDefault();
            editor.focus();
        } catch {
            // 兜底失败不能影响正常编辑。
        }
    };
    editorDomNode?.addEventListener('mousedown', handleMouseEvent, true);
    editorDomNode?.addEventListener('dblclick', handleMouseEvent, true);
    return () => {
        editorDomNode?.removeEventListener('mousedown', handleMouseEvent, true);
        editorDomNode?.removeEventListener('dblclick', handleMouseEvent, true);
    };
};
