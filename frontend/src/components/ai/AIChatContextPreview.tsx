import React from 'react';
import { Tag } from 'antd';
import { DownOutlined, PlusOutlined, TableOutlined } from '@ant-design/icons';

import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import type { AIContextItem } from '../../types';

interface AIChatContextPreviewProps {
  activeContextItems: AIContextItem[];
  contextExpanded: boolean;
  onToggleExpanded: () => void;
  onOpenContext: () => void;
  onRemoveContext: (dbName: string, tableName: string) => void;
}

const renderContextTableChips = (
  activeContextItems: AIContextItem[],
  onRemoveContext: (dbName: string, tableName: string) => void,
  className?: string,
  style?: React.CSSProperties,
) => activeContextItems.map((ctx, idx) => (
  <Tag
    key={`ctx-${idx}`}
    closable
    onClose={(event) => {
      event.preventDefault();
      onRemoveContext(ctx.dbName, ctx.tableName);
    }}
    className={className}
    style={style}
  >
    <TableOutlined />
    <span>{ctx.tableName}</span>
  </Tag>
));

export const AIChatContextPreview: React.FC<AIChatContextPreviewProps> = ({
  activeContextItems,
  contextExpanded,
  onToggleExpanded,
  onOpenContext,
  onRemoveContext,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? ((key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
    catalogTranslate('en-US', key, params));
  const contextLabel = t('ai_chat.input.context.label');
  const currentContextCount = t('ai_chat.input.context.current_count', { count: activeContextItems.length });

  return (
    <>
      <div className="ai-chat-input-preview-area gn-v2-ai-context-row">
        <button
          type="button"
          className={`gn-v2-ai-context-toggle${contextExpanded ? ' is-expanded' : ''}`}
          onClick={onToggleExpanded}
          aria-expanded={contextExpanded}
        >
          <TableOutlined />
          <span>{contextLabel}</span>
          <strong>{activeContextItems.length}</strong>
          <DownOutlined />
        </button>
        <button type="button" className="gn-v2-ai-context-add" onClick={onOpenContext}>
          <PlusOutlined />
          <span>{t('ai_chat.input.context.add')}</span>
        </button>
      </div>
      {contextExpanded && activeContextItems.length > 0 && (
        <div className="gn-v2-ai-context-detail" data-ai-context-detail="true">
          <div className="gn-v2-ai-context-detail-title">{currentContextCount}</div>
          {renderContextTableChips(activeContextItems, onRemoveContext, 'gn-v2-ai-context-table-chip', { margin: 0 })}
        </div>
      )}
    </>
  );
};

export default AIChatContextPreview;
