// Automatic ghost completion snapshots the whole document and runs several
// statement scans. Above this size those synchronous copies block typing, so
// only an explicit user trigger may run the expensive path.
export const QUERY_EDITOR_AI_INLINE_GHOST_MAX_MODEL_LENGTH = 200_000;

export const shouldSkipAutomaticQueryEditorAiInlineGhost = (modelLength: number): boolean => (
    Number.isFinite(modelLength) && modelLength > QUERY_EDITOR_AI_INLINE_GHOST_MAX_MODEL_LENGTH
);
