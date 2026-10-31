import React, { type ReactNode } from 'react';
import { Alert, Button, Empty, Input, Space, Spin, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { TablePaginationConfig } from 'antd';

export interface GonaviPanelProps {
  title?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}

/** A workbench-style panel with a compact header and a scrollable body. */
export const GonaviPanel: React.FC<GonaviPanelProps> = ({
  title,
  actions,
  children,
  className,
  bodyClassName,
}) => (
  <section className={['gonavi-panel', className].filter(Boolean).join(' ')}>
    {(title || actions) && (
      <header className="gonavi-panel-header">
        <div className="gonavi-panel-title">{title}</div>
        {actions && <div className="gonavi-panel-actions">{actions}</div>}
      </header>
    )}
    <div className={['gonavi-panel-body', bodyClassName].filter(Boolean).join(' ')}>{children}</div>
  </section>
);

export interface GonaviToolbarProps {
  children?: ReactNode;
  className?: string;
}

export const GonaviToolbar: React.FC<GonaviToolbarProps> = ({ children, className }) => (
  <div className={['gonavi-toolbar', className].filter(Boolean).join(' ')}>{children}</div>
);

export interface GonaviEmptyStateProps {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export const GonaviEmptyState: React.FC<GonaviEmptyStateProps> = ({ title, description, action }) => (
  <div className="gonavi-state">
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={(
        <Space direction="vertical" size={2}>
          {title && <Typography.Text strong>{title}</Typography.Text>}
          {description && <Typography.Text type="secondary">{description}</Typography.Text>}
        </Space>
      )}
    >
      {action}
    </Empty>
  </div>
);

export const GonaviLoadingState: React.FC<{ label?: ReactNode }> = ({ label }) => (
  <div className="gonavi-state" role="status" aria-live="polite">
    <Spin />
    {label && <Typography.Text type="secondary">{label}</Typography.Text>}
  </div>
);

export interface GonaviErrorStateProps {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export const GonaviErrorState: React.FC<GonaviErrorStateProps> = ({ title, description, action }) => (
  <div className="gonavi-state">
    <Alert
      type="error"
      showIcon
      message={title}
      description={description}
      action={action}
    />
  </div>
);

export interface GonaviDataTableProps<Row extends object> {
  columns: ColumnsType<Row>;
  rows: Row[];
  rowKey?: string | ((row: Row) => React.Key);
  height?: number;
  loading?: boolean;
  emptyText?: ReactNode;
  pagination?: TablePaginationConfig | false;
}

/**
 * Read-only result grid. Editing stays a host surface in this first slice; the
 * component deliberately accepts plain rows and columns so a plugin can use it
 * with capability results without importing the host DataGrid store.
 */
export function GonaviDataTable<Row extends object>({
  columns,
  rows,
  rowKey = 'key',
  height = 360,
  loading,
  emptyText,
  pagination = false,
}: GonaviDataTableProps<Row>) {
  return (
    <Table<Row>
      className="gonavi-data-table"
      size="small"
      bordered={false}
      columns={columns}
      dataSource={rows}
      rowKey={rowKey as never}
      loading={loading}
      pagination={pagination}
      scroll={{ x: 'max-content', y: height }}
      locale={{ emptyText: emptyText ?? <GonaviEmptyState /> }}
    />
  );
}

export interface GonaviCodeEditorProps {
  value?: string;
  onChange?: (value: string) => void;
  language?: 'sql' | 'json' | 'javascript' | 'text';
  height?: number;
  readOnly?: boolean;
  placeholder?: string;
}

/**
 * Lightweight code editor for this first slice. It is intentionally a plain
 * textarea so the plugin bundle does not pull Monaco workers before the host
 * serves the full editor runtime. The API stays compatible with the eventual
 * Monaco-backed implementation.
 */
export const GonaviCodeEditor: React.FC<GonaviCodeEditorProps> = ({
  value,
  onChange,
  language = 'text',
  height = 240,
  readOnly,
  placeholder,
}) => (
  <div className="gonavi-code-editor" data-language={language}>
    <Input.TextArea
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
      readOnly={readOnly}
      placeholder={placeholder}
      spellCheck={false}
      autoSize={false}
      style={{ height, resize: 'vertical' }}
    />
  </div>
);

export interface GonaviConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A small confirm surface plugins can use when they do not want the host modal. */
export const GonaviConfirmDialog: React.FC<GonaviConfirmDialogProps> = ({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  onConfirm,
  onCancel,
}) => (
  <div className={open ? 'gonavi-confirm gonavi-confirm-open' : 'gonavi-confirm'} aria-hidden={!open}>
    {open && (
      <div className="gonavi-confirm-card" role="dialog" aria-modal="true">
        <Typography.Title level={5}>{title}</Typography.Title>
        {description && <Typography.Paragraph type="secondary">{description}</Typography.Paragraph>}
        <Space className="gonavi-confirm-actions">
          <Button onClick={onCancel}>{cancelLabel}</Button>
          <Button danger={danger} type="primary" onClick={onConfirm}>{confirmLabel}</Button>
        </Space>
      </div>
    )}
  </div>
);

export interface GonaviSqlEditorProps {
  value?: string;
  onChange?: (value: string) => void;
  onRun?: () => void;
  language?: 'sql' | 'javascript' | 'json';
  height?: number;
  readOnly?: boolean;
  placeholder?: string;
  runLabel?: ReactNode;
}

/**
 * SQL/JS editor with an explicit Run affordance. Ctrl/Cmd+Enter triggers the same
 * callback; the host still owns execution and every capability limit.
 */
export const GonaviSqlEditor: React.FC<GonaviSqlEditorProps> = ({
  value,
  onChange,
  onRun,
  language = 'sql',
  height = 240,
  readOnly,
  placeholder,
  runLabel = 'Run',
}) => (
  <div className="gonavi-sql-editor" data-language={language}>
    <div className="gonavi-sql-editor-header">
      <span className="gonavi-sql-editor-language">{language.toUpperCase()}</span>
      <button className="gonavi-sql-run" type="button" onClick={onRun} disabled={readOnly || !onRun}>{runLabel}</button>
    </div>
    <textarea
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          onRun?.();
        }
      }}
      readOnly={readOnly}
      placeholder={placeholder}
      spellCheck={false}
      style={{ height, resize: 'vertical' }}
    />
  </div>
);
