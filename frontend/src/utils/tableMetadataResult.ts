type TableMetadataResult = {
  partial?: boolean;
  truncated?: boolean;
  message?: unknown;
  warnings?: unknown;
};

export const isTableMetadataIncomplete = (result: TableMetadataResult): boolean =>
  Boolean(result.partial || result.truncated);

export const getTableMetadataIssueDetail = (result: TableMetadataResult): string => {
  const message = String(result.message || '').trim();
  if (message) return message;

  if (Array.isArray(result.warnings)) {
    const warning = result.warnings
      .map((item) => String(item || '').trim())
      .find(Boolean);
    if (warning) return warning;
  }

  return '';
};
