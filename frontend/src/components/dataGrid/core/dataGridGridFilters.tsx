import React from 'react';

export const EXACT_GRID_FILTER_OPERATOR = '=';
export const CONTAINS_GRID_FILTER_OPERATOR = 'CONTAINS';
export const FILTER_FIELD_SELECT_STYLE: React.CSSProperties = {
    width: 320,
    flex: '0 1 320px',
    minWidth: 260,
    maxWidth: 'min(460px, 100%)',
};
export const FILTER_FIELD_POPUP_WIDTH = 520;
export const FILTER_FIELD_OPTION_STYLE: React.CSSProperties = {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
};
export const STRING_LIKE_GRID_FILTER_TYPES = new Set([
    'bpchar',
    'char',
    'character',
    'character varying',
    'citext',
    'clob',
    'fixedstring',
    'long nvarchar',
    'long varchar',
    'longtext',
    'mediumtext',
    'nchar',
    'nclob',
    'ntext',
    'nvarchar',
    'nvarchar2',
    'string',
    'text',
    'tinytext',
    'varchar',
    'varchar2',
]);

export const normalizeGridFilterColumnType = (columnType: unknown): string => {
    let normalized = String(columnType ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    for (let i = 0; i < 4; i += 1) {
        const wrapped = normalized.match(/^(?:nullable|lowcardinality)\((.+)\)$/);
        if (!wrapped) break;
        normalized = wrapped[1].trim().replace(/\s+/g, ' ');
    }
    return normalized;
};

export const isStringLikeGridFilterColumnType = (columnType: unknown): boolean => {
    const normalized = normalizeGridFilterColumnType(columnType);
    if (!normalized) return false;
    const baseType = normalized.replace(/\(.*/, '').trim();
    return STRING_LIKE_GRID_FILTER_TYPES.has(baseType);
};

export const resolveDefaultGridFilterOperator = (columnType: unknown): string => (
    isStringLikeGridFilterColumnType(columnType) ? CONTAINS_GRID_FILTER_OPERATOR : EXACT_GRID_FILTER_OPERATOR
);

export const resolveNextGridFilterOperatorForColumnChange = ({
    currentOperator,
    previousColumnType,
    nextColumnType,
}: {
    currentOperator: unknown;
    previousColumnType: unknown;
    nextColumnType: unknown;
}): string => {
    const current = String(currentOperator || '').trim();
    if (!current) return resolveDefaultGridFilterOperator(nextColumnType);
    const previousDefault = resolveDefaultGridFilterOperator(previousColumnType);
    return current === previousDefault ? resolveDefaultGridFilterOperator(nextColumnType) : current;
};

export const buildGridFieldSelectOptions = (columnNames: string[]) => (
    (columnNames || []).map((columnName) => {
        const text = String(columnName || '');
        return {
            value: text,
            label: text,
            title: text,
        };
    })
);

export const renderGridFieldSelectOption = (option: { label?: React.ReactNode; value?: unknown; title?: unknown }) => {
    const text = String(option?.title ?? option?.label ?? option?.value ?? '');
    return (
        <span title={text} style={FILTER_FIELD_OPTION_STYLE}>
            {text}
        </span>
    );
};
