/** Monaco's suggest widget has no public width option; keep its list and shell in sync. */
export const QUERY_EDITOR_SUGGEST_WIDGET_MIN_WIDTH = 600;

type SuggestWidget = {
  _resize?: (width: number, height: number) => void;
  __gonaviSuggestWidgetWidthInstalled?: boolean;
};

export const resolveQueryEditorSuggestWidgetWidth = (width: unknown): number => {
  const numericWidth = Number(width);
  return Number.isFinite(numericWidth)
    ? Math.max(numericWidth, QUERY_EDITOR_SUGGEST_WIDGET_MIN_WIDTH)
    : QUERY_EDITOR_SUGGEST_WIDGET_MIN_WIDTH;
};

export const installQueryEditorSuggestWidgetWidth = (editor: unknown): void => {
  const suggestWidget = (editor as any)?.getContribution?.('editor.contrib.suggestController')?.widget?.value as
    | SuggestWidget
    | undefined;
  if (
    !suggestWidget
    || typeof suggestWidget._resize !== 'function'
    || suggestWidget.__gonaviSuggestWidgetWidthInstalled
  ) {
    return;
  }

  const originalResize = suggestWidget._resize;
  suggestWidget._resize = function resizeSuggestWidget(width: number, height: number) {
    originalResize.call(this, resolveQueryEditorSuggestWidgetWidth(width), height);
  };
  Object.defineProperty(suggestWidget, '__gonaviSuggestWidgetWidthInstalled', {
    configurable: true,
    value: true,
  });
};
