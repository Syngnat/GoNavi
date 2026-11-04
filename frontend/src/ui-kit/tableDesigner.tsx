import React, { useMemo, useRef } from 'react';
import { Button, Checkbox, Input, Select, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { GonaviCodeEditor, GonaviEmptyState } from './components';

export type GonaviSqlDialect = 'mysql' | 'postgres' | 'sqlite' | 'sqlserver' | 'oracle';

export interface GonaviTableColumn {
  id: string;
  name: string;
  type: string;
  /** Length/precision text, e.g. `255` or `10,2`. */
  length?: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue?: string;
  comment?: string;
}

export interface GonaviTableDesign {
  name: string;
  columns: GonaviTableColumn[];
}

export const GONAVI_COLUMN_TYPES: Record<GonaviSqlDialect, readonly string[]> = {
  mysql: ['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'DECIMAL', 'FLOAT', 'DOUBLE', 'VARCHAR', 'CHAR', 'TEXT', 'LONGTEXT', 'DATE', 'DATETIME', 'TIMESTAMP', 'BOOLEAN', 'JSON', 'BLOB'],
  postgres: ['INTEGER', 'BIGINT', 'SMALLINT', 'NUMERIC', 'REAL', 'DOUBLE PRECISION', 'VARCHAR', 'CHAR', 'TEXT', 'DATE', 'TIMESTAMP', 'TIMESTAMPTZ', 'BOOLEAN', 'JSONB', 'BYTEA', 'UUID'],
  sqlite: ['INTEGER', 'REAL', 'NUMERIC', 'TEXT', 'BLOB'],
  sqlserver: ['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'DECIMAL', 'FLOAT', 'REAL', 'NVARCHAR', 'NCHAR', 'NTEXT', 'DATE', 'DATETIME2', 'BIT', 'VARBINARY'],
  oracle: ['NUMBER', 'INTEGER', 'FLOAT', 'VARCHAR2', 'NVARCHAR2', 'CHAR', 'CLOB', 'DATE', 'TIMESTAMP', 'BLOB', 'RAW'],
};

const IDENTIFIER_QUOTES: Record<GonaviSqlDialect, readonly [string, string]> = {
  mysql: ['`', '`'],
  postgres: ['"', '"'],
  sqlite: ['"', '"'],
  sqlserver: ['[', ']'],
  oracle: ['"', '"'],
};

export function gonaviQuoteIdentifier(name: string, dialect: GonaviSqlDialect): string {
  const [open, close] = IDENTIFIER_QUOTES[dialect] ?? IDENTIFIER_QUOTES.mysql;
  return open + name.split(close).join(close + close) + close;
}

function gonaviSqlLiteral(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^(null|true|false|current_timestamp|current_date|current_time|now\(\))$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  return `'${trimmed.split("'").join("''")}'`;
}

/**
 * Builds a CREATE TABLE statement from the current design. It is pure text:
 * the component never executes it, and the plugin decides whether to show,
 * copy or apply it through `host.schema.write`.
 */
export function buildGonaviCreateTableDdl(design: GonaviTableDesign, dialect: GonaviSqlDialect = 'mysql'): string {
  const table = design.name.trim();
  if (!table) return '';
  const lines: string[] = [];
  const primary: string[] = [];
  for (const column of design.columns) {
    const name = column.name.trim();
    if (!name) continue;
    let line = `  ${gonaviQuoteIdentifier(name, dialect)} ${(column.type || GONAVI_COLUMN_TYPES[dialect][0])}`;
    const length = (column.length ?? '').trim();
    if (length) line += `(${length})`;
    line += column.nullable ? ' NULL' : ' NOT NULL';
    const fallback = gonaviSqlLiteral(column.defaultValue ?? '');
    if (fallback) line += ` DEFAULT ${fallback}`;
    if (dialect === 'mysql' && column.comment?.trim()) {
      line += ` COMMENT ${gonaviSqlLiteral(column.comment)}`;
    }
    if (column.primaryKey) primary.push(gonaviQuoteIdentifier(name, dialect));
    lines.push(line);
  }
  if (!lines.length) return '';
  if (primary.length) lines.push(`  PRIMARY KEY (${primary.join(', ')})`);
  return `CREATE TABLE ${gonaviQuoteIdentifier(table, dialect)} (\n${lines.join(',\n')}\n);`;
}

export function gonaviNewColumn(id: string): GonaviTableColumn {
  return { id, name: '', type: '', nullable: true, primaryKey: false };
}

export interface GonaviTableDesignerProps {
  value: GonaviTableDesign;
  onChange: (value: GonaviTableDesign) => void;
  dialect?: GonaviSqlDialect;
  readOnly?: boolean;
  previewHeight?: number;
}

/**
 * Controlled CREATE TABLE designer for plugin windows. Columns and DDL preview
 * are owned by the plugin; this component only edits the design and renders the
 * generated statement. No connection is opened and nothing is applied.
 */
export const GonaviTableDesigner: React.FC<GonaviTableDesignerProps> = ({
  value,
  onChange,
  dialect = 'mysql',
  readOnly = false,
  previewHeight = 180,
}) => {
  const nextColumn = useRef(value.columns.length + 1);
  const options = GONAVI_COLUMN_TYPES[dialect];
  const ddl = useMemo(() => buildGonaviCreateTableDdl(value, dialect), [value, dialect]);

  const patchColumn = (id: string, patch: Partial<GonaviTableColumn>) => {
    onChange({ ...value, columns: value.columns.map((column) => (column.id === id ? { ...column, ...patch } : column)) });
  };

  const columns: ColumnsType<GonaviTableColumn> = [
    {
      key: 'name', title: 'Name', width: 160,
      render: (_, column) => (
        <Input size="small" value={column.name} disabled={readOnly}
          onChange={(event) => patchColumn(column.id, { name: event.target.value })} />
      ),
    },
    {
      key: 'type', title: 'Type', width: 150,
      render: (_, column) => (
        <Select size="small" style={{ width: '100%' }} value={column.type || undefined} disabled={readOnly}
          placeholder={options[0]} options={options.map((option) => ({ value: option, label: option }))}
          onChange={(type: string) => patchColumn(column.id, { type })} />
      ),
    },
    {
      key: 'length', title: 'Length', width: 90,
      render: (_, column) => (
        <Input size="small" value={column.length ?? ''} disabled={readOnly} placeholder="255"
          onChange={(event) => patchColumn(column.id, { length: event.target.value })} />
      ),
    },
    {
      key: 'nullable', title: 'Null', width: 60, align: 'center',
      render: (_, column) => (
        <Checkbox checked={column.nullable} disabled={readOnly}
          onChange={(event) => patchColumn(column.id, { nullable: event.target.checked })} />
      ),
    },
    {
      key: 'primaryKey', title: 'PK', width: 50, align: 'center',
      render: (_, column) => (
        <Checkbox checked={column.primaryKey} disabled={readOnly}
          onChange={(event) => patchColumn(column.id, { primaryKey: event.target.checked })} />
      ),
    },
    {
      key: 'defaultValue', title: 'Default', width: 140,
      render: (_, column) => (
        <Input size="small" value={column.defaultValue ?? ''} disabled={readOnly}
          onChange={(event) => patchColumn(column.id, { defaultValue: event.target.value })} />
      ),
    },
    {
      key: 'comment', title: 'Comment', width: 160,
      render: (_, column) => (
        <Input size="small" value={column.comment ?? ''} disabled={readOnly}
          onChange={(event) => patchColumn(column.id, { comment: event.target.value })} />
      ),
    },
    {
      key: 'actions', title: '', width: 56, align: 'center',
      render: (_, column) => (
        <Button size="small" type="text" danger disabled={readOnly}
          onClick={() => onChange({ ...value, columns: value.columns.filter((item) => item.id !== column.id) })}>
          ✕
        </Button>
      ),
    },
  ];

  return (
    <div className="gonavi-table-designer">
      <div className="gonavi-table-designer-head">
        <Input
          addonBefore="Table"
          value={value.name}
          disabled={readOnly}
          placeholder="table_name"
          onChange={(event) => onChange({ ...value, name: event.target.value })}
        />
        <Button
          disabled={readOnly}
          onClick={() => {
            const id = `column-${nextColumn.current++}`;
            onChange({ ...value, columns: [...value.columns, gonaviNewColumn(id)] });
          }}
        >
          Add column
        </Button>
      </div>
      {value.columns.length === 0 ? (
        <GonaviEmptyState title="No columns" />
      ) : (
        <Table<GonaviTableColumn>
          size="small"
          bordered={false}
          columns={columns}
          dataSource={value.columns}
          rowKey={(column) => column.id}
          pagination={false}
          scroll={{ x: 'max-content' }}
        />
      )}
      <div className="gonavi-table-designer-preview">
        <GonaviCodeEditor language="sql" value={ddl} onChange={() => undefined} height={previewHeight} readOnly />
      </div>
    </div>
  );
};
