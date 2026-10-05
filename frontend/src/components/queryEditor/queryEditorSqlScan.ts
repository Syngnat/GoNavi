import {
    supportsQueryEditorBracketIdentifier,
    supportsQueryEditorEscapedBracketIdentifier,
    QUERY_EDITOR_OBJECT_DECORATION_MAX_IDENTIFIERS,
    QUERY_EDITOR_SQL_IDENTIFIER_PATH_PATTERN,
    isQueryEditorIdentifierCharAt,
} from './queryEditorIdentifierPaths';
import { analyzeQueryEditorTableReferences } from './queryEditorTableReferences';

export const maskQueryEditorSqlLiteralsAndComments = (source: string, dbType = ''): string => {
    // Keep the original string length so offsets reported by Monaco remain
    // valid while callers inspect the masked copy. CR/LF are both whitespace
    // to the scanners and must not be collapsed here.
    const text = String(source || '');
    if (!text) return '';

    const chars = text.split('');
    let inSingle = false;
    let inDouble = false;
    let inBacktick = false;
    let inBracket = false;
    let inLineComment = false;
    let inBlockComment = false;
    let dollarTag = '';
    let escaped = false;
    const bracketIdentifiers = supportsQueryEditorBracketIdentifier(dbType);

    const maskAt = (index: number) => {
        if (chars[index] !== '\n') {
            chars[index] = ' ';
        }
    };

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        const next = i + 1 < text.length ? text[i + 1] : '';
        const prev = i > 0 ? text[i - 1] : '';

        if (dollarTag) {
            if (text.startsWith(dollarTag, i)) {
                for (let tagOffset = 0; tagOffset < dollarTag.length; tagOffset += 1) {
                    maskAt(i + tagOffset);
                }
                i += dollarTag.length - 1;
                dollarTag = '';
            } else {
                maskAt(i);
            }
            continue;
        }

        if (inLineComment) {
            if (ch === '\n') {
                inLineComment = false;
            } else {
                maskAt(i);
            }
            continue;
        }

        if (inBlockComment) {
            maskAt(i);
            if (ch === '*' && next === '/') {
                maskAt(i + 1);
                i += 1;
                inBlockComment = false;
            }
            continue;
        }

        if (inSingle) {
            maskAt(i);
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === '\'' && next === '\'') {
                maskAt(i + 1);
                i += 1;
                continue;
            }
            if (ch === '\'') {
                inSingle = false;
            }
            continue;
        }

        // Preserve delimited identifiers while scanning for comments. Their
        // contents may legally contain `#`, `--`, spaces, or dots.
        if (inDouble) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === '"' && next === '"') {
                i += 1;
                continue;
            }
            if (ch === '"') inDouble = false;
            continue;
        }
        if (inBacktick) {
            if (ch === '`' && next === '`') {
                i += 1;
                continue;
            }
            if (ch === '`') inBacktick = false;
            continue;
        }
        if (bracketIdentifiers && inBracket) {
            if (supportsQueryEditorEscapedBracketIdentifier(dbType) && ch === ']' && next === ']') {
                i += 1;
                continue;
            }
            if (ch === ']') inBracket = false;
            continue;
        }

        if (ch === '/' && next === '*') {
            maskAt(i);
            maskAt(i + 1);
            i += 1;
            inBlockComment = true;
            continue;
        }

        // PostgreSQL dollar-quoted strings can contain arbitrary SQL-looking
        // text, including semicolons and FROM/JOIN clauses. Mask the complete
        // body while preserving offsets and newlines for Monaco callers.
        if (ch === '$') {
            const dollarMatch = text.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
            if (
                dollarMatch?.[0]
                && text.indexOf(dollarMatch[0], i + dollarMatch[0].length) >= 0
            ) {
                dollarTag = dollarMatch[0];
                for (let tagOffset = 0; tagOffset < dollarTag.length; tagOffset += 1) {
                    maskAt(i + tagOffset);
                }
                i += dollarTag.length - 1;
                continue;
            }
        }

        // MySQL-style # comments must not consume PostgreSQL JSONB operators
        // such as #>, #>>, and #-.
        if (ch === '#' && next !== '>' && next !== '-') {
            maskAt(i);
            inLineComment = true;
            continue;
        }

        if (
            ch === '-'
            && next === '-'
            // A line comment may follow a statement/parenthesis delimiter
            // without a separating space (`;-- comment`). Keep arithmetic
            // forms such as `value--1` out of the comment path.
            && (i === 0 || /\s/.test(prev) || /[;,.()[\]{}]/.test(prev))
        ) {
            maskAt(i);
            maskAt(i + 1);
            i += 1;
            inLineComment = true;
            continue;
        }

        if (ch === '\'') {
            maskAt(i);
            inSingle = true;
            continue;
        }
        if (ch === '"') {
            inDouble = true;
            continue;
        }
        if (ch === '`') {
            inBacktick = true;
            continue;
        }
        if (bracketIdentifiers && ch === '[') {
            inBracket = true;
        }
    }

    return chars.join('');
};

export const collectQueryEditorObjectDecorationCandidates = (
    source: string,
    maxIdentifiers = QUERY_EDITOR_OBJECT_DECORATION_MAX_IDENTIFIERS,
    dbType = '',
): Array<{ lineNumber: number; lineContent: string; positionColumn: number }> => {
    const text = String(source || '').replace(/\r\n/g, '\n');
    if (!text) return [];

    const maskedText = maskQueryEditorSqlLiteralsAndComments(text, dbType);
    const lines = text.split('\n');
    const maskedLines = maskedText.split('\n');
    const candidates: Array<{ lineNumber: number; lineContent: string; positionColumn: number }> = [];
    const identifierRegex = new RegExp(
        `${QUERY_EDITOR_SQL_IDENTIFIER_PATH_PATTERN}`,
        'g',
    );

    for (const [lineIndex, maskedLine] of maskedLines.entries()) {
        let match: RegExpExecArray | null;
        identifierRegex.lastIndex = 0;
        while ((match = identifierRegex.exec(maskedLine)) !== null) {
            candidates.push({
                lineNumber: lineIndex + 1,
                lineContent: lines[lineIndex] || '',
                positionColumn: match.index + 2,
            });
            if (candidates.length >= maxIdentifiers) {
                return candidates;
            }
        }
    }

    return candidates;
};

export const findIdentifierWindowAtOffset = (
    lineContent: string,
    rawOffset: number,
    preferRight = false,
    dbType = '',
): { start: number; end: number } | null => {
    const text = String(lineContent || '');
    if (!text) return null;
    const searchableText = maskQueryEditorSqlLiteralsAndComments(text, dbType);
    const bracketIdentifiers = supportsQueryEditorBracketIdentifier(dbType);
    const maxIndex = text.length - 1;
    if (maxIndex < 0) return null;
    let offset = Math.max(0, Math.min(maxIndex, Number.isFinite(rawOffset) ? rawOffset : 0));

    if (!isQueryEditorIdentifierCharAt(searchableText[offset], dbType)) {
        // At the separating space between a keyword and its operand, Monaco
        // may report the first operand column. Context-sensitive callers can
        // prefer the right token; normal identifier lookup keeps its legacy
        // left-token behavior.
        let rightOffset = offset + 1;
        if (preferRight) {
            while (rightOffset <= maxIndex && /[ \t\r\f]/.test(searchableText[rightOffset] || '')) {
                rightOffset += 1;
            }
        }
        if (preferRight && rightOffset <= maxIndex && isQueryEditorIdentifierCharAt(searchableText[rightOffset], dbType)) {
            offset = rightOffset;
        } else if (offset > 0 && isQueryEditorIdentifierCharAt(searchableText[offset - 1], dbType)) {
            offset -= 1;
        } else {
            return null;
        }
    }

    // Quoted identifiers may contain spaces and dots. The old character-wise
    // scan stopped at the first space, turning `"Sales Data"` into a partial
    // token and making metadata fallback impossible. Locate the complete
    // delimited segment before expanding the ordinary identifier window.
    const quotedIdentifierWindow = (anchor: number): { start: number; end: number } | null => {
        let quoteStart = -1;
        let quoteKind = '';
        let active = false;
        for (let index = 0; index <= anchor; index += 1) {
            const ch = text[index];
            if (!active) {
                if (
                    searchableText[index] === ch
                    && (ch === '"' || ch === '`' || (bracketIdentifiers && ch === '['))
                ) {
                    active = true;
                    quoteStart = index;
                    quoteKind = ch === '[' ? ']' : ch;
                }
                continue;
            }
            if (searchableText[index] === quoteKind) {
                if (searchableText[index + 1] === quoteKind) {
                    index += 1;
                    continue;
                }
                if (index >= anchor) {
                    return { start: quoteStart, end: index + 1 };
                }
                active = false;
                quoteStart = -1;
                quoteKind = '';
            }
        }
        if (!active || quoteStart < 0) return null;

        let end = text.length;
        for (let index = Math.max(anchor + 1, quoteStart + 1); index < text.length; index += 1) {
            if (searchableText[index] !== quoteKind) continue;
            if (searchableText[index + 1] === quoteKind) {
                index += 1;
                continue;
            }
            end = index + 1;
            break;
        }
        return { start: quoteStart, end };
    };

    const quotedWindow = quotedIdentifierWindow(offset);
    if (quotedWindow) {
        return quotedWindow;
    }

    let start = offset;
    while (start > 0 && isQueryEditorIdentifierCharAt(searchableText[start - 1], dbType)) {
        start -= 1;
    }

    let end = offset + 1;
    while (end < text.length && isQueryEditorIdentifierCharAt(searchableText[end], dbType)) {
        end += 1;
    }

    return start < end ? { start, end } : null;
};

export const getQueryEditorDocumentOffsetAtPosition = (
    documentText: string,
    lineNumber: number,
    column: number,
): number => {
    const lines = String(documentText || '').split('\n');
    const safeLineNumber = Math.max(1, Math.min(lines.length, Math.floor(Number(lineNumber) || 1)));
    const lineStart = lines
        .slice(0, safeLineNumber - 1)
        .reduce((offset, line) => offset + line.length + 1, 0);
    return lineStart + Math.max(0, Math.floor(Number(column) || 1) - 1);
};

// 限定名允许被格式化拆行（db\n.\ntable、`db`.\n`table`），在全文范围内吸收跨行的点号分段，
// 避免悬停/导航把拆行后的限定名当成当前库同名对象（串库）
export const findQualifiedIdentifierWindowAtOffset = (
    text: string,
    rawOffset: number,
    preferRight = false,
    dbType = '',
): { start: number; end: number } | null => {
    const source = String(text || '');
    if (!source) return null;
    const base = findIdentifierWindowAtOffset(source, rawOffset, preferRight, dbType);
    if (!base) return null;
    let start = base.start;
    let end = base.end;
    for (;;) {
        let cursor = start;
        while (cursor > 0 && /\s/.test(source[cursor - 1])) cursor -= 1;
        if (cursor <= 0 || source[cursor - 1] !== '.') break;
        let segmentEnd = cursor - 1;
        while (segmentEnd > 0 && /\s/.test(source[segmentEnd - 1])) segmentEnd -= 1;
        if (segmentEnd <= 0) break;
        const segmentWindow = findIdentifierWindowAtOffset(source, segmentEnd - 1, preferRight, dbType);
        // 窗口只需覆盖段尾字符；点号本身属于标识符字符，窗口可能越过后继点号，不能要求精确对齐
        if (!segmentWindow || segmentWindow.start > segmentEnd - 1 || segmentWindow.end <= segmentEnd - 1) break;
        start = segmentWindow.start;
    }
    for (;;) {
        let cursor = end;
        while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
        if (cursor >= source.length || source[cursor] !== '.') break;
        let segmentStart = cursor + 1;
        while (segmentStart < source.length && /\s/.test(source[segmentStart])) segmentStart += 1;
        if (segmentStart >= source.length) break;
        const segmentWindow = findIdentifierWindowAtOffset(source, segmentStart, preferRight, dbType);
        if (!segmentWindow || segmentWindow.start > segmentStart || segmentWindow.end <= segmentStart) break;
        end = segmentWindow.end;
    }
    return { start, end };
};

export const isQueryEditorTableSourcePrefix = (prefix: string, dbType = ''): boolean => {
    if (
        /\b(?:from|join|update|into)\s+(?:(?:only|lateral)\s+)?$/i.test(prefix)
        || /\bdelete\s+from\s+(?:(?:only|lateral)\s+)?$/i.test(prefix)
    ) {
        return true;
    }

    // A comma starts another physical source in the same FROM list and a dot
    // starts a qualified source segment. Restrict the analyzer fallback to
    // those unfinished delimiters; otherwise `FROM users alias` would make
    // the alias look like another table source.
    const trimmedPrefix = String(prefix || '').replace(/\s+$/, '');
    return /[,.]$/.test(trimmedPrefix)
        && analyzeQueryEditorTableReferences(trimmedPrefix, dbType).expectsTableSource;
};

export const isQueryEditorTableSourceAtPosition = (
    fullText: string,
    lineNumber: number,
    column: number,
    dbType = '',
): boolean => {
    const text = String(fullText || '').replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    const safeLineNumber = Math.max(1, Math.min(lines.length, Math.floor(Number(lineNumber) || 1)));
    const lineContent = lines[safeLineNumber - 1] || '';
    const rawOffset = Math.max(0, Number(column || 1) - 2);
    let identifierWindow = findIdentifierWindowAtOffset(lineContent, rawOffset, true, dbType);
    // Monaco positions at the first character of a table name point one
    // column after the separating space. When both neighbors are identifier
    // characters (the `M` in FROM on the left and the table on the right),
    // prefer the right-hand token so the source keyword does not win.
    if (
        rawOffset < lineContent.length
        && /\s/.test(lineContent[rawOffset] || '')
        && isQueryEditorIdentifierCharAt(lineContent[rawOffset + 1], dbType)
    ) {
        identifierWindow = findIdentifierWindowAtOffset(lineContent, rawOffset + 1, true, dbType);
    }
    if (!identifierWindow) return false;

    const lineStart = lines
        .slice(0, safeLineNumber - 1)
        .reduce((offset, line) => offset + line.length + 1, 0);
    const maskedPrefix = maskQueryEditorSqlLiteralsAndComments(
        text.slice(0, lineStart + identifierWindow.start),
        dbType,
    );
    if (
        /\.\s*$/s.test(maskedPrefix)
        && /\n/.test(maskedPrefix.slice(maskedPrefix.lastIndexOf('.') + 1))
        && /\b(?:from|join|update|into|delete\s+from)\b[\s\S]*\.\s*$/i.test(maskedPrefix)
    ) {
        // A formatter may put the qualifier dot on its own line. In that
        // shape the final identifier is still a table source, even though the
        // generic analyzer treats a trailing dot as column context.
        return true;
    }
    return isQueryEditorTableSourcePrefix(maskedPrefix, dbType);
};
