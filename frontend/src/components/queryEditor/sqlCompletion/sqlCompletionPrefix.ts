export type SqlCompletionWord = {
    word: string;
    startColumn: number;
    endColumn: number;
};

const trailingIdentifierPattern = /[\p{L}\p{N}_$#@]+$/u;

/**
 * Monaco's default word pattern does not include CJK text, so
 * `getWordUntilPosition` returns an empty word for `FROM 认证`.
 * Read the real trailing identifier from the line and prefer it when it is
 * longer, non-ASCII, or Monaco returned nothing. The returned range must cover
 * the same text so accepting a table suggestion replaces the comment fragment
 * instead of inserting after it.
 */
export const resolveSqlCompletionWord = (model: any, position: any): SqlCompletionWord => {
    const monacoWord = model?.getWordUntilPosition?.(position);
    const monacoText = String(monacoWord?.word || '');
    const line = String(model?.getLineContent?.(position.lineNumber) || '');
    const prefix = line.slice(0, Math.max(0, Number(position.column || 1) - 1));
    const token = prefix.match(trailingIdentifierPattern)?.[0] || '';
    const useToken = Boolean(token) && (
        !monacoText
        || token.length > monacoText.length
        || /[^\x00-\x7F]/.test(token)
    );
    if (useToken) {
        return {
            word: token,
            startColumn: Number(position.column) - token.length,
            endColumn: Number(position.column),
        };
    }
    return {
        word: monacoText,
        startColumn: Number(monacoWord?.startColumn || position.column || 1),
        endColumn: Number(monacoWord?.endColumn || position.column || 1),
    };
};
