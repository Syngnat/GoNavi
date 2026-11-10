import { describe, expect, it, vi } from 'vitest';
import { createQueryEditorAiInlineGhostState } from './queryEditorAiInlineGhostState';

const monacoStub = {
    Range: class {
        constructor(
            public startLineNumber: number,
            public startColumn: number,
            public endLineNumber: number,
            public endColumn: number,
        ) {}
    },
} as any;

const createModel = (state: { text: string; versionId: number }) => ({
    id: 'model-1',
    uri: { toString: () => 'file:///model-1' },
    getVersionId: () => state.versionId,
    getLineContent: () => state.text,
    getLineCount: () => 1,
    getLineMaxColumn: () => state.text.length + 1,
    getValue: () => state.text,
    getValueInRange: () => state.text,
    getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
});

const createState = (model: any) => createQueryEditorAiInlineGhostState({
    editor: {
        getModel: () => model,
        getValue: () => model.getValue(),
        getPosition: () => ({ lineNumber: 1, column: 1 }),
    } as any,
    aiInlineGhostTimerRef: { current: null },
    aiInlineGhostDecorationIdsRef: { current: [] },
    aiInlineGhostRequestSeqRef: { current: 0 },
    aiInlineGhostRef: { current: null },
    aiInlineGhostVisibleContextKeyRef: { current: null },
    aiInlineGhostOverlayRef: { current: null },
    editorRef: { current: null },
    monaco: monacoStub,
    connectionsRef: { current: [] },
    currentConnectionIdRef: { current: '' },
    syncQueryDraft: () => undefined,
});

describe('isInlineGhostSnapshotCurrent', () => {
    it('accepts an unchanged document without re-reading the whole model', () => {
        const modelState = { text: 'SELECT 1', versionId: 7 };
        const model = createModel(modelState);
        const state = createState(model);
        const position = { lineNumber: 1, column: 3 };
        const snapshot = state.buildInlineGhostEditorSnapshot(model, position);

        // 版本号与光标都没变：再读全文就是白付一次 10MB 拷贝。
        const spy = vi.spyOn(model, 'getValueInRange');
        expect(state.isInlineGhostSnapshotCurrent(model, position, snapshot)).toBe(true);
        expect(spy).not.toHaveBeenCalled();
    });

    it('refuses a snapshot taken at a different cursor position', () => {
        const modelState = { text: 'SELECT 1', versionId: 7 };
        const model = createModel(modelState);
        const state = createState(model);
        const snapshot = state.buildInlineGhostEditorSnapshot(model, { lineNumber: 1, column: 3 });
        expect(state.isInlineGhostSnapshotCurrent(model, { lineNumber: 1, column: 5 }, snapshot)).toBe(false);
    });

    it('falls back to content comparison when the version changed but text did not', () => {
        const modelState = { text: 'SELECT 1', versionId: 7 };
        const model = createModel(modelState);
        const state = createState(model);
        const position = { lineNumber: 1, column: 3 };
        const snapshot = state.buildInlineGhostEditorSnapshot(model, position);
        modelState.versionId = 8;
        expect(state.isInlineGhostSnapshotCurrent(model, position, snapshot)).toBe(true);
    });

    it('detects an edit even when the version check is unavailable', () => {
        const modelState = { text: 'SELECT 1', versionId: 7 };
        const model = createModel(modelState);
        const state = createState(model);
        const position = { lineNumber: 1, column: 3 };
        const snapshot = state.buildInlineGhostEditorSnapshot(model, position);
        modelState.text = 'SELECT 2';
        delete (model as any).getVersionId;
        expect(state.isInlineGhostSnapshotCurrent(model, position, snapshot)).toBe(false);
    });
});
