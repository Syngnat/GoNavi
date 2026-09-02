import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workbenchCss = readFileSync(
  new URL('./message-queue-workbench.css', import.meta.url),
  'utf8',
);

describe('message queue workbench styles', () => {
  it('limits the subscription-count badge styles to the heading count', () => {
    expect(workbenchCss).not.toMatch(/\.gn-message-pane-heading\s+span\s*\{/);
    expect(workbenchCss).toMatch(
      /\.gn-message-subscription-count\s*\{[^}]*min-width:\s*18px;/,
    );
  });
});
