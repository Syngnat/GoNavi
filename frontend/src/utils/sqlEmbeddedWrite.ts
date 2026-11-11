import {
  isSqlDashLineCommentStart,
  supportsSqlBracketIdentifier,
  supportsSqlEscapedBracketIdentifier,
  supportsSqlHashLineComment,
} from './sqlStatementSelection';

/**
 * SQL 语句边界只读判定绕过修复（issue #1308）的共享词法扫描。
 *
 * 背景：切分器只认分号，分类器只看首个关键字，二者被"语句边界由分号确定"
 * 这一假设绑死。缺分号时边界消失，`SELECT ... ORDER BY id DESC` 之后的
 * `DELETE FROM ...` 会被整体切成一条语句，取首关键字得 select → 判为只读，
 * 于是生产保护、只读保护、托管事务、审计分类、AI/MCP 安全分级全部被绕过，
 * 真实数据被删除且无法恢复。
 *
 * 本模块不修切分器（无分号时边界在语法上确实不存在，强猜会引入更严重的误切），
 * 而是在"首关键字判定为读"之后追加一次单遍词法扫描，确认语句体内不再埋着写语句。
 * 该逻辑必须前后端各模块共用，避免判定漂移。
 */

/**
 * 出现在语句体内即代表存在写操作的关键字。
 *
 * 与 sqlEditorTransaction 的 DML 集合区别在用途：后者回答"这条语句是不是写"，
 * 本集合回答"这段文本里是否还埋着另一条写语句"。因此额外收录 DDL ——
 * 缺分号时 `SELECT ... DROP TABLE x` 同样会被切分器吞成一条只读语句。
 *
 * 收录标准：该关键字不可能作为普通标识符或函数名合法出现在一条只读语句中。
 * 据此排除 `set` / `use` / `call` / `load` 等在大批只读语境中合法出现的词
 * （例如 `SELECT setting FROM t`），宁可漏报也不误杀只读查询。
 * 事务控制词（commit / rollback / savepoint）亦排除：它们由
 * isSqlEditorTransactionControlStatement 单独判定，收进来会让
 * `BEGIN; SELECT 1; COMMIT;` 这类显式事务脚本被误判为写操作。
 * `replace` 排除：SQL Server 的 REPLACE() 是只读字符串函数。
 */
export const SQL_EMBEDDED_WRITE_KEYWORDS = new Set([
  // DML
  // `insert` 不在此集合内：MySQL 的 INSERT(str, pos, len, newstr) 是字符串函数，
  // 常出现在 SELECT 列表里（如 `SELECT INSERT(name, 1, 1, '_') FROM t`），
  // 按关键字匹配会把纯读 SQL 判成写操作。它由
  // SQL_EMBEDDED_INSERT_STATEMENT_PATTERN 单独识别「INSERT 后面不跟左括号」的形态。
  'delete',
  'update',
  'upsert',
  // DDL
  'create',
  'alter',
  'drop',
  'truncate',
  'rename',
  // 权限与数据控制
  'grant',
  'revoke',
]);

const isSqlKeywordChar = (char: string | undefined): boolean => !!char && /[A-Za-z0-9_]/.test(char);

/**
 * 跳过被引号或注释包裹的文本，返回结束位置；未命中时返回 -1。
 *
 * 必须跳过这些区域，否则 `SELECT 'DELETE'`、`SELECT 1 -- DELETE` 这类
 * 只读语句会被误判为写。dollar-quoting 与方括号标识符按方言处理。
 */
export const skipQuotedOrComment = (text: string, start: number, dbType: string): number => {
  if (text.startsWith('--', start) && isSqlDashLineCommentStart(dbType, text.slice(start + 2, start + 3))) {
    const nextLine = text.indexOf('\n', start);
    return nextLine < 0 ? text.length : nextLine + 1;
  }
  if (text.startsWith('#', start) && supportsSqlHashLineComment(dbType)) {
    const nextLine = text.indexOf('\n', start);
    return nextLine < 0 ? text.length : nextLine + 1;
  }
  if (text.startsWith('/*', start)) {
    const blockEnd = text.indexOf('*/', start + 2);
    return blockEnd < 0 ? text.length : blockEnd + 2;
  }

  const char = text[start];
  if (char === "'" || char === '"' || char === '`') {
    let pos = start + 1;
    while (pos < text.length) {
      if (text[pos] === char) {
        if (text[pos + 1] === char) {
          pos += 2;
          continue;
        }
        return pos + 1;
      }
      // 反斜杠转义只对 MySQL 族生效；PostgreSQL 的 standard_conforming_strings
      // 默认开启，`'\'` 即为完整字面量，多跳一格反而会吃掉后续内容。
      if (text[pos] === '\\' && char === "'" && supportsSqlHashLineComment(dbType)) {
        pos += 2;
        continue;
      }
      pos++;
    }
    return text.length;
  }
  if (char === '[' && supportsSqlBracketIdentifier(dbType)) {
    let pos = start + 1;
    while (pos < text.length) {
      if (text[pos] === ']') {
        if (supportsSqlEscapedBracketIdentifier(dbType) && text[pos + 1] === ']') {
          pos += 2;
          continue;
        }
        return pos + 1;
      }
      pos++;
    }
    return text.length;
  }
  // PostgreSQL dollar-quoting（`$$...$$` 或 `$tag$...$tag$`）。
  if (char === '$') {
    let tagEnd = start + 1;
    while (isSqlKeywordChar(text[tagEnd])) {
      tagEnd++;
    }
    if (text[tagEnd] === '$' && (tagEnd === start + 1 || /^[A-Za-z_]/.test(text[start + 1]))) {
      const tag = text.slice(start, tagEnd + 1);
      const dollarEnd = text.indexOf(tag, tagEnd + 1);
      return dollarEnd < 0 ? text.length : dollarEnd + tag.length;
    }
  }
  return -1;
};

/**
 * 判断写关键字是否处于合法只读语境而应予豁免。
 *
 * 仅 `SHOW CREATE ...`（MySQL 族表结构查看语句，GoNavi 自身即生成并执行它）
 * 与 `EXPLAIN <任意语句>`（只出计划、不改数据）可豁免。
 *
 * 刻意**不**豁免 `desc` / `describe`：`DESCRIBE t` 之后不可能合法跟随写关键字，
 * 而 `desc` 更常见于 `ORDER BY x DESC` 的排序修饰词 —— 一旦纳入豁免，
 * `SELECT ... ORDER BY id DESC` 后缺分号的 DELETE 会被直接放行，
 * 而该形状正是 issue #1308 事故 SQL 的原文特征。
 */
export const isReadOnlyContextualKeyword = (precedingToken: string): boolean =>
  precedingToken === 'show' || precedingToken === 'explain';

/**
 * 扫描语句体，判断首关键字之外是否还埋着写语句或 DDL。
 *
 * 只做词法级扫描，不构建语法树。调用方需先行确认首关键字为读关键字，
 * 否则会对 `DELETE FROM t` 这类语句立刻返回 true（结论虽正确，但语义重叠）。
 *
 * CTE 体内的写由各模块既有的 WITH 分析负责，故此处遇到 `with` 直接跳过以免重复判定。
 */
export const hasEmbeddedWriteStatement = (statement: string, dbType = ''): boolean =>
  firstEmbeddedWriteKeyword(statement, dbType) !== '';

/**
 * 返回语句体中第一个"内嵌写关键字"（小写），未检出时返回空串。
 *
 * 返回具体关键字而非布尔值，是因为托管事务判定只认 DML 而不认 DDL：
 * 若只返回布尔值，调用方无法区分 `... 期间 DELETE FROM t`（应托管）
 * 与 `CREATE PROCEDURE ... BEGIN`（DDL，不该被托管事务接管）。
 *
 * 调用约束与 hasEmbeddedWriteStatement 相同：调用方需先行确认首关键字为读关键字。
 */
export const firstEmbeddedWriteKeyword = (statement: string, dbType = ''): string => {
  const text = String(statement || '');
  let previousToken = '';
  let previousPreviousToken = '';
  let updateNeedsOfCheck = false;

  for (let index = 0; index < text.length;) {
    const skipped = skipQuotedOrComment(text, index, dbType);
    if (skipped >= 0) {
      index = skipped;
      continue;
    }
    if (!isSqlKeywordChar(text[index])) {
      index++;
      continue;
    }

    const start = index;
    while (index < text.length && isSqlKeywordChar(text[index])) {
      index++;
    }
    const token = text.slice(start, index).toLowerCase();

    // `FOR UPDATE OF` / `FOR NO KEY UPDATE OF`：update 属于只读行锁语法，
    // 仅当后继为 `of` 时豁免，否则 `SELECT ... FOR UPDATE DELETE FROM t`
    // 会漏判其中的 delete。
    if (updateNeedsOfCheck) {
      updateNeedsOfCheck = false;
      if (token === 'of') {
        previousPreviousToken = previousToken;
        previousToken = token;
        continue;
      }
    }

    if (token === 'with') {
      previousPreviousToken = previousToken;
      previousToken = token;
      continue;
    }
    if (
      token === 'update'
      && (previousToken === 'for' || (previousToken === 'key' && previousPreviousToken === 'no'))
    ) {
      // `FOR UPDATE` / `FOR NO KEY UPDATE`：交给下一轮确认后继是否为 `of`。
      updateNeedsOfCheck = true;
      previousPreviousToken = previousToken;
      previousToken = token;
      continue;
    }

    if (
      SQL_EMBEDDED_WRITE_KEYWORDS.has(token) &&
      !isReadOnlyContextualKeyword(previousToken)
    ) {
      return token;
    }

    // `INSERT` 需要区分两种形态：
    //   INSERT INTO t ...        —— 写语句，命中
    //   INSERT(str, 1, 1, '_')   —— MySQL 字符串函数，只读
    // 判据是「其后第一个非空白字符是否为左括号」。
    if (token === 'insert' && !isReadOnlyContextualKeyword(previousToken)) {
      let probe = index;
      while (probe < text.length && /[ \t\r\n]/.test(text[probe])) {
        probe++;
      }
      if (text[probe] !== '(') {
        return token;
      }
    }

    previousPreviousToken = previousToken;
    previousToken = token;
  }
  return '';
};
