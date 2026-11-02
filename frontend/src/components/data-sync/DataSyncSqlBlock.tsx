import { useMemo } from 'react';

import { tokenizeSql } from './dataSyncSqlHighlight';

type Props = { sql: string };

/**
 * 只读 SQL 代码块，带轻量语法高亮。
 *
 * 用 React 文本节点渲染 token，不走 innerHTML：表名与注释来自数据库，
 * 属于不可信内容，拼接 HTML 会把它们当成标记执行。
 */
export function DataSyncSqlBlock({ sql }: Props) {
  const tokens = useMemo(() => tokenizeSql(sql), [sql]);
  return (
    <pre className="gn-data-sync-sql-block" data-data-sync-sql-block="true">
      {tokens.map((token, index) => (
        token.kind === 'plain'
          ? <span key={index}>{token.text}</span>
          : (
            <span key={index} className="gn-data-sync-sql-token" data-token={token.kind}>
              {token.text}
            </span>
          )
      ))}
    </pre>
  );
}
