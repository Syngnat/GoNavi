import { t } from '../i18n';
import { hiveProjectionPath, hiveProjectionTokens, isHiveProjectionIdentifier, splitHiveProjectionItems, type HiveProjectionToken } from './hiveProjectionSqlScan';

export type HiveResultProjection = { sourceName: string; outputLabel: string; sourceReference?: readonly string[] };
type SelectOutput = { name?: string; reference?: string; sourceReference?: readonly string[]; wildcard?: boolean };
type HiveProjectionShape = { outputs: SelectOutput[]; prefixes: string[] };
const lower = (name: string): string => name.toLowerCase();
const ambiguous = (): never => { throw new Error(t('hive.pagination.ambiguousColumns')); };
const quote = (name: string): string => '\x60' + name.replace(/\x60/g, '\x60\x60') + '\x60';
const CLAUSES = new Set(['where', 'group', 'having', 'order', 'limit', 'sort', 'distribute', 'cluster', 'window', 'qualify']);
const RESERVED_ALIASES = new Set(['as', 'join', 'left', 'right', 'inner', 'outer', 'cross', 'full', 'lateral', 'union', 'intersect', 'except']);

const selectOutput = (original: HiveProjectionToken[]): SelectOutput => {
  const tokens = original[0]?.kind === 'word' && lower(original[0].value) === 'distinct' ? original.slice(1) : original;
  const last = tokens[tokens.length - 1];
  if (last?.raw === '*') return { wildcard: true };
  if (isHiveProjectionIdentifier(last)) {
    const previous = tokens[tokens.length - 2];
    if (previous?.kind === 'word' && lower(previous.value) === 'as') return { name: last.value };
    const expression = tokens.slice(0, -1);
    if (previous && previous.end < last.start && (hiveProjectionPath(expression) || previous.raw === ')')
      && !RESERVED_ALIASES.has(lower(last.value))) return { name: last.value };
  }
  const path = hiveProjectionPath(tokens);
  return path ? { name: path[path.length - 1], reference: path.join('.'), sourceReference: path.length > 1 ? path : undefined } : {};
};

const singleSourcePrefixes = (tokens: HiveProjectionToken[]): string[] => {
  if (!tokens.length || tokens.some(token => token.kind === 'word' && ['union', 'intersect', 'except'].includes(lower(token.value)))) return [];
  const clause = tokens.findIndex(token => token.kind === 'word' && CLAUSES.has(lower(token.value)));
  const source = clause < 0 ? tokens : tokens.slice(0, clause);
  let length = 1;
  while (source[length]?.raw === '.' && isHiveProjectionIdentifier(source[length + 1])) length += 2;
  const path = hiveProjectionPath(source.slice(0, length));
  if (!path) return [];
  const tail = source.slice(length);
  const alias = tail[0]?.kind === 'word' && lower(tail[0].value) === 'as' ? tail.slice(1) : tail;
  if (alias.length > 1 || (alias.length === 1 && (!isHiveProjectionIdentifier(alias[0]) || RESERVED_ALIASES.has(lower(alias[0].value))))) return [];
  return [...new Set([path.join('.'), path[path.length - 1], ...(alias.length ? [alias[0].value] : [])])];
};

const projectionShape = (sql: string): HiveProjectionShape => {
  const tokens = hiveProjectionTokens(sql);
  if (tokens[0]?.kind !== 'word' || lower(tokens[0].value) !== 'select') return ambiguous();
  const from = tokens.findIndex(token => token.kind === 'word' && lower(token.value) === 'from');
  const outputs = splitHiveProjectionItems(tokens.slice(1, from < 0 ? undefined : from)).map(selectOutput);
  const names = outputs.flatMap(output => output.name ? [lower(output.name)] : []);
  if (new Set(names).size !== names.length) return ambiguous();
  const prefixes = from < 0 ? [] : singleSourcePrefixes(tokens.slice(from + 1));
  if (outputs.some(output => output.wildcard) && !prefixes.length) return ambiguous();
  return { outputs, prefixes };
};

// Metadata raw labels are not SQL column paths. Only original SELECT names,
// explicit aliases and one proven FROM source may establish a derived name.
export const resolveHiveResultProjection = (sql: string, labels: readonly string[]): HiveResultProjection[] => {
  if (!labels.length) throw new Error(t('hive.pagination.columnsRequired'));
  const shape = projectionShape(sql);
  const wildcard = shape.outputs.some(output => output.wildcard);
  const result = labels.map(outputLabel => {
    if (!outputLabel.trim()) return ambiguous();
    const exact = shape.outputs.find(output => output.name && lower(output.name) === lower(outputLabel));
    if (exact?.name) return { sourceName: exact.name, outputLabel };
    const candidates = new Map(shape.outputs.filter(output => output.reference && lower(output.reference) === lower(outputLabel)).map(output => [lower(output.name!), output.name!]));
    for (const prefix of shape.prefixes) {
      if (lower(outputLabel).startsWith(lower(prefix) + '.')) {
        const name = outputLabel.slice(prefix.length + 1);
        const known = shape.outputs.find(output => output.name && lower(output.name) === lower(name));
        if (name && (wildcard || known)) candidates.set(lower(name), known?.name || name);
      }
    }
    if (candidates.size === 1) return { sourceName: [...candidates.values()][0], outputLabel };
    if (!candidates.size && /^[a-z_][a-z0-9_$]*$/i.test(outputLabel)) return { sourceName: outputLabel, outputLabel };
    return ambiguous();
  });
  if (new Set(result.map(item => lower(item.sourceName))).size !== result.length || new Set(result.map(item => lower(item.outputLabel))).size !== result.length) return ambiguous();
  return result.map(item => {
    const sourceReference = shape.outputs.find(output => output.name && lower(output.name) === lower(item.sourceName))?.sourceReference;
    return sourceReference ? { ...item, sourceReference } : item;
  });
};

export const assertHiveCountProjection = (sql: string): void => { projectionShape(sql); };

export const rewriteHiveResultOrder = (orderBy: string, projection: HiveResultProjection[]): string => {
  if (!orderBy.trim()) return '';
  const tokens = hiveProjectionTokens(orderBy);
  if (lower(tokens[0]?.value || '') !== 'order' || lower(tokens[1]?.value || '') !== 'by') return ambiguous();
  const terms = splitHiveProjectionItems(tokens.slice(2)).map(term => {
    const modifier = term.findIndex(token => token.kind === 'word' && ['asc', 'desc', 'nulls'].includes(lower(token.value)));
    const referenceTokens = modifier < 0 ? term : term.slice(0, modifier);
    const suffix = modifier < 0 ? '' : orderBy.slice(term[modifier].start, term[term.length - 1].end);
    if (suffix && !/^(?:asc|desc)?(?:\s*nulls\s+(?:first|last))?$/i.test(suffix)) return ambiguous();
    const raw = orderBy.slice(referenceTokens[0]?.start, referenceTokens[referenceTokens.length - 1]?.end);
    const path = hiveProjectionPath(referenceTokens);
    const name = path?.join('.');
    const ordinal = /^\d+$/.test(raw) ? projection[Number(raw) - 1] : undefined;
    const matches = ordinal ? [ordinal] : projection.filter(item => name && (lower(item.outputLabel) === lower(name) || lower(item.sourceName) === lower(name)
      || (path && item.sourceReference && item.sourceReference.length === path.length && item.sourceReference.every((part, index) => lower(part) === lower(path[index])))));
    if (matches.length !== 1) return ambiguous();
    const source = matches[0].sourceName;
    const reference = !ordinal && path?.length === 1 && lower(name!) === lower(source) ? raw : quote(source);
    return reference + (suffix ? ' ' + suffix : '');
  });
  return ' ORDER BY ' + terms.join(', ');
};
