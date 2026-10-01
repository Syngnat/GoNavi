import Modal from '../common/ResizableDraggableModal';
import React from 'react';
import { Button, Checkbox, Input, Select, Spin } from 'antd';
import { SearchOutlined } from '@ant-design/icons';

import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import type { AIEditorSelection } from '../../types';

interface ContextTableItem {
  name: string;
}

interface AIContextSelectorModalProps {
  open: boolean;
  loading: boolean;
  confirmLoading: boolean;
  darkMode: boolean;
  textColor: string;
  overlayTheme: OverlayWorkbenchTheme;
  dbList: string[];
  selectedDbName: string;
  searchText: string;
  filteredTables: ContextTableItem[];
  selectedTableKeys: string[];
  activeEditorSelection?: AIEditorSelection | null;
  selectedEditorSelection?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onDbChange: (dbName: string) => void;
  onSearchTextChange: (value: string) => void;
  onSelectedTableKeysChange: (keys: string[]) => void;
  onSelectedEditorSelectionChange?: (selected: boolean) => void;
}

export const AIContextSelectorModal: React.FC<AIContextSelectorModalProps> = ({
  open,
  loading,
  confirmLoading,
  darkMode,
  textColor,
  overlayTheme,
  dbList,
  selectedDbName,
  searchText,
  filteredTables,
  selectedTableKeys,
  activeEditorSelection,
  selectedEditorSelection = false,
  onCancel,
  onConfirm,
  onDbChange,
  onSearchTextChange,
  onSelectedTableKeysChange,
  onSelectedEditorSelectionChange,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? ((key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
    catalogTranslate('en-US', key, params));
  const matchedKeys = filteredTables.map((table) => `${selectedDbName}::${table.name}`);
  const allSelected = matchedKeys.length > 0 && matchedKeys.every((key) => selectedTableKeys.includes(key));
  const partiallySelected = matchedKeys.length > 0 && matchedKeys.some((key) => selectedTableKeys.includes(key)) && !allSelected;
  const modalTitle = t('ai_chat.input.context.selector.title');
  const confirmText = t('ai_chat.input.context.selector.confirm');
  const cancelText = t('ai_chat.input.context.selector.cancel');
  const databasePlaceholder = t('ai_chat.input.context.selector.database_placeholder');
  const searchPlaceholder = t('ai_chat.input.context.selector.search_placeholder');
  const selectAllLabel = t('ai_chat.input.context.selector.select_all', { count: filteredTables.length });
  const invertSelectionLabel = t('ai_chat.input.context.selector.invert_selection');
  const emptyStateText = searchText
    ? t('ai_chat.input.context.selector.empty_no_match', { searchText })
    : t('ai_chat.input.context.selector.empty_no_tables');
  const selectionText = String(activeEditorSelection?.text || '');
  const selectionLabel = String(activeEditorSelection?.tabTitle || '').trim()
    || t('ai_chat.input.context.selector.editor_selection');
  const selectionPreview = selectionText.length > 520
    ? `${selectionText.slice(0, 520)}…`
    : selectionText;

  const handleToggleAll = (checked: boolean) => {
    if (checked) {
      const nextSelected = new Set([...selectedTableKeys, ...matchedKeys]);
      onSelectedTableKeysChange(Array.from(nextSelected));
      return;
    }
    onSelectedTableKeysChange(selectedTableKeys.filter((key) => !matchedKeys.includes(key)));
  };

  const handleInvertSelection = () => {
    const remainingSelected = selectedTableKeys.filter((key) => !matchedKeys.includes(key));
    const keysToAdd = matchedKeys.filter((key) => !selectedTableKeys.includes(key));
    onSelectedTableKeysChange([...remainingSelected, ...keysToAdd]);
  };

  const handleToggleSingle = (key: string, checked: boolean) => {
    if (checked) {
      onSelectedTableKeysChange([...selectedTableKeys, key]);
      return;
    }
    onSelectedTableKeysChange(selectedTableKeys.filter((selectedKey) => selectedKey !== key));
  };

  return (
    <Modal
      title={<span style={{ color: textColor }}>{modalTitle}</span>}
      open={open}
      onCancel={onCancel}
      onOk={onConfirm}
      confirmLoading={confirmLoading}
      okText={confirmText}
      cancelText={cancelText}
      centered
      styles={{
        content: { background: darkMode ? '#1e1e1e' : '#ffffff', border: overlayTheme.shellBorder },
        header: { background: darkMode ? '#1e1e1e' : '#ffffff', borderBottom: overlayTheme.shellBorder },
        body: { padding: '20px 24px' },
      }}
    >
      <Spin spinning={loading}>
        {activeEditorSelection && selectionText.trim() && (
          <div
            style={{
              marginBottom: 16,
              padding: '10px 12px',
              borderRadius: 8,
              border: `1px solid ${darkMode ? 'rgba(255,255,255,0.14)' : 'rgba(22,119,255,0.16)'}`,
              background: darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(22,119,255,0.04)',
            }}
          >
            <Checkbox
              checked={selectedEditorSelection}
              onChange={(event) => onSelectedEditorSelectionChange?.(event.target.checked)}
              style={{ color: textColor, width: '100%' }}
            >
              <span style={{ fontWeight: 600 }}>{t('ai_chat.input.context.selector.editor_selection_label', { label: selectionLabel })}</span>
            </Checkbox>
            <pre
              style={{
                margin: '8px 0 0 24px',
                maxHeight: 120,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: overlayTheme.mutedText,
                fontSize: 11,
                lineHeight: 1.5,
              }}
            >
              {selectionPreview}
            </pre>
          </div>
        )}
        <div style={{ marginBottom: 16, display: 'flex', gap: 12 }}>
          {dbList.length > 0 && (
            <Select
              value={selectedDbName}
              onChange={onDbChange}
              options={dbList.map((dbName) => ({ label: dbName, value: dbName }))}
              style={{ width: 160, flexShrink: 0 }}
              placeholder={databasePlaceholder}
              showSearch
            />
          )}
          <Input
            placeholder={searchPlaceholder}
            prefix={<SearchOutlined style={{ color: overlayTheme.mutedText }} />}
            value={searchText}
            onChange={(event) => onSearchTextChange(event.target.value)}
            style={{ background: darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)', border: 'none', flexGrow: 1 }}
          />
        </div>

        {filteredTables.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                borderBottom: `1px solid ${darkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}`,
                paddingBottom: 12,
                marginBottom: 8,
              }}
            >
              <Checkbox
                indeterminate={partiallySelected}
                checked={allSelected}
                onChange={(event) => handleToggleAll(event.target.checked)}
                style={{ color: textColor, fontWeight: 'bold' }}
              >
                {selectAllLabel}
              </Checkbox>
              <Button
                type="link"
                size="small"
                style={{ padding: 0, height: 'auto', fontSize: 13 }}
                onClick={handleInvertSelection}
              >
                {invertSelectionLabel}
              </Button>
            </div>
            <div style={{ maxHeight: 300, overflowY: 'auto', margin: '0 -24px', padding: '0 24px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {filteredTables.map((table) => {
                  const key = `${selectedDbName}::${table.name}`;
                  const selected = selectedTableKeys.includes(key);
                  return (
                    <div
                      key={key}
                      style={{
                        padding: '6px 10px',
                        borderRadius: 6,
                        transition: 'background 0.2s',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={(event) => {
                        event.currentTarget.style.background = darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.03)';
                      }}
                      onMouseLeave={(event) => {
                        event.currentTarget.style.background = 'transparent';
                      }}
                      onClick={(event) => {
                        if ((event.target as HTMLElement).tagName.toLowerCase() === 'input') {
                          return;
                        }
                        handleToggleSingle(key, !selected);
                      }}
                    >
                      <Checkbox
                        checked={selected}
                        onChange={(event) => handleToggleSingle(key, event.target.checked)}
                        style={{ color: textColor, width: '100%' }}
                      >
                        <span style={{ fontSize: 13, userSelect: 'none' }}>{table.name}</span>
                      </Checkbox>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ padding: '40px 0', textAlign: 'center', color: overlayTheme.mutedText }}>
            {emptyStateText}
          </div>
        )}
      </Spin>
    </Modal>
  );
};

export default AIContextSelectorModal;
