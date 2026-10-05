import {
  type BuildAlterTablePreviewInput,
  quoteIdentifierPath,
  quoteIdentifierPart,
  buildStandardColumnDefinition,
  buildColumnCommentSql,
  physicalDefinitionChanged,
  translateSchemaSqlComment,
} from './tableDesignerSchemaSqlColumns';

/**
 * Informix / GBase 8s 的表结构修改：ALTER TABLE t ADD (...) / MODIFY (...) / DROP (...)，改列名是独立语句
 * RENAME COLUMN t.c TO n，主键用 ADD CONSTRAINT PRIMARY KEY；不支持 ADD COLUMN、DROP COLUMN 与 ALTER COLUMN。
 * 删除主键要知道约束名（多为系统生成），设计器只给出注释提示，由用户在 DDL 里按约束名删除。
 */
export const buildInformixAlterPreviewSql = (input: BuildAlterTablePreviewInput, dbType: string): string => {
  const tableRef = quoteIdentifierPath(input.tableName, dbType);
  const statements: string[] = [];

  const dropped = input.originalColumns.filter((orig) => !input.columns.some((col) => col._key === orig._key));
  if (dropped.length > 0) {
    statements.push(`ALTER TABLE ${tableRef}\nDROP (${dropped.map((col) => quoteIdentifierPart(col.name, dbType)).join(', ')});`);
  }

  const added: typeof input.columns = [];
  input.columns.forEach((curr) => {
    const orig = input.originalColumns.find((col) => col._key === curr._key);
    if (!orig) {
      added.push(curr);
      return;
    }
    let currentName = orig.name;
    if (curr.name !== orig.name) {
      statements.push(`RENAME COLUMN ${tableRef}.${quoteIdentifierPart(orig.name, dbType)} TO ${quoteIdentifierPart(curr.name, dbType)};`);
      currentName = curr.name;
    }
    if (physicalDefinitionChanged(curr, orig)) {
      statements.push(`ALTER TABLE ${tableRef}\nMODIFY (${buildStandardColumnDefinition({ ...curr, name: currentName }, dbType)});`);
    }
    if ((curr.comment || '') !== (orig.comment || '')) {
      statements.push(buildColumnCommentSql(tableRef, currentName, curr.comment || '', dbType));
    }
  });

  if (added.length > 0) {
    statements.push(`ALTER TABLE ${tableRef}\nADD (${added.map((col) => buildStandardColumnDefinition(col, dbType)).join(', ')});`);
    added.filter((col) => String(col.comment || '').trim()).forEach((col) => {
      statements.push(buildColumnCommentSql(tableRef, col.name, col.comment || '', dbType));
    });
  }

  const originalKeys = input.originalColumns.filter((col) => col.key === 'PRI').map((col) => col._key);
  const newKeys = input.columns.filter((col) => col.key === 'PRI').map((col) => col._key);
  const keysChanged = originalKeys.length !== newKeys.length || !originalKeys.every((key) => newKeys.includes(key));
  if (keysChanged) {
    if (originalKeys.length > 0) {
      statements.push(`-- ${translateSchemaSqlComment(input.translate, 'table_designer.sql.informix_drop_primary_key_manual')}`);
    }
    if (newKeys.length > 0) {
      const names = input.columns.filter((col) => col.key === 'PRI').map((col) => quoteIdentifierPart(col.name, dbType)).join(', ');
      statements.push(`ALTER TABLE ${tableRef}\nADD CONSTRAINT PRIMARY KEY (${names});`);
    }
  }
  return statements.join('\n');
};
