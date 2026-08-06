export interface TDengineStableOption {
  label: string;
  value: string;
}

const STABLE_NAME_KEYS = [
  'stable_name',
  'stableName',
  'table_name',
  'Table',
  'name',
  'tablename',
  'table',
] as const;

const readText = (value: unknown): string => {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim();
};

export const resolveTDengineStableName = (row: unknown): string => {
  if (!row || typeof row !== 'object') return '';
  const record = row as Record<string, unknown>;

  for (const key of STABLE_NAME_KEYS) {
    const value = readText(record[key]);
    if (value) return value;
  }

  const normalizedKeys = new Set(STABLE_NAME_KEYS.map((key) => key.toLowerCase()));
  for (const [key, value] of Object.entries(record)) {
    if (!normalizedKeys.has(key.toLowerCase())) continue;
    const text = readText(value);
    if (text) return text;
  }

  return '';
};

export const buildTDengineStableOptions = (rows: unknown[]): TDengineStableOption[] => {
  const seen = new Set<string>();
  const options: TDengineStableOption[] = [];

  for (const row of rows) {
    const name = resolveTDengineStableName(row);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    options.push({ label: name, value: name });
  }

  return options;
};

export const buildTDengineStableQueries = (dbName: string): string[] => {
  const normalized = String(dbName || '').trim();
  if (!normalized) return ['SHOW STABLES'];

  const quoted = normalized.replace(/`/g, '``');
  return [
    'SHOW STABLES',
    `SHOW STABLES FROM \`${quoted}\``,
    `SHOW STABLES FROM ${normalized}`,
    `SHOW ${normalized}.STABLES`,
  ];
};
