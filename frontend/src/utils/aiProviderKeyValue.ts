export interface AIProviderKeyValueRow {
  id: string;
  name: string;
  value: string;
}

export const newKeyValueRow = (): AIProviderKeyValueRow => ({
  id: `row-${Math.random().toString(36).slice(2, 10)}`,
  name: '',
  value: '',
});

export const rowsFromRecord = (record?: Record<string, string>): AIProviderKeyValueRow[] =>
  Object.entries(record || {}).map(([name, value]) => ({
    id: `row-${name}`,
    name,
    value,
  }));

export const recordFromRows = (rows?: AIProviderKeyValueRow[]): Record<string, string> | undefined => {
  const next: Record<string, string> = {};
  (rows || []).forEach((row) => {
    const name = String(row?.name || '').trim();
    if (!name) return;
    next[name] = String(row?.value || '');
  });
  return Object.keys(next).length ? next : undefined;
};
