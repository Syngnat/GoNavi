/**
 * IRIS / Caché 的标识符引用规则。
 *
 * 与 PostgreSQL 的根本差异：IRIS 的双引号只在服务端开启 DelimitedIds 时才是标识符
 * 定界符；关闭时（默认配置 DelimitedIds=0）双引号是字符串字面量，`FROM "BDA_Store"`
 * 会被解析成 `IDENTIFIER expected, LITERAL ('BDA_Store') found` 而不是表名 —— 这正是
 * IRIS/Ensemble 连接下双击表预览报错的根因。
 *
 * 实测（IRIS 2026.1.0.234.1 与 Caché 2018.1）：
 * - 未定界的裸名在 DelimitedIds 开 / 关两种服务端配置下都能解析；
 * - 未定界标识符大小写不敏感，`CaseC.MixCase` 建的表用 `CASEC.MIXCASE` 照样命中；
 * - 标识符不允许含 `.`（`"has.space"` 即使开启定界也报 invalid character）。
 *
 * 因此这里只在「无法裸写」时加引号，不像 PostgreSQL 那样因大小写折叠给含大写的名字
 * 一律加引号 —— 那样反而会在 DelimitedIds 关闭的服务端上把表名解析成字符串。
 */

// 保留字来自 IRIS 2026.1 的 $SYSTEM.SQL.IsReservedWord 实测（198 个）。
// ORDER / VALUE / INDEX / KEY / NAME / STATUS / TYPE 等都不是 IRIS 保留字，可裸写。
// TOP 不在该 API 清单内，但它是 IRIS 的行数限定关键字，按保留字处理。
const IRIS_RESERVED_WORDS = new Set([
  'absolute', 'add', 'all', 'allocate', 'alter', 'and', 'any', 'are', 'as', 'asc',
  'assertion', 'at', 'avg', 'begin', 'between', 'bit', 'bit_length', 'both', 'by',
  'cascade', 'case', 'cast', 'char', 'character', 'char_length', 'check', 'close',
  'coalesce', 'collate', 'commit', 'connect', 'connection', 'constraint', 'constraints',
  'continue', 'convert', 'count', 'create', 'cross', 'current', 'current_date',
  'current_time', 'current_timestamp', 'current_user', 'cursor', 'date', 'deallocate',
  'dec', 'decimal', 'declare', 'default', 'deferrable', 'delete', 'desc', 'describe',
  'descriptor', 'diagnostics', 'disconnect', 'distinct', 'domain', 'double', 'drop',
  'else', 'end', 'escape', 'except', 'exception', 'exec', 'execute', 'exists',
  'external', 'extract', 'false', 'fetch', 'first', 'float', 'for', 'foreign', 'found',
  'from', 'full', 'get', 'global', 'go', 'goto', 'grant', 'group', 'having', 'hour',
  'identity', 'immediate', 'in', 'indicator', 'initially', 'inner', 'input',
  'insensitive', 'insert', 'int', 'integer', 'intersect', 'interval', 'into', 'is',
  'isolation', 'join', 'language', 'last', 'leading', 'left', 'level', 'like', 'local',
  'lower', 'match', 'max', 'min', 'minute', 'module', 'names', 'national', 'natural',
  'nchar', 'next', 'no', 'not', 'null', 'nullif', 'numeric', 'octet_length', 'of',
  'on', 'only', 'open', 'option', 'or', 'outer', 'output', 'overlaps', 'pad',
  'partial', 'prepare', 'preserve', 'primary', 'prior', 'privileges', 'procedure',
  'public', 'read', 'real', 'references', 'relative', 'restrict', 'revoke', 'right',
  'rollback', 'rows', 'schema', 'scroll', 'second', 'section', 'select', 'session_user',
  'set', 'smallint', 'some', 'space', 'sqlerror', 'sqlstate', 'substring', 'sum',
  'sysdate', 'system_user', 'table', 'temporary', 'then', 'time', 'timezone_hour',
  'to', 'top', 'trailing', 'transaction', 'trim', 'true', 'union', 'unique', 'update',
  'upper', 'user', 'using', 'values', 'varchar', 'varying', 'when', 'whenever',
  'where', 'with', 'work', 'write',
]);

// 裸标识符可用的字符集：字母或下划线或 % 开头，后接字母、数字、下划线。
// `%` 开头是 IRIS 的系统投影约定（%ID、%VID 等），裸写可用。
const IRIS_BARE_IDENT = /^[A-Za-z_%][A-Za-z0-9_]*$/;

/** 把 IRIS/Caché 标识符按「能裸写就裸写，否则加双引号」转换。 */
export const quoteInterSystemsIdent = (ident: string): string => {
  const raw = String(ident || '').trim().replace(/^"(.*)"$/s, '$1').replace(/""/g, '"');
  if (!raw) return '';
  if (IRIS_BARE_IDENT.test(raw) && !IRIS_RESERVED_WORDS.has(raw.toLowerCase())) {
    return raw;
  }
  return `"${raw.replace(/"/g, '""')}"`;
};
