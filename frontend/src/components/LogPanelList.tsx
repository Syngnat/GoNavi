import React, { useEffect, useRef, useState } from 'react';

import type { SqlLog } from '../store';
import { formatQueryDuration } from '../utils/queryDurationFormat';

const INITIAL_ROWS = 12;
const ROW_PAGE = 20;
const SQL_PREVIEW_CHARS = 600;

interface LogPanelListProps {
  logs: SqlLog[];
  darkMode: boolean;
  mutedColor: string;
  affectedRowsLabel: (count: number) => string;
  padding: string;
  scrollThumb: string;
  scrollThumbHover: string;
}

const previewSql = (sql: string): string => (
  sql.length <= SQL_PREVIEW_CHARS ? sql : `${sql.slice(0, SQL_PREVIEW_CHARS)}…`
);

const LogPanelRow = React.memo(function LogPanelRow({
  log,
  darkMode,
  mutedColor,
  affectedRowsLabel,
}: {
  log: SqlLog;
  darkMode: boolean;
  mutedColor: string;
  affectedRowsLabel: (count: number) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const sql = expanded ? log.sql : previewSql(log.sql);

  return (
    <div className="log-panel-row">
      <span className="log-panel-row-time" style={{ color: mutedColor }}>{new Date(log.timestamp).toLocaleTimeString()}</span>
      <span className={`log-panel-row-status${log.status === 'success' ? ' is-ok' : ' is-err'}`}>
        {log.status === 'success' ? 'OK' : 'ERR'}
      </span>
      <span className="log-panel-row-duration" style={{ color: log.duration > 1000 ? 'orange' : 'inherit' }}>
        {formatQueryDuration(log.duration)}
      </span>
      <div
        className="log-panel-row-sql"
        style={{ fontFamily: 'var(--gn-font-mono)', whiteSpace: 'pre-wrap' }}
        onDoubleClick={log.sql.length > SQL_PREVIEW_CHARS ? () => setExpanded((value) => !value) : undefined}
      >
        {log.category === 'transaction' ? <span className="log-panel-row-tx">TX</span> : null}
        <div style={{ color: darkMode ? '#a6e22e' : '#005cc5' }}>{sql}</div>
        {log.message ? <div className="log-panel-row-message">{log.message}</div> : null}
        {log.affectedRows !== undefined ? (
          <div style={{ color: mutedColor }}>{affectedRowsLabel(log.affectedRows)}</div>
        ) : null}
      </div>
    </div>
  );
});

/** 打开和切换标签时只画最近一页日志，避免上百条长 SQL 同时排版。 */
export default function LogPanelList({
  logs,
  darkMode,
  mutedColor,
  affectedRowsLabel,
  padding,
  scrollThumb,
  scrollThumbHover,
}: LogPanelListProps) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_ROWS);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const shown = logs.slice(0, visibleCount);

  useEffect(() => {
    setVisibleCount(INITIAL_ROWS);
  }, [logs]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || shown.length >= logs.length || typeof IntersectionObserver !== 'function') {
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisibleCount((count) => Math.min(logs.length, count + ROW_PAGE));
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [logs.length, shown.length]);

  return (
    <div
      className="log-panel-scroll"
      style={{
        flex: 1,
        overflow: 'auto',
        padding,
        ['--log-scroll-thumb' as string]: scrollThumb,
        ['--log-scroll-thumb-hover' as string]: scrollThumbHover,
      }}
    >
      {shown.map((log) => (
        <LogPanelRow
          key={log.id}
          log={log}
          darkMode={darkMode}
          mutedColor={mutedColor}
          affectedRowsLabel={affectedRowsLabel}
        />
      ))}
      {shown.length < logs.length ? <div ref={sentinelRef} className="log-panel-row-sentinel" /> : null}
    </div>
  );
}
