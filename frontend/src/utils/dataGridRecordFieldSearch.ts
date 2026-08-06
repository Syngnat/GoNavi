export interface DataGridRecordFieldCandidate {
  fieldName: string;
  comment: string;
  sourceIndex: number;
  matchKind: 'field-exact' | 'field-prefix' | 'field-contains' | 'comment-prefix' | 'comment-contains';
}

export interface DataGridJsonFieldOccurrence {
  start: number;
  end: number;
}

const normalizeSearchText = (value: unknown): string => String(value ?? '').trim().toLocaleLowerCase();

const resolveMatchKind = (
  fieldName: string,
  comment: string,
  query: string,
  includeComments: boolean,
): DataGridRecordFieldCandidate['matchKind'] | null => {
  const normalizedFieldName = normalizeSearchText(fieldName);
  if (normalizedFieldName === query) return 'field-exact';
  if (normalizedFieldName.startsWith(query)) return 'field-prefix';
  if (normalizedFieldName.includes(query)) return 'field-contains';
  if (!includeComments) return null;

  const normalizedComment = normalizeSearchText(comment);
  if (normalizedComment.startsWith(query)) return 'comment-prefix';
  if (normalizedComment.includes(query)) return 'comment-contains';
  return null;
};

const MATCH_KIND_RANK: Record<DataGridRecordFieldCandidate['matchKind'], number> = {
  'field-exact': 0,
  'field-prefix': 1,
  'field-contains': 2,
  'comment-prefix': 3,
  'comment-contains': 4,
};

export const collectDataGridRecordFieldCandidates = ({
  fieldNames,
  commentsByField = {},
  query,
  includeComments = false,
}: {
  fieldNames: string[];
  commentsByField?: Record<string, string>;
  query: unknown;
  includeComments?: boolean;
}): DataGridRecordFieldCandidate[] => {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  return fieldNames
    .map((rawFieldName, sourceIndex) => {
      const fieldName = String(rawFieldName || '').trim();
      if (!fieldName) return null;
      const comment = String(commentsByField[fieldName] || '').trim();
      const matchKind = resolveMatchKind(fieldName, comment, normalizedQuery, includeComments);
      return matchKind ? { fieldName, comment, sourceIndex, matchKind } : null;
    })
    .filter((candidate): candidate is DataGridRecordFieldCandidate => candidate !== null)
    .sort((left, right) => (
      MATCH_KIND_RANK[left.matchKind] - MATCH_KIND_RANK[right.matchKind]
      || left.sourceIndex - right.sourceIndex
    ));
};

export const resolveDataGridRecordFieldTarget = (
  candidates: DataGridRecordFieldCandidate[],
  query: unknown,
): string => {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery || candidates.length === 0) return '';
  const exactMatch = candidates.find((candidate) => (
    normalizeSearchText(candidate.fieldName) === normalizedQuery
  ));
  if (exactMatch) return exactMatch.fieldName;
  return candidates.length === 1 ? candidates[0].fieldName : '';
};

export const findDataGridJsonFieldOccurrences = (
  jsonText: string,
  fieldName: string,
): DataGridJsonFieldOccurrence[] => {
  const normalizedFieldName = String(fieldName || '');
  if (!jsonText || !normalizedFieldName) return [];

  const serializedFieldName = JSON.stringify(normalizedFieldName);
  const linePrefix = `    ${serializedFieldName}:`;
  const occurrences: DataGridJsonFieldOccurrence[] = [];
  let lineStart = 0;

  String(jsonText).split('\n').forEach((line) => {
    if (line.startsWith(linePrefix)) {
      const start = lineStart + 4;
      occurrences.push({ start, end: start + serializedFieldName.length });
    }
    lineStart += line.length + 1;
  });

  return occurrences;
};
