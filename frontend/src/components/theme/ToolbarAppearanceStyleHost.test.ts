import { describe, expect, it, vi } from 'vitest';
import { TOOLBAR_BUTTON_CLIENT_COLOR_CSS_VARIABLES } from '../../utils/toolbarAppearance';
import { syncToolbarAppearanceStyle } from './ToolbarAppearanceStyleHost';

const createFakeDocument = () => {
  const values = new Map<string, string>([['--unrelated', '#fff']]);
  const priorities = new Map<string, string>();
  const setProperty = vi.fn((property: string, value: string, priority = '') => {
    values.set(property, value);
    priorities.set(property, priority);
  });
  const removeProperty = vi.fn((property: string) => {
    const previous = values.get(property) ?? '';
    values.delete(property);
    priorities.delete(property);
    return previous;
  });
  return {
    documentRef: {
      body: { style: { setProperty, removeProperty } },
    } as unknown as Pick<Document, 'body'>,
    values,
    priorities,
    setProperty,
    removeProperty,
  };
};

describe('ToolbarAppearanceStyleHost runtime', () => {
  it('writes sanitized client overrides as body inline scoped variables', () => {
    const fake = createFakeDocument();
    syncToolbarAppearanceStyle({
      query: {
        'button-fg': '#ABCDEF',
        'button-disabled-bg': '#334455',
        'button-bg': 'var(--unsafe)',
      },
      result: {
        'primary-hover-border': 'rgba(1, 2, 3, 0.4)',
        'primary-disabled-border': 'rgba(4, 5, 6, 0.3)',
      },
    }, fake.documentRef);

    expect(fake.values.get('--gn-client-query-toolbar-button-fg')).toBe('#abcdef');
    expect(fake.values.has('--gn-client-query-toolbar-button-bg')).toBe(false);
    expect(fake.values.get('--gn-client-result-toolbar-primary-hover-border')).toBe(
      'rgba(1, 2, 3, 0.4)',
    );
    expect(fake.values.get('--gn-client-query-toolbar-button-disabled-bg')).toBe('#334455');
    expect(fake.values.get('--gn-client-result-toolbar-primary-disabled-border')).toBe(
      'rgba(4, 5, 6, 0.3)',
    );
    expect(fake.priorities.get('--gn-client-query-toolbar-button-fg')).toBe('important');
    expect(fake.priorities.get('--gn-client-query-toolbar-button-disabled-bg')).toBe('important');
    expect(fake.priorities.get('--gn-client-result-toolbar-primary-hover-border')).toBe('important');
    expect(fake.priorities.get('--gn-client-result-toolbar-primary-disabled-border')).toBe('important');
    expect(fake.values.get('--unrelated')).toBe('#fff');
  });

  it('removes stale overrides so active custom-theme values can surface again', () => {
    const fake = createFakeDocument();
    syncToolbarAppearanceStyle({
      query: { 'button-fg': '#111111' },
      result: { 'button-bg': '#222222' },
    }, fake.documentRef);
    syncToolbarAppearanceStyle({
      result: { 'button-bg': '#333333' },
    }, fake.documentRef);

    expect(fake.values.has('--gn-client-query-toolbar-button-fg')).toBe(false);
    expect(fake.values.get('--gn-client-result-toolbar-button-bg')).toBe('#333333');
    expect(fake.removeProperty).toHaveBeenCalledWith('--gn-client-query-toolbar-button-fg');
  });

  it('clears only the complete toolbar variable whitelist on reset', () => {
    const fake = createFakeDocument();
    for (const property of TOOLBAR_BUTTON_CLIENT_COLOR_CSS_VARIABLES) {
      fake.values.set(property, '#123456');
    }

    syncToolbarAppearanceStyle({}, fake.documentRef);

    expect(TOOLBAR_BUTTON_CLIENT_COLOR_CSS_VARIABLES).toHaveLength(48);
    expect(TOOLBAR_BUTTON_CLIENT_COLOR_CSS_VARIABLES.every(
      (property) => !fake.values.has(property),
    )).toBe(true);
    expect(fake.values.get('--unrelated')).toBe('#fff');
  });
});
