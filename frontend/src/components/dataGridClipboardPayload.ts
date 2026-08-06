export interface DataGridClipboardPayload {
  plainText: string;
  html?: string;
  csv?: string;
  markdown?: string;
  json?: string;
}

export interface BuildTabularClipboardPayloadInput {
  columns?: string[];
  rows: string[][];
  jsonRows?: Array<Record<string, unknown>>;
}

type ClipboardWriter = Pick<Clipboard, 'write' | 'writeText'>;

type ClipboardDataWriter = Pick<DataTransfer, 'clearData' | 'setData'>;

export interface ClipboardEventLike {
  clipboardData?: ClipboardDataWriter | null;
  preventDefault?: () => void;
}

const normalizeClipboardMatrixCell = (value: unknown): string => (
  value === null || value === undefined ? '' : String(value)
);

const normalizePlainTextMatrixCell = (value: unknown): string => (
  normalizeClipboardMatrixCell(value)
    .replace(/\r\n/g, '\n')
    .replace(/[\t\n\r]+/g, ' ')
);

const escapeHtml = (value: string): string => (
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
);

const escapeCsvCell = (value: string): string => `"${value.replace(/"/g, '""')}"`;

const buildDelimitedText = (rows: string[][], delimiter: string, columns?: string[]): string => {
  const matrix = columns ? [columns, ...rows] : rows;
  return matrix.map((row) => row.map(normalizePlainTextMatrixCell).join(delimiter)).join('\n');
};

const buildCsvText = (rows: string[][], columns?: string[]): string => {
  const matrix = columns ? [columns, ...rows] : rows;
  return matrix.map((row) => row.map((cell) => escapeCsvCell(normalizeClipboardMatrixCell(cell))).join(',')).join('\n');
};

const buildHtmlTable = (rows: string[][], columns?: string[]): string => {
  const header = columns && columns.length > 0
    ? `<thead><tr>${columns.map((column) => `<th>${escapeHtml(normalizeClipboardMatrixCell(column))}</th>`).join('')}</tr></thead>`
    : '';
  const body = rows.map((row) => (
    `<tr>${row.map((cell) => `<td>${escapeHtml(normalizeClipboardMatrixCell(cell))}</td>`).join('')}</tr>`
  )).join('');
  return `<meta charset="utf-8"><table>${header}<tbody>${body}</tbody></table>`;
};

const buildMarkdownText = (rows: string[][], columns?: string[]): string => {
  if (!columns || columns.length === 0) return '';
  const escapeMarkdownCell = (value: string): string => (
    normalizeClipboardMatrixCell(value)
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, ' ')
  );
  const header = `| ${columns.map(escapeMarkdownCell).join(' | ')} |`;
  const separator = `| ${columns.map(() => '---').join(' | ')} |`;
  const lines = rows.map((row) => `| ${row.map(escapeMarkdownCell).join(' | ')} |`);
  return [header, separator, ...lines].join('\n');
};

export const buildTabularClipboardPayload = ({
  columns,
  rows,
  jsonRows,
}: BuildTabularClipboardPayloadInput): DataGridClipboardPayload => ({
  plainText: buildDelimitedText(rows, '\t', columns),
  html: buildHtmlTable(rows, columns),
  csv: buildCsvText(rows, columns),
  markdown: buildMarkdownText(rows, columns) || undefined,
  json: jsonRows ? JSON.stringify(jsonRows, null, 2) : undefined,
});

export const buildTabularClipboardPayloadFromTsv = (
  text: string,
  options: { firstRowIsHeader?: boolean } = {},
): DataGridClipboardPayload => {
  const matrix = text.split('\n').map((line) => line.split('\t'));
  const columns = options.firstRowIsHeader ? matrix[0] || [] : undefined;
  const rows = options.firstRowIsHeader ? matrix.slice(1) : matrix;
  return {
    ...buildTabularClipboardPayload({ columns, rows }),
    plainText: text,
  };
};

export const writeClipboardPayloadToEvent = (
  event: ClipboardEventLike,
  payload: DataGridClipboardPayload,
): boolean => {
  const clipboardData = event.clipboardData;
  if (!clipboardData || !payload.plainText) return false;

  clipboardData.clearData();
  clipboardData.setData('text/plain', payload.plainText);
  if (payload.html) clipboardData.setData('text/html', payload.html);
  if (payload.csv) clipboardData.setData('text/csv', payload.csv);
  if (payload.markdown) clipboardData.setData('text/markdown', payload.markdown);
  if (payload.json) clipboardData.setData('application/json', payload.json);
  event.preventDefault?.();
  return true;
};

const appendClipboardItemPart = (
  parts: Record<string, Blob>,
  type: string,
  value: string | undefined,
  supportsType?: (type: string) => boolean,
) => {
  if (!value) return;
  if (type !== 'text/plain') {
    if (supportsType && !supportsType(type)) return;
    if (!supportsType && type !== 'text/html') return;
  }
  parts[type] = new Blob([value], { type });
};

export const writeClipboardPayload = async (
  payload: DataGridClipboardPayload,
  clipboard: ClipboardWriter | undefined = globalThis.navigator?.clipboard,
): Promise<void> => {
  if (!payload.plainText) return;

  const ClipboardItemConstructor = typeof ClipboardItem === 'undefined' ? null : ClipboardItem;
  if (clipboard?.write && ClipboardItemConstructor) {
    const supportsType = typeof ClipboardItemConstructor.supports === 'function'
      ? ClipboardItemConstructor.supports.bind(ClipboardItemConstructor)
      : undefined;
    const parts: Record<string, Blob> = {};
    appendClipboardItemPart(parts, 'text/plain', payload.plainText, supportsType);
    appendClipboardItemPart(parts, 'text/html', payload.html, supportsType);
    appendClipboardItemPart(parts, 'text/csv', payload.csv, supportsType);
    appendClipboardItemPart(parts, 'text/markdown', payload.markdown, supportsType);
    appendClipboardItemPart(parts, 'application/json', payload.json, supportsType);

    try {
      await clipboard.write([new ClipboardItemConstructor(parts)]);
      return;
    } catch {
      // Fall back to writeText below when WebView support is partial.
    }
  }

  if (clipboard?.writeText) {
    await clipboard.writeText(payload.plainText);
    return;
  }

  throw new Error('Clipboard write is not supported');
};
