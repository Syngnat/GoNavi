import { ColumnDefinition } from '../../types';
import type { TDengineTagDefinition } from '../tableDesignerSchemaSql';
import type { TableDesignerSchemaExecutionResult } from '../tableDesignerExecutionSql';

export interface EditableColumn extends ColumnDefinition {
    _key: string;
    isNew?: boolean;
    isAutoIncrement?: boolean; // Virtual field for UI
}

export interface IndexDisplayRow {
    key: string;
    name: string;
    indexType: string;
    nonUnique: number;
    columnNames: string[];
}

export interface ForeignKeyDisplayRow {
    key: string;
    name: string;
    constraintName: string;
    refTableName: string;
    columnNames: string[];
    refColumnNames: string[];
}

export type IndexKind = 'NORMAL' | 'UNIQUE' | 'PRIMARY' | 'FULLTEXT' | 'SPATIAL';

export interface IndexFormState {
    name: string;
    columnNames: string[];
    kind: IndexKind;
    indexType: string;
}

export interface TDengineTagDraft extends TDengineTagDefinition {
    _key: string;
}

export interface ForeignKeyFormState {
    constraintName: string;
    columnNames: string[];
    refTableName: string;
    refColumnNames: string[];
}

export interface SchemaExecutionResult extends TableDesignerSchemaExecutionResult {
    cancelled?: boolean;
    rawMessage?: string;
}

export interface SchemaExecutionOptions {
    skipProductionRiskConfirm?: boolean;
    splitStatements?: boolean;
}
