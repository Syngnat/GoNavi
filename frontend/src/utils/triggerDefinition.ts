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

  const rawTargetName = String(triggerName || '').trim();
  const targetName = String(splitQualifiedNameLast(rawTargetName).objectName || rawTargetName || '').trim();
  if (!targetName) return '';

  const rows = data.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object');
  // Metadata commonly returns a bare trigger name, but a literal name may
  // contain dots. Try the unparsed value first so it is not reduced to its
  // final path segment by the generic qualified-name helper.
  if (rawTargetName && rawTargetName !== targetName) {
    const rawExactMatch = rows.find((row) => getTriggerName(row) === rawTargetName);
    if (rawExactMatch) return getTriggerStatement(rawExactMatch);
  }
  const exactMatch = rows.find((row) => getTriggerName(row) === targetName);
  if (exactMatch) return getTriggerStatement(exactMatch);

  const normalizedTargetName = targetName.toLowerCase();
  const caseInsensitiveMatches = rows.filter(
    (row) => getTriggerName(row).toLowerCase() === normalizedTargetName,
  );
  return caseInsensitiveMatches.length === 1 ? getTriggerStatement(caseInsensitiveMatches[0]) : '';
};
