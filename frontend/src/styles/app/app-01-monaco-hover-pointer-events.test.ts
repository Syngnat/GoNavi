import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appCss = readFileSync(
  new URL('./app-01-disable-global-scrollbar.css', import.meta.url),
  'utf8',
);

describe('monaco workbench hover pointer events', () => {
  it('lets button-level tooltips pass pointer events through to their trigger', () => {
    expect(appCss).toMatch(
      /\.monaco-hover\.workbench-hover\s*\{[^}]*pointer-events:\s*none;/,
    );
  });

  it('restores interactivity for alt-locked tooltips', () => {
    expect(appCss).toMatch(
      /\.workbench-hover-container\.locked\s*>\s*\.monaco-hover\.workbench-hover\s*\{[^}]*pointer-events:\s*auto;/,
    );
  });

  it('keeps editor content hovers (scrollable/copyable) interactive', () => {
    expect(appCss).not.toMatch(
      /\.monaco-hover\s*\{[^}]*pointer-events:\s*none/,
    );
  });
});
