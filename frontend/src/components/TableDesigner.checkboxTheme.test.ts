import { describe, expect, it } from 'vitest';
import { readCssWithImports } from '../test/readCssWithImports';

const appCss = readCssWithImports(new URL('../App.css', import.meta.url));

describe('TableDesigner checkbox theme', () => {
  it('keeps the check mark white when a checked field constraint is disabled', () => {
    expect(appCss).toMatch(
      /\.table-designer-shell\s+\.table-designer-cell-check\s+\.ant-checkbox-disabled\.ant-checkbox-checked\s+\.ant-checkbox-inner::after\s*\{[^}]*border-color:\s*var\(--gn-on-accent,\s*#fff\)\s*!important;/s,
    );
  });
});
