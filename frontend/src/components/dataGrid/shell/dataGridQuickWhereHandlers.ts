import type { DataGridShellToolbarProps } from './DataGridShellToolbar';
import type { DataGridToolbarFrameProps } from '../../DataGridToolbarFrame';

type QuickWhereHandlerInput = Pick<DataGridShellToolbarProps,
  | 'shouldApplyQuickWhereOnEnter' | 'quickWhereSuggestionsOpen' | 'quickWhereSuggestionOptions'
  | 'applyQuickWhereCondition' | 'resolveWhereConditionSelectedValue' | 'quickWhereDraft' | 'setQuickWhereDraft'
>;

export const buildDataGridQuickWhereHandlers = ({
  shouldApplyQuickWhereOnEnter, quickWhereSuggestionsOpen, quickWhereSuggestionOptions,
  applyQuickWhereCondition, resolveWhereConditionSelectedValue, quickWhereDraft, setQuickWhereDraft,
}: QuickWhereHandlerInput): Pick<DataGridToolbarFrameProps, 'onQuickWhereKeyDown' | 'onQuickWhereSelect'> => ({
  onQuickWhereKeyDown: (event) => {
    const isClipboardShortcut = (event.metaKey || event.ctrlKey) && !event.altKey
      && ['c', 'v', 'x'].includes(String(event.key || '').toLowerCase());
    if (isClipboardShortcut) {
      event.stopPropagation();
      return;
    }
    if (!shouldApplyQuickWhereOnEnter({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: Boolean(event.nativeEvent.isComposing),
      suggestionsOpen: quickWhereSuggestionsOpen,
      suggestionCount: quickWhereSuggestionOptions.length,
      activeSuggestionId: event.currentTarget.getAttribute('aria-activedescendant'),
    })) return;
    event.preventDefault();
    applyQuickWhereCondition();
  },
  onQuickWhereSelect: (value, option) => {
    setQuickWhereDraft(resolveWhereConditionSelectedValue({
      selectedValue: value,
      currentInput: quickWhereDraft,
      insertText: option && typeof option === 'object' && 'insertText' in option ? option.insertText : undefined,
    }));
  },
});
