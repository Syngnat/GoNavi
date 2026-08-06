import { describe, expect, it } from 'vitest';

import { shouldShowFooterReleaseNotesAction } from './aboutUpdateActions';

describe('aboutUpdateActions', () => {
  it('keeps release notes in the legacy modal footer only', () => {
    expect(shouldShowFooterReleaseNotesAction('legacy-modal')).toBe(true);
    expect(shouldShowFooterReleaseNotesAction('settings-center')).toBe(false);
  });
});
