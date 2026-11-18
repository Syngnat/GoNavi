import { describe, expect, it } from 'vitest';
import {
    QUERY_EDITOR_AI_INLINE_GHOST_MAX_MODEL_LENGTH,
    shouldSkipAutomaticQueryEditorAiInlineGhost,
} from './queryEditorAiInlineGhostPolicy';

describe('queryEditorAiInlineGhostPolicy', () => {
    it('allows automatic ghosts at or below the size limit', () => {
        expect(shouldSkipAutomaticQueryEditorAiInlineGhost(0)).toBe(false);
        expect(shouldSkipAutomaticQueryEditorAiInlineGhost(
            QUERY_EDITOR_AI_INLINE_GHOST_MAX_MODEL_LENGTH,
        )).toBe(false);
    });

    it('skips automatic ghosts above the size limit', () => {
        expect(shouldSkipAutomaticQueryEditorAiInlineGhost(
            QUERY_EDITOR_AI_INLINE_GHOST_MAX_MODEL_LENGTH + 1,
        )).toBe(true);
    });

    it('fails open when the model length is unavailable', () => {
        expect(shouldSkipAutomaticQueryEditorAiInlineGhost(Number.NaN)).toBe(false);
        expect(shouldSkipAutomaticQueryEditorAiInlineGhost(Number.POSITIVE_INFINITY)).toBe(false);
    });
});
