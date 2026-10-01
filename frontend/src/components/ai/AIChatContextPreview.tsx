import React from 'react';
import { Tag } from 'antd';
import { CodeOutlined, DownOutlined } from '@ant-design/icons';
import { GnPlusIcon, GnTableIcon } from '../icons/gnIcons';

import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import type { AIContextItem, AIEditorSelection } from '../../types';
import { isAIEditorSelectionContext } from './aiEditorSelectionContext';

interface AIChatContextPreviewProps {
  activeContextItems: AIContextItem[];
  contextExpanded: boolean;
  onToggleExpanded: () => void;
  onOpenContext: () => void;
  onRemoveContext: (dbName: string, tableName: string) => void;
  activeEditorSelection?: AIEditorSelection | null;
  editorSelectionBound?: boolean;
  onBindEditorSelection?: () => void;
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
    {isAIEditorSelectionContext(ctx) ? <CodeOutlined /> : <GnTableIcon />}
    <span>{isAIEditorSelectionContext(ctx)
      ? (ctx.label || tFallback('ai_chat.input.context.selector.editor_selection'))
      : ctx.tableName}</span>
  </Tag>
));

const tFallback = (key: string): string => {
  const translated = catalogTranslate('en-US', key);
  return translated === key ? 'Editor selection' : translated;
};

export const AIChatContextPreview: React.FC<AIChatContextPreviewProps> = ({
  activeContextItems,
  contextExpanded,
  onToggleExpanded,
  onOpenContext,
  onRemoveContext,
  activeEditorSelection,
  editorSelectionBound = false,
  onBindEditorSelection,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? ((key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
    catalogTranslate('en-US', key, params));
  const contextLabel = t('ai_chat.input.context.label');
  const currentContextCount = t('ai_chat.input.context.current_count', { count: activeContextItems.length });
  const selectionTooltip = t('ai_chat.input.context.bind_selection_tooltip');

  return (
    <>
      <div className="ai-chat-input-preview-area gn-v2-ai-context-row">
        <button
          type="button"
          className={`gn-v2-ai-context-toggle${contextExpanded ? ' is-expanded' : ''}`}
          onClick={onToggleExpanded}
          aria-expanded={contextExpanded}
        >
          <GnTableIcon />
          <span>{contextLabel}</span>
          <strong>{activeContextItems.length}</strong>
          <DownOutlined />
        </button>
        <button
          type="button"
          className="gn-v2-ai-context-add"
          onClick={onOpenContext}
          title={t('ai_chat.input.context.add_tooltip')}
          aria-label={t('ai_chat.input.context.add_tooltip')}
        >
          <GnPlusIcon />
          <span>{t('ai_chat.input.context.add')}</span>
        </button>
        {activeEditorSelection && String(activeEditorSelection.text || '').trim() && onBindEditorSelection && (
          <button
            type="button"
            className="gn-v2-ai-context-add gn-v2-ai-context-selection-add"
            onClick={onBindEditorSelection}
            disabled={editorSelectionBound}
            title={selectionTooltip}
            aria-label={selectionTooltip}
          >
            <CodeOutlined />
            <span>{t(editorSelectionBound
              ? 'ai_chat.input.context.selection_bound'
              : 'ai_chat.input.context.bind_selection')}</span>
          </button>
        )}
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
