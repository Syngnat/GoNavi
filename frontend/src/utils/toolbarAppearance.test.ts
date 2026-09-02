import { describe, expect, it, vi } from 'vitest';
import {
  TOOLBAR_BUTTON_CLIENT_COLOR_CSS_VARIABLES,
  TOOLBAR_BUTTON_COLOR_TOKENS,
  TOOLBAR_BUTTON_STATES,
  applyToolbarButtonColorOverride,
  buildToolbarButtonClientCssVariableOverrides,
  clearToolbarButtonColorOverrides,
  getToolbarButtonColorToken,
  sanitizeToolbarButtonColorOverrides,
  sanitizeToolbarButtonCssColor,
} from './toolbarAppearance';

describe('toolbar appearance helpers', () => {
  it('builds the existing CSS token names from client picker selections', () => {
    expect(getToolbarButtonColorToken('button', 'default', 'fg')).toBe('button-fg');
    expect(getToolbarButtonColorToken('primary', 'hover', 'bg')).toBe('primary-hover-bg');
    expect(getToolbarButtonColorToken('primary', 'active', 'border')).toBe(
      'primary-active-border',
    );
    expect(getToolbarButtonColorToken('button', 'disabled', 'fg')).toBe(
      'button-disabled-fg',
    );
    expect(getToolbarButtonColorToken('primary', 'disabled', 'bg')).toBe(
      'primary-disabled-bg',
    );
    expect(TOOLBAR_BUTTON_STATES).toEqual(['default', 'hover', 'active', 'disabled']);
  });

  it.each([
    ['#ABC', '#abc'],
    ['#1234', '#1234'],
    ['#AABBCC', '#aabbcc'],
    ['#AABBCC80', '#aabbcc80'],
    ['rgb(12, 34, 56)', 'rgb(12, 34, 56)'],
    ['rgba(12, 34, 56, 0.5)', 'rgba(12, 34, 56, 0.5)'],
    ['rgb(10% 20% 30% / 40%)', 'rgb(10% 20% 30% / 40%)'],
    ['hsl(120, 30%, 40%)', 'hsl(120, 30%, 40%)'],
    ['hsla(120deg, 30%, 40%, .25)', 'hsla(120deg, 30%, 40%, .25)'],
    ['hsl(0.5turn 30% 40% / 25%)', 'hsl(0.5turn 30% 40% / 25%)'],
  ])('accepts a concrete CSS color %s', (input, expected) => {
    expect(sanitizeToolbarButtonCssColor(input)).toBe(expected);
  });

  it.each([
    null,
    '',
    'red',
    'transparent',
    'var(--gn-accent)',
    'url(https://example.com/a)',
    'linear-gradient(red, blue)',
    '#12345',
    'rgb(256, 0, 0)',
    'rgb(0, -1, 0)',
    'rgba(0, 0, 0, 1.1)',
    'rgb(0, 0, 0, 0.5)',
    'rgba(0, 0, 0)',
    'hsl(0, 101%, 50%)',
    'hsl(0, 50, 50%)',
    'rgb(0, 0, 0); --gn-danger: red',
  ])('rejects an unsafe or invalid client color %s', (input) => {
    expect(sanitizeToolbarButtonCssColor(input)).toBeNull();
  });

  it('uses CSS.supports as an additional browser validity check', () => {
    vi.stubGlobal('CSS', { supports: vi.fn(() => false) });
    expect(sanitizeToolbarButtonCssColor('rgb(1, 2, 3)')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('keeps only whitelisted query/result variables with valid colors', () => {
    expect(sanitizeToolbarButtonColorOverrides({
      query: {
        'button-fg': '#ABC',
        'button-disabled-fg': '#789',
        'button-bg': 'url(https://example.com/a)',
        'unknown-token': '#fff',
      },
      result: {
        'primary-active-border': 'rgba(1, 2, 3, 0.4)',
        'primary-disabled-bg': '#456789',
      },
      other: {
        'button-fg': '#000',
      },
    })).toEqual({
      query: { 'button-fg': '#abc', 'button-disabled-fg': '#789' },
      result: {
        'primary-active-border': 'rgba(1, 2, 3, 0.4)',
        'primary-disabled-bg': '#456789',
      },
    });
  });

  it('fans the all scope out to query and result without losing other values', () => {
    const next = applyToolbarButtonColorOverride(
      { query: { 'button-bg': '#111111' } },
      'all',
      'button-fg',
      '#ABCDEF',
    );
    expect(next).toEqual({
      query: { 'button-bg': '#111111', 'button-fg': '#abcdef' },
      result: { 'button-fg': '#abcdef' },
    });
  });

  it('clears individual values and whole scopes while pruning empty groups', () => {
    const current = {
      query: { 'button-fg': '#111111' },
      result: { 'button-fg': '#222222', 'button-bg': '#333333' },
    };
    expect(applyToolbarButtonColorOverride(current, 'query', 'button-fg', null)).toEqual({
      result: { 'button-fg': '#222222', 'button-bg': '#333333' },
    });
    expect(clearToolbarButtonColorOverrides(current, 'result')).toEqual({
      query: { 'button-fg': '#111111' },
    });
    expect(clearToolbarButtonColorOverrides(current, 'all')).toEqual({});
  });

  it('maps sparse overrides to private client CSS variables', () => {
    expect(buildToolbarButtonClientCssVariableOverrides({
      query: {
        'button-hover-bg': '#123456',
        'button-disabled-border': '#789abc',
      },
      result: {
        'primary-active-fg': 'rgba(1, 2, 3, 0.5)',
        'primary-disabled-fg': '#abcdef',
      },
    })).toEqual({
      '--gn-client-query-toolbar-button-hover-bg': '#123456',
      '--gn-client-query-toolbar-button-disabled-border': '#789abc',
      '--gn-client-result-toolbar-primary-active-fg': 'rgba(1, 2, 3, 0.5)',
      '--gn-client-result-toolbar-primary-disabled-fg': '#abcdef',
    });
    expect(TOOLBAR_BUTTON_COLOR_TOKENS).toHaveLength(24);
    expect(TOOLBAR_BUTTON_CLIENT_COLOR_CSS_VARIABLES).toHaveLength(48);
    expect(new Set(TOOLBAR_BUTTON_CLIENT_COLOR_CSS_VARIABLES).size).toBe(48);
  });
});
