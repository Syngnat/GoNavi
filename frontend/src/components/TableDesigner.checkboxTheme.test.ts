import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appCss = readFileSync(new URL('../App.css', import.meta.url), 'utf8');

describe('TableDesigner checkbox theme', () => {
  it('keeps the check mark white when a checked field constraint is disabled', () => {
    expect(appCss).toMatch(
      /\.table-designer-shell\s+\.table-designer-cell-check\s+\.ant-checkbox-disabled\.ant-checkbox-checked\s+\.ant-checkbox-inner::after\s*\{[^}]*border-color:\s*var\(--gn-on-accent,\s*#fff\)\s*!important;/s,
    );
  });
});
