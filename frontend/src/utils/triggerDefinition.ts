import { splitQualifiedNameLast } from './qualifiedName';

const getCaseInsensitiveValue = (row: Record<string, unknown>, key: string): unknown => {
  const matchedKey = Object.keys(row).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return matchedKey ? row[matchedKey] : undefined;
};

const getTriggerName = (row: Record<string, unknown>): string => (
  String(getCaseInsensitiveValue(row, 'name') || '').trim()
);

const getTriggerStatement = (row: Record<string, unknown>): string => (
  String(getCaseInsensitiveValue(row, 'statement') || '')
);

export const findTriggerDefinitionStatement = (data: unknown, triggerName: string): string => {
  if (!Array.isArray(data)) return '';

  const targetName = String(splitQualifiedNameLast(triggerName).objectName || triggerName || '').trim();
  if (!targetName) return '';

  const rows = data.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object');
  const exactMatch = rows.find((row) => getTriggerName(row) === targetName);
  if (exactMatch) return getTriggerStatement(exactMatch);

  const normalizedTargetName = targetName.toLowerCase();
  const caseInsensitiveMatches = rows.filter(
    (row) => getTriggerName(row).toLowerCase() === normalizedTargetName,
  );
  return caseInsensitiveMatches.length === 1 ? getTriggerStatement(caseInsensitiveMatches[0]) : '';
};
