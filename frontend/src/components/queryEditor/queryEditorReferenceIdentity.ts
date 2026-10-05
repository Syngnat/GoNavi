import { isPgLikeDialect } from '../../utils/sqlDialect';
import { t as translate } from '../../i18n';
import {
    splitQueryIdentifierPathSegments,
    type QueryIdentifierPathSegment,
    type QueryEditorHoverTarget,
} from './queryEditorIdentifierPaths';
import { normalizeCommentText } from './queryEditorCompletionMetadata';

export const normalizeNavigationIdentifierParts = (text: string, dbType = ''): string[] => (
    splitQueryIdentifierPathSegments(text, dbType).map((part) => part.value.trim()).filter(Boolean)
);

// PostgreSQL folds unquoted identifiers to lower case, while a quoted
// identifier keeps its exact spelling. Comparing both sides with toLowerCase
// loses the distinction between `Users` and `users`, so keep this rule in one
// place for navigation and hover metadata matching.
export const matchesQueryEditorIdentifierSegment = (
    querySegment: QueryIdentifierPathSegment,
    metadataValue: string,
    dialect: string,
): boolean => {
    const queryValue = String(querySegment?.value || '').trim();
    const metadataText = String(metadataValue || '').trim();
    if (!queryValue || !metadataText) return false;
    if (isPgLikeDialect(dialect)) {
        return querySegment.quoted
            ? metadataText === queryValue
            : metadataText === queryValue.toLowerCase();
    }
    return metadataText.toLowerCase() === queryValue.toLowerCase();
};

type QueryEditorMetadataIdentifierSegment = {
    value: string;
    quoted: boolean;
};

export const matchesQueryEditorMetadataTablePath = (
    queryObjectSegment: QueryIdentifierPathSegment,
    querySchemaSegments: QueryIdentifierPathSegment[] | undefined,
    metadataSegments: QueryEditorMetadataIdentifierSegment[],
    dialect: string,
): boolean => {
    const metadataObjectSegment = metadataSegments[metadataSegments.length - 1];
    if (!metadataObjectSegment || !matchesQueryEditorIdentifierSegment(queryObjectSegment, metadataObjectSegment.value, dialect)) {
        return false;
    }
    if (!querySchemaSegments) return true;
    const metadataSchemaSegments = metadataSegments.slice(0, -1);
    return metadataSchemaSegments.length === querySchemaSegments.length
        && querySchemaSegments.every((segment, index) => (
            matchesQueryEditorIdentifierSegment(segment, metadataSchemaSegments[index]?.value || '', dialect)
        ));
};

export const normalizeQueryEditorHoverIdentifier = (value: string): string => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    // Whitespace inside quoted identifiers is legal and must be preserved.
    if (/[`"\[]/.test(raw)) return raw;
    const qualified = raw.replace(/\s*\.\s*/g, '.').trim();
    if (qualified.includes(' ')) {
        // A stale Monaco offset can leave the tail of FROM/JOIN in front of
        // the actual operand (for example `OM test_users`). SQL identifiers
        // cannot contain unquoted spaces, so keep the final token only.
        return qualified.split(/\s+/).filter(Boolean).pop() || '';
    }
    return qualified;
};

export const isQualifiedQueryEditorHoverIdentifier = (value: string, dbType = ''): boolean => {
    const compact = String(value || '').replace(/\s*\.\s*/g, '.').trim();
    const parts = splitQueryIdentifierPathSegments(compact, dbType);
    if (parts.length < 2) return false;
    return parts.every((part) => part.quoted || !/\s/.test(part.value));
};

export const buildQueryEditorHoverMarkdown = (target: QueryEditorHoverTarget): string => {
    const appendComment = (comment?: string): string => {
        const normalized = normalizeCommentText(comment);
        return normalized ? `\n\n${normalized}` : '';
    };
    const objectInfoLabelSeparator = translate('query_editor.object_info.label.separator');
    const buildObjectInfoTitle = (key: string, value: string): string =>
        `**${translate(key)}** \`${value}\``;
    const buildObjectInfoLabel = (key: string, value: string): string =>
        `${translate(key)}${objectInfoLabelSeparator}\`${value}\``;
    switch (target.kind) {
        case 'database':
            return buildObjectInfoTitle('query_editor.object_info.database', target.dbName);
        case 'table':
            return `${buildObjectInfoTitle('query_editor.object_info.table', target.tableName)}\n\n${buildObjectInfoLabel('query_editor.object_info.label.database', target.dbName)}${target.schemaName ? `\n\n${buildObjectInfoLabel('query_editor.object_info.label.schema', target.schemaName)}` : ''}${appendComment(target.comment)}`;
        case 'view':
            return `${buildObjectInfoTitle('sidebar.object.view', target.viewName)}\n\n${buildObjectInfoLabel('query_editor.object_info.label.database', target.dbName)}${target.schemaName ? `\n\n${buildObjectInfoLabel('query_editor.object_info.label.schema', target.schemaName)}` : ''}`;
        case 'materialized-view':
            return `${buildObjectInfoTitle('query_editor.object_info.materialized_view', target.viewName)}\n\n${buildObjectInfoLabel('query_editor.object_info.label.database', target.dbName)}${target.schemaName ? `\n\n${buildObjectInfoLabel('query_editor.object_info.label.schema', target.schemaName)}` : ''}`;
        case 'trigger':
            return `${buildObjectInfoTitle('trigger_viewer.field.trigger', target.triggerName)}\n\n${buildObjectInfoLabel('query_editor.object_info.label.database', target.dbName)}\n\n${buildObjectInfoLabel('query_editor.object_info.label.table', target.tableName)}${target.schemaName ? `\n\n${buildObjectInfoLabel('query_editor.object_info.label.schema', target.schemaName)}` : ''}`;
        case 'routine':
            return `${buildObjectInfoTitle(target.routineType === 'PROCEDURE' ? 'sidebar.object.procedure' : 'sidebar.object.function', target.routineName)}\n\n${buildObjectInfoLabel('query_editor.object_info.label.database', target.dbName)}${target.schemaName ? `\n\n${buildObjectInfoLabel('query_editor.object_info.label.schema', target.schemaName)}` : ''}`;
        case 'sequence':
            return `${buildObjectInfoTitle('definition_viewer.object.sequence', target.sequenceName)}\n\n${buildObjectInfoLabel('query_editor.object_info.label.database', target.dbName)}${target.schemaName ? `\n\n${buildObjectInfoLabel('query_editor.object_info.label.schema', target.schemaName)}` : ''}`;
        case 'package':
            return `${buildObjectInfoTitle('definition_viewer.object.package', target.packageName)}\n\n${buildObjectInfoLabel('query_editor.object_info.label.database', target.dbName)}${target.schemaName ? `\n\n${buildObjectInfoLabel('query_editor.object_info.label.schema', target.schemaName)}` : ''}`;
        case 'column':
            return `${buildObjectInfoTitle('query_editor.object_info.column', target.columnName)}${target.type ? `\n\n${buildObjectInfoLabel('query_editor.object_info.label.type', target.type)}` : ''}\n\n${buildObjectInfoLabel('query_editor.object_info.label.table', target.tableName)}\n\n${buildObjectInfoLabel('query_editor.object_info.label.database', target.dbName)}${target.schemaName ? `\n\n${buildObjectInfoLabel('query_editor.object_info.label.schema', target.schemaName)}` : ''}${appendComment(target.comment)}`;
        default:
            return '';
    }
};

export type QueryEditorTableReference = {
    tableIdent: string;
    parts: string[];
    alias?: string;
    segments?: QueryIdentifierPathSegment[];
    aliasSegment?: QueryIdentifierPathSegment;
};

export const QUERY_EDITOR_IOTDB_TABLE_PATH_MAX_PARTS = 8;

const createQueryEditorIdentitySegment = (value: string): QueryIdentifierPathSegment => ({
    raw: value,
    value,
    quoted: false,
});

const normalizeQueryEditorIdentitySegmentValue = (
    segment: QueryIdentifierPathSegment,
    dbType = '',
): string => {
    const value = String(segment?.value || '').trim();
    if (!value) return '';
    return isPgLikeDialect(dbType)
        ? (segment.quoted ? value : value.toLowerCase())
        : value.toLowerCase();
};

export const buildQueryEditorIdentifierIdentityKey = (
    segments: ReadonlyArray<QueryIdentifierPathSegment>,
    dbType = '',
): string => segments
    .map((segment) => normalizeQueryEditorIdentitySegmentValue(segment, dbType))
    .filter(Boolean)
    .join('\u0000');

export const buildQueryEditorReferenceIdentityKeys = (
    reference: {
        dbName?: string;
        parts?: ReadonlyArray<string>;
        segments?: QueryIdentifierPathSegment[];
    },
    dbType = '',
): string[] => {
    const referenceParts = reference.parts || [];
    const pathSegments = reference.segments && reference.segments.length > 0
        ? reference.segments
        : referenceParts.map((part) => ({
            raw: part,
            value: part,
            quoted: false,
        }));
    const normalizedPathSegments = pathSegments.filter((segment) => String(segment?.value || '').trim());
    if (normalizedPathSegments.length === 0) {
        return [];
    }

    const baseSegments = referenceParts.length === 1 && String(reference.dbName || '').trim()
        ? [
            createQueryEditorIdentitySegment(String(reference.dbName || '').trim()),
            ...normalizedPathSegments,
        ]
        : normalizedPathSegments;
    const keys = new Set<string>();
    // A qualified reference carries enough scope to be matched exactly. Do
    // not add its unqualified suffix: `public.Users` must never pull columns
    // from `sales.Users`. Unqualified references retain suffix keys because
    // catalog table names commonly include an implicit schema prefix.
    const startIndexes = normalizedPathSegments.length > 1 ? [0] : baseSegments.map((_, index) => index);
    for (const start of startIndexes) {
        const key = buildQueryEditorIdentifierIdentityKey(baseSegments.slice(start), dbType);
        if (key) keys.add(key);
    }
    return [...keys];
};
