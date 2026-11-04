import React, { useMemo } from 'react';
import { GonaviSqlEditor } from './components';
import { GonaviResultGrid } from './data';

export interface GonaviQueryColumn {
  name: string;
  type?: string;
}

/** The shape `query.read` returns; plugins may also build it themselves. */
export interface GonaviQueryResult {
  columns: readonly GonaviQueryColumn[];
  rows: readonly (readonly unknown[])[];
}

/**
 * Converts column/row arrays into named records. Duplicate column names get a
 * stable suffix so a result is never silently overwritten.
 */
export function gonaviResultRecords(result: GonaviQueryResult | undefined): Record<string, unknown>[] {
  if (!result || !result.columns.length) return [];
  const names: string[] = [];
  const seen = new Map<string, number>();
  for (const column of result.columns) {
    const base = column.name || 'column';
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    names.push(count === 0 ? base : `${base}_${count + 1}`);
  }
  return result.rows.map((row) => {
    const record: Record<string, unknown> = {};
    names.forEach((name, index) => { record[name] = row[index]; });
    return record;
  });
}

export interface GonaviQueryWorkbenchProps {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  result?: GonaviQueryResult;
  running?: boolean;
  editorHeight?: number;
  resultHeight?: number;
  readOnly?: boolean;
  placeholder?: string;
}

/**
 * Read-only query workbench adapter: editor + Run + result grid. Execution is
 * always the plugin's own capability call; the host only contributes layout and
 * the same visual language as the main workbench.
 */
export const GonaviQueryWorkbench: React.FC<GonaviQueryWorkbenchProps> = ({
  value,
  onChange,
  onRun,
  result,
  running = false,
  editorHeight = 220,
  resultHeight = 320,
  readOnly = false,
  placeholder,
}) => {
  const rows = useMemo(() => gonaviResultRecords(result), [result]);
  return (
    <div className="gonavi-query-workbench">
      <GonaviSqlEditor
        value={value}
        onChange={onChange}
        onRun={onRun}
        height={editorHeight}
        readOnly={readOnly}
        placeholder={placeholder}
      />
      <GonaviResultGrid rows={rows} height={resultHeight} loading={running} emptyText="No result" />
    </div>
  );
};
