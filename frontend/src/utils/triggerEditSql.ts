import { t as translateCatalog, type I18nParams } from '../i18n';
import { isOracleLikeDialect, isPgLikeDialect } from './sqlDialect';

type TriggerEditSqlTranslator = (key: string, params?: I18nParams) => string;

type TriggerEditSqlOptions = {
  dropSql?: string;
  dbType?: string;
  translate?: TriggerEditSqlTranslator;
};

const findLeadingSqlTriviaEnd = (sql: string): number => {
  const text = String(sql || '');
  let offset = 0;
  for (;;) {
    while (offset < text.length && /\s/.test(text[offset] || '')) offset += 1;
    if (text.startsWith('/*', offset)) {
      const end = text.indexOf('*/', offset + 2);
      if (end < 0) return text.length;
      offset = end + 2;
      continue;
    }
    if (text.startsWith('--', offset) || text.startsWith('#', offset)) {
      const end = text.indexOf('\n', offset + (text[offset] === '#' ? 1 : 2));
      if (end < 0) return text.length;
      offset = end + 1;
      continue;
    }
    return offset;
  }
};

const translateTriggerEditCopy = (
  translate: TriggerEditSqlTranslator | undefined,
  key: string,
  params?: I18nParams,
): string => {
  const resolved = (translate || translateCatalog)(key, params);
  return resolved && resolved !== key ? resolved : key;
};

export const ensureSqlStatementTerminator = (sql: string): string => {
  const normalized = String(sql || '').trim();
  if (!normalized) return '';
  return /;\s*$/.test(normalized) ? normalized : `${normalized};`;
};

const buildTriggerEditHeader = (
  triggerName: string,
  options?: TriggerEditSqlOptions,
): string => {
  const normalizedName = String(triggerName || '').trim();
  const hint = String(options?.dropSql || '').trim()
    ? translateTriggerEditCopy(options?.translate, 'trigger_viewer.edit_sql.replace_hint')
    : translateTriggerEditCopy(options?.translate, 'trigger_viewer.edit_sql.compatibility_hint');
  const title = translateTriggerEditCopy(options?.translate, 'trigger_viewer.edit_sql.header', {
    name: normalizedName,
  });
  return `-- ${title}\n-- ${hint}\n`;
};

const normalizeEditableTriggerDefinition = (
  triggerName: string,
  triggerDefinition: string,
  dbType = '',
  translate?: TriggerEditSqlTranslator,
): string => {
  const normalizedName = String(triggerName || '').trim();
  const normalizedDefinition = String(triggerDefinition || '').trim();
  if (!normalizedDefinition) {
    return `-- ${translateTriggerEditCopy(translate, 'trigger_viewer.edit_sql.empty_definition')}`;
  }
  const definitionTriviaEnd = findLeadingSqlTriviaEnd(normalizedDefinition);
  const definitionBody = normalizedDefinition.slice(definitionTriviaEnd);
  if (/^\s*create\s+(?:(?:definer\s*=\s*[^\s]+)\s+)?(?:or\s+(?:replace|alter)\s+)?(?:(?:editionable|noneditionable|constraint)\s+)*trigger\b/i.test(definitionBody)) {
    const normalizedBody = isPgLikeDialect(dbType)
      ? definitionBody.replace(
          /^(\s*CREATE\s+)(?:OR\s+(?:REPLACE|ALTER)\s+)(?=(?:CONSTRAINT\s+)?TRIGGER\b)/i,
          '$1',
        )
      : definitionBody;
    return ensureSqlStatementTerminator(`${normalizedDefinition.slice(0, definitionTriviaEnd)}${normalizedBody}`);
  }
  const createTriggerKeyword = isOracleLikeDialect(dbType)
    ? 'CREATE OR REPLACE TRIGGER'
    : 'CREATE TRIGGER';
  if (/^\s*trigger\b/i.test(normalizedDefinition)) {
    return ensureSqlStatementTerminator(
      normalizedDefinition.replace(/^\s*trigger\b/i, createTriggerKeyword),
    );
  }
  if (/^\s*(?:before|after|instead\s+of)\b/i.test(normalizedDefinition)) {
    return ensureSqlStatementTerminator(`${createTriggerKeyword} ${normalizedName}\n${normalizedDefinition}`);
  }
  return `-- ${translateTriggerEditCopy(translate, 'trigger_viewer.edit_sql.fragment_definition')}\n${ensureSqlStatementTerminator(normalizedDefinition)}`;
};

export const buildEditableTriggerSql = (
  triggerName: string,
  triggerDefinition: string,
  options?: TriggerEditSqlOptions,
): string => {
  const header = buildTriggerEditHeader(triggerName, options);
  const dropSql = String(options?.dropSql || '').trim();
  const createSql = normalizeEditableTriggerDefinition(
    triggerName,
    triggerDefinition,
    options?.dbType,
    options?.translate,
  );
  if (!dropSql) {
    return `${header}${createSql}`;
  }
  return `${header}${ensureSqlStatementTerminator(dropSql)}\n${createSql}`;
};
