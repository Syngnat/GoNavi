import { useEffect, useMemo, useState } from 'react';
import { buildCreateTablePreviewSql } from '../tableDesignerSchemaSqlCreate';
import type { EditableColumnSnapshot } from '../tableDesignerSchemaSqlColumns';
import { resolveSqlDialect } from '../../utils/sqlDialect';
import {
  buildImportTableTypeOptions,
  prepareImportTableColumns,
  resolveImportTableTypeFamily,
  supportsImportTableColumnComment,
  type ImportTableColumnDraft,
  type ImportTableCreatePayload,
  type ImportTableSchemaInference,
} from './importTableTypeMapping';

export interface UseImportTableCreateFormInput {
  open: boolean;
  inference: ImportTableSchemaInference | null;
  dialect: string;
}

const patchColumn = (
  columns: ImportTableColumnDraft[],
  key: string,
  patch: Partial<ImportTableColumnDraft>,
): ImportTableColumnDraft[] => columns.map((column) => (
  column.key === key ? { ...column, ...patch } : column
));

const toEditableColumns = (
  columns: ImportTableColumnDraft[],
  commentsSupported: boolean,
): EditableColumnSnapshot[] => columns.map((column) => ({
  _key: column.key,
  name: column.name,
  type: column.type.trim(),
  nullable: column.primaryKey || !column.nullable ? 'NO' : 'YES',
  default: undefined,
  hasDefault: false,
  extra: '',
  comment: commentsSupported ? column.comment : '',
  key: column.primaryKey ? 'PRI' : '',
}));

export const useImportTableCreateForm = ({
  open,
  inference,
  dialect,
}: UseImportTableCreateFormInput) => {
  const normalizedDialect = useMemo(() => resolveSqlDialect(dialect), [dialect]);
  const [tableName, setTableName] = useState('');
  const [columns, setColumns] = useState<ImportTableColumnDraft[]>([]);
  const [charset, setCharset] = useState('');
  const [collation, setCollation] = useState('');
  const [timeIndexIssue, setTimeIndexIssue] = useState<'tdengine' | 'greptimedb' | null>(null);

  useEffect(() => {
    if (!open || !inference) return;
    const prepared = prepareImportTableColumns(inference, normalizedDialect);
    setTableName(String(inference.tableName || '').trim());
    setColumns(prepared.columns);
    setTimeIndexIssue(
      prepared.greptimeTimestampMissing
        ? 'greptimedb'
        : (normalizedDialect === 'tdengine' && !prepared.tdengineTimestampKey ? 'tdengine' : null),
    );
    setCharset('');
    setCollation('');
  }, [inference, normalizedDialect, open]);

  const typeOptions = useMemo(
    () => buildImportTableTypeOptions(normalizedDialect).map((value) => ({ value })),
    [normalizedDialect],
  );
  const commentsSupported = supportsImportTableColumnComment(normalizedDialect);
  const showMysqlCharacterOptions = resolveImportTableTypeFamily(normalizedDialect) === 'mysql';
  const trimmedTableName = tableName.trim();
  const hasEmptyType = columns.some((column) => !column.type.trim());
  const sqlColumns = useMemo(
    () => toEditableColumns(columns, commentsSupported),
    [columns, commentsSupported],
  );
  const previewSql = useMemo(() => {
    if (!trimmedTableName || sqlColumns.length === 0) return '';
    return buildCreateTablePreviewSql({
      dbType: normalizedDialect,
      tableName: trimmedTableName,
      columns: sqlColumns,
      charset: showMysqlCharacterOptions ? charset.trim() : '',
      collation: showMysqlCharacterOptions ? collation.trim() : '',
    });
  }, [charset, collation, normalizedDialect, showMysqlCharacterOptions, sqlColumns, trimmedTableName]);
  const confirmDisabled = !trimmedTableName
    || columns.length === 0
    || hasEmptyType
    || timeIndexIssue !== null
    || !previewSql;

  const updateType = (key: string, value: string) => {
    setColumns((current) => patchColumn(current, key, { type: value }));
  };
  const updateNullable = (key: string, value: boolean) => {
    setColumns((current) => patchColumn(current, key, { nullable: value }));
  };
  const updatePrimaryKey = (key: string, checked: boolean) => {
    setColumns((current) => patchColumn(current, key, {
      primaryKey: checked,
      ...(checked ? { nullable: false } : {}),
    }));
  };
  const updateComment = (key: string, value: string) => {
    setColumns((current) => patchColumn(current, key, { comment: value }));
  };
  const buildPayload = (): ImportTableCreatePayload | null => {
    if (confirmDisabled) return null;
    return {
      tableName: trimmedTableName,
      sql: previewSql,
      columns: columns.map((column) => column.name),
    };
  };

  return {
    tableName,
    setTableName,
    columns,
    charset,
    setCharset,
    collation,
    setCollation,
    typeOptions,
    commentsSupported,
    showMysqlCharacterOptions,
    trimmedTableName,
    timeIndexIssue,
    hasEmptyType,
    previewSql,
    confirmDisabled,
    updateType,
    updateNullable,
    updatePrimaryKey,
    updateComment,
    buildPayload,
  };
};

export type ImportTableCreateFormApi = ReturnType<typeof useImportTableCreateForm>;
