import { TabData } from '../../types';

export const normalizeMySQLViewDDL = (rawDefinition: unknown): string => {
    const text = String(rawDefinition || '').trim();
    if (!text) return '';

    const normalized = text.replace(/\r\n/g, '\n').trim().replace(/;+\s*$/, '');
    const createViewPrefixPattern = /^\s*create\s+(?:algorithm\s*=\s*\w+\s+)?(?:definer\s*=\s*(?:`[^`]+`|\S+)\s*@\s*(?:`[^`]+`|\S+)\s+)?(?:sql\s+security\s+(?:definer|invoker)\s+)?view\s+/i;
    if (createViewPrefixPattern.test(normalized)) {
        return `${normalized.replace(createViewPrefixPattern, 'CREATE OR REPLACE VIEW ')};`;
    }

    if (/^\s*(select|with)\b/i.test(normalized)) {
        return normalized;
    }

    return `${normalized};`;
};

const normalizeSqlPlusSlashTerminator = (sql: string): string => (
    String(sql || '').trim().replace(/(^|\n)([ \t]*\/[ \t]*);+([ \t]*(?:--[^\n]*)?)\s*$/i, '$1$2$3')
);

const hasStandaloneSqlPlusSlashTerminator = (sql: string): boolean => (
    /(?:^|\n)[ \t]*\/[ \t]*(?:--[^\n]*)?\s*$/i.test(String(sql || '').trim())
);

const ensureSqlStatementTerminator = (sql: string): string => {
    const normalized = normalizeSqlPlusSlashTerminator(sql);
    if (!normalized) return '';
    if (hasStandaloneSqlPlusSlashTerminator(normalized)) return normalized;
    return /;\s*$/.test(normalized) ? normalized : `${normalized};`;
};

const isCommentOnlyDefinition = (definition: string): boolean => {
    const normalized = String(definition || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) return false;
    const lines = normalized
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    return lines.length > 0 && lines.every((line) => line.startsWith('--'));
};

const withCreateOrReplacePackageHeaders = (definition: string): string => {
    const normalized = String(definition || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) return '';
    return normalized
        .split(/(?=^\s*PACKAGE(?:\s+BODY)?\b)/gim)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => (/^\s*CREATE\b/i.test(part) ? part : `CREATE OR REPLACE ${part}`))
        .join('\n/\n');
};

export const buildEditableDefinitionSql = (
    tab: TabData,
    definition: string,
    objectName: string,
    copy: {
        commentTitle: string;
        compatibilityHint: string;
        emptyDefinitionHint: string;
    },
): string => {
    const normalizedDefinition = String(definition || '').trim();
    const header = `-- ${copy.commentTitle}\n-- ${copy.compatibilityHint}\n`;
    if (!normalizedDefinition) {
        return `${header}-- ${copy.emptyDefinitionHint}\n`;
    }

    if (isCommentOnlyDefinition(normalizedDefinition)) {
        return `${header}${ensureSqlStatementTerminator(normalizedDefinition)}`;
    }

    if (tab.type === 'view-def' && !/^\s*create\b/i.test(normalizedDefinition)) {
        if (/^\s*view\b/i.test(normalizedDefinition)) {
            return `${header}${ensureSqlStatementTerminator(normalizedDefinition.replace(/^\s*view\b/i, 'CREATE OR REPLACE VIEW'))}`;
        }
        return `${header}CREATE OR REPLACE VIEW ${objectName} AS\n${ensureSqlStatementTerminator(normalizedDefinition)}`;
    }

    if (tab.type === 'sequence-def' && !/^\s*create\b/i.test(normalizedDefinition)) {
        return `${header}${ensureSqlStatementTerminator(`CREATE SEQUENCE ${objectName}\n${normalizedDefinition}`)}`;
    }

    if (
        tab.type === 'package-def'
        && !/^\s*create\b/i.test(normalizedDefinition)
        && /^\s*package\b/i.test(normalizedDefinition)
    ) {
        return `${header}${withCreateOrReplacePackageHeaders(normalizedDefinition)}`;
    }

    if (
        tab.type === 'routine-def'
        && !/^\s*create\b/i.test(normalizedDefinition)
        && /^\s*(function|procedure)\b/i.test(normalizedDefinition)
    ) {
        return `${header}${ensureSqlStatementTerminator(`CREATE OR REPLACE ${normalizedDefinition}`)}`;
    }

    return `${header}${ensureSqlStatementTerminator(normalizedDefinition)}`;
};

export const buildDisplayDefinitionSql = (
    tab: TabData,
    definition: string,
    objectName: string,
): string => {
    const normalizedDefinition = String(definition || '').trim();
    if (!normalizedDefinition || isCommentOnlyDefinition(normalizedDefinition)) {
        return normalizedDefinition;
    }

    if (tab.type === 'view-def' && !/^\s*create\b/i.test(normalizedDefinition)) {
        if (/^\s*view\b/i.test(normalizedDefinition)) {
            return ensureSqlStatementTerminator(normalizedDefinition.replace(/^\s*view\b/i, 'CREATE OR REPLACE VIEW'));
        }
        return `CREATE OR REPLACE VIEW ${objectName} AS\n${ensureSqlStatementTerminator(normalizedDefinition)}`;
    }

    if (tab.type === 'sequence-def' && !/^\s*create\b/i.test(normalizedDefinition)) {
        return ensureSqlStatementTerminator(`CREATE SEQUENCE ${objectName}\n${normalizedDefinition}`);
    }

    if (
        tab.type === 'package-def'
        && !/^\s*create\b/i.test(normalizedDefinition)
        && /^\s*package\b/i.test(normalizedDefinition)
    ) {
        return withCreateOrReplacePackageHeaders(normalizedDefinition);
    }

    if (
        tab.type === 'routine-def'
        && !/^\s*create\b/i.test(normalizedDefinition)
        && /^\s*(function|procedure)\b/i.test(normalizedDefinition)
    ) {
        return ensureSqlStatementTerminator(`CREATE OR REPLACE ${normalizedDefinition}`);
    }

    return ensureSqlStatementTerminator(normalizedDefinition);
};
