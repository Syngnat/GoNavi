import {
  type BuildAlterTablePreviewInput,
  quoteIdentifierPath,
  quoteIdentifierPart,
  buildStandardColumnDefinition,
  buildColumnCommentSql,
  defaultDefinitionChanged,
  formatEnabledDefaultExpression,
  hasDefaultValue,
  translateSchemaSqlComment,
} from './tableDesignerSchemaSqlColumns';

/**
 * Firebird 的表结构修改：ALTER TABLE t ADD c 类型 / DROP c，改名 ALTER COLUMN a TO b，改类型 ALTER COLUMN c TYPE 类型，
 * 默认值 ALTER COLUMN c SET DEFAULT / DROP DEFAULT，可空性 ALTER COLUMN c SET NOT NULL / DROP NOT NULL（3.0 起）。
 * 删除主键要知道约束名（多为系统生成），设计器只给出注释提示。
 */
export const buildFirebirdAlterPreviewSql = (input: BuildAlterTablePreviewInput, dbType: string): string => {
  const tableRef = quoteIdentifierPath(input.tableName, dbType);
  const alter = (action: string) => `ALTER TABLE ${tableRef} ${action};`;
  const statements: string[] = [];

  input.originalColumns
    .filter((orig) => !input.columns.some((col) => col._key === orig._key))
    .forEach((col) => statements.push(alter(`DROP ${quoteIdentifierPart(col.name, dbType)}`)));

  input.columns.forEach((curr) => {
    const orig = input.originalColumns.find((col) => col._key === curr._key);
    if (!orig) {
      statements.push(alter(`ADD ${buildStandardColumnDefinition(curr, dbType)}`));
      if (String(curr.comment || '').trim()) statements.push(buildColumnCommentSql(tableRef, curr.name, curr.comment || '', dbType));
      return;
    }
    const column = quoteIdentifierPart(curr.name, dbType);
    if (curr.name !== orig.name) {
      statements.push(alter(`ALTER COLUMN ${quoteIdentifierPart(orig.name, dbType)} TO ${column}`));
    }
    if (curr.type !== orig.type) {
      statements.push(alter(`ALTER COLUMN ${column} TYPE ${String(curr.type || '').trim()}`));
    }
    if (defaultDefinitionChanged(curr, orig)) {
      statements.push(alter(hasDefaultValue(curr)
        ? `ALTER COLUMN ${column} SET DEFAULT ${formatEnabledDefaultExpression(curr, dbType)}`
        : `ALTER COLUMN ${column} DROP DEFAULT`));
    }
    if (curr.nullable !== orig.nullable) {
      statements.push(alter(`ALTER COLUMN ${column} ${curr.nullable === 'NO' ? 'SET' : 'DROP'} NOT NULL`));
    }
    if ((curr.comment || '') !== (orig.comment || '')) {
      statements.push(buildColumnCommentSql(tableRef, curr.name, curr.comment || '', dbType));
    }
  });

  const originalKeys = input.originalColumns.filter((col) => col.key === 'PRI').map((col) => col._key);
  const newKeys = input.columns.filter((col) => col.key === 'PRI').map((col) => col._key);
  const keysChanged = originalKeys.length !== newKeys.length || !originalKeys.every((key) => newKeys.includes(key));
  if (keysChanged) {
    if (originalKeys.length > 0) {
      statements.push(`-- ${translateSchemaSqlComment(input.translate, 'table_designer.sql.firebird_drop_primary_key_manual')}`);
    }
    if (newKeys.length > 0) {
      const names = input.columns.filter((col) => col.key === 'PRI').map((col) => quoteIdentifierPart(col.name, dbType)).join(', ');
      statements.push(alter(`ADD PRIMARY KEY (${names})`));
    }
  }
  return statements.join('\n');
};
