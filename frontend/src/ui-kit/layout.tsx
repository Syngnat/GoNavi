import React, { useEffect, useRef, type ReactNode } from 'react';

export interface GonaviSectionProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/** A compact page section with an optional description and toolbar. */
export const GonaviSection: React.FC<GonaviSectionProps> = ({
  title,
  description,
  actions,
  children,
  className,
}) => (
  <section className={['gonavi-section', className].filter(Boolean).join(' ')}>
    {(title || actions) && (
      <header className="gonavi-section-header">
        <div>
          {title && <h3 className="gonavi-section-title">{title}</h3>}
          {description && <p className="gonavi-section-description">{description}</p>}
        </div>
        {actions && <div className="gonavi-section-actions">{actions}</div>}
      </header>
    )}
    {children}
  </section>
);

export interface GonaviStatCardProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  className?: string;
}

/** One metric tile for dashboards and connection summaries. */
export const GonaviStatCard: React.FC<GonaviStatCardProps> = ({
  label,
  value,
  hint,
  tone = 'default',
  className,
}) => (
  <div className={['gonavi-stat', `gonavi-stat-${tone}`, className].filter(Boolean).join(' ')}>
    <div className="gonavi-stat-label">{label}</div>
    <div className="gonavi-stat-value">{value}</div>
    {hint && <div className="gonavi-stat-hint">{hint}</div>}
  </div>
);

export interface GonaviDescriptionItem {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
}

export interface GonaviDescriptionListProps {
  items: GonaviDescriptionItem[];
  columns?: 1 | 2;
  className?: string;
}

/** Read-only key/value metadata list; values are rendered as text by callers. */
export const GonaviDescriptionList: React.FC<GonaviDescriptionListProps> = ({
  items,
  columns = 2,
  className,
}) => (
  <dl className={['gonavi-description-list', `gonavi-description-columns-${columns}`, className].filter(Boolean).join(' ')}>
    {items.map((item, index) => (
      <div className="gonavi-description-item" key={index}>
        <dt>{item.label}</dt>
        <dd className={item.mono ? 'gonavi-mono' : undefined}>{item.value}</dd>
      </div>
    ))}
  </dl>
);

export interface GonaviStatusBarProps {
  left?: ReactNode;
  right?: ReactNode;
  className?: string;
}

/** Bottom status strip for connection, row count and elapsed time. */
export const GonaviStatusBar: React.FC<GonaviStatusBarProps> = ({ left, right, className }) => (
  <footer className={['gonavi-status-bar', className].filter(Boolean).join(' ')}>
    <div className="gonavi-status-left">{left}</div>
    <div className="gonavi-status-right">{right}</div>
  </footer>
);

export interface GonaviLogViewProps {
  lines: string[];
  height?: number;
  autoScroll?: boolean;
  emptyText?: ReactNode;
  className?: string;
}

/** Bounded, text-only log pane; it never interprets log lines as HTML. */
export const GonaviLogView: React.FC<GonaviLogViewProps> = ({
  lines,
  height = 200,
  autoScroll = true,
  emptyText = 'No output',
  className,
}) => {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!autoScroll || !ref.current) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [autoScroll, lines.length]);
  return (
    <pre ref={ref} className={['gonavi-log-view', className].filter(Boolean).join(' ')} style={{ height }}>
      {lines.length ? lines.join('\n') : String(emptyText)}
    </pre>
  );
};
