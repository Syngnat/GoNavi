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

  it('keeps a compact message list with a dedicated payload inspector', () => {
    expect(workbenchCss).toMatch(/\.gn-message-stream-body\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(280px, 42%\);/);
    expect(workbenchCss).toContain('.gn-message-payload-preview');
    expect(workbenchCss).toContain('.gn-message-detail');
    expect(workbenchCss).toMatch(/\.gn-message-stream\s*\{[^}]*overflow:\s*hidden;/);
    expect(workbenchCss).toMatch(/\.gn-message-workbench-body\s*\{[^}]*overflow:\s*hidden;/);
  });
});
