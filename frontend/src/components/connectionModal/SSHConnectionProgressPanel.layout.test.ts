import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appCss = readFileSync(
  fileURLToPath(new globalThis.URL('../../App.css', import.meta.url)),
  'utf8',
);

describe('SSHConnectionProgressPanel stepper layout', () => {
  it('keeps every desktop step dot, connector, and label on one center axis', () => {
    expect(appCss).toMatch(
      /\.gn-ssh-progress-steps li\s*\{[^}]*justify-items:\s*center;[^}]*text-align:\s*center;/s,
    );
    expect(appCss).toMatch(
      /\.gn-ssh-progress-steps li:not\(:last-child\)::after\s*\{[^}]*top:\s*4px;[^}]*left:\s*50%;[^}]*width:\s*calc\(100% \+ 6px\);/s,
    );
    expect(appCss).toMatch(
      /\.gn-ssh-progress-dot,\s*\.gn-ssh-progress-log-dot\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*1;/s,
    );
  });

  it('keeps the narrow layout as a readable vertical list without a connector', () => {
    expect(appCss).toMatch(
      /@media \(max-width: 680px\) \{[\s\S]*?\.gn-ssh-progress-steps li\s*\{[^}]*justify-items:\s*stretch;[^}]*text-align:\s*left;/s,
    );
    expect(appCss).toMatch(
      /@media \(max-width: 680px\) \{[\s\S]*?\.gn-ssh-progress-steps li:not\(:last-child\)::after\s*\{[^}]*display:\s*none;/s,
    );
  });
});
