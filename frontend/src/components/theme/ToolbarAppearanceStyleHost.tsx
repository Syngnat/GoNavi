import { useLayoutEffect } from 'react';
import { useStore } from '../../store';
import {
  TOOLBAR_BUTTON_CLIENT_COLOR_CSS_VARIABLES,
  buildToolbarButtonClientCssVariableOverrides,
  type ToolbarButtonColorOverrides,
} from '../../utils/toolbarAppearance';

type ToolbarAppearanceDocument = Pick<Document, 'body'>;

export const syncToolbarAppearanceStyle = (
  overrides: ToolbarButtonColorOverrides | unknown,
  documentRef: ToolbarAppearanceDocument | null = (
    typeof document === 'undefined' ? null : document
  ),
): void => {
  const bodyStyle = documentRef?.body?.style;
  if (!bodyStyle) return;
  const cssVariables = buildToolbarButtonClientCssVariableOverrides(overrides);
  for (const property of TOOLBAR_BUTTON_CLIENT_COLOR_CSS_VARIABLES) {
    const value = cssVariables[property];
    if (value) bodyStyle.setProperty(property, value, 'important');
    else bodyStyle.removeProperty(property);
  }
};

/**
 * Private inherited variables keep client selections separate from the public
 * custom-theme contract. Toolbar consumers read these first, then theme vars.
 */
export default function ToolbarAppearanceStyleHost() {
  const overrides = useStore(
    (state) => state.appearance.toolbarButtonColorOverrides,
  );

  useLayoutEffect(() => {
    syncToolbarAppearanceStyle(overrides);
    return () => syncToolbarAppearanceStyle({});
  }, [overrides]);

  return null;
}
