import React from 'react';
import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../wailsjs/runtime', () => ({
  BrowserOpenURL: vi.fn(),
}));

vi.mock('../i18n', () => ({
  t: (key: string) => key,
}));

vi.mock('./common/ResizableDraggableModal', () => ({
  default: ({ open, title, children, footer, centered, style }: any) => (
    open ? (
      <div
        data-testid="release-notes-modal"
        data-centered={centered ? 'true' : 'false'}
        data-has-top-offset={style?.top == null ? 'false' : 'true'}
      >
        <div data-testid="release-notes-title">{title}</div>
        <div data-testid="release-notes-body">{children}</div>
        <div data-testid="release-notes-footer">{footer}</div>
      </div>
    ) : null
  ),
}));

import UpdateReleaseNotesModal from './UpdateReleaseNotesModal';

const collectText = (value: unknown): string => {
  if (value == null || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(collectText).join('');
  if (typeof value === 'object' && value && 'children' in (value as any)) {
    return collectText((value as any).children);
  }
  if (typeof value === 'object' && value && 'props' in (value as any)) {
    return collectText((value as any).props?.children);
  }
  return '';
};

describe('UpdateReleaseNotesModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders markdown release notes body when provided', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <UpdateReleaseNotesModal
          open
          onClose={() => undefined}
          version="0.9.0"
          channel="latest"
          releaseNotes={"## Feature\n\n- ship in-app release notes\n"}
          releaseNotesUrl="https://github.com/Syngnat/GoNavi/releases/tag/v0.9.0"
        />,
      );
    });
    const modal = renderer.root.findByProps({ 'data-testid': 'release-notes-modal' });
    const text = collectText(modal);
    expect(text).toContain('app.about.release_notes.modal.title');
    expect(text).toContain('0.9.0');
    expect(text).toContain('ship in-app release notes');
    expect(text).toContain('app.about.release_notes.modal.open_github');
    expect(modal.props['data-centered']).toBe('true');
    expect(modal.props['data-has-top-offset']).toBe('false');
  });

  it('shows empty state when notes body is missing', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <UpdateReleaseNotesModal
          open
          onClose={() => undefined}
          releaseNotesUrl="https://github.com/Syngnat/GoNavi/releases/latest"
        />,
      );
    });
    const modal = renderer.root.findByProps({ 'data-testid': 'release-notes-modal' });
    const text = collectText(modal);
    expect(text).toContain('app.about.release_notes.modal.empty_with_link');
  });

  it('renders download progress section alongside notes', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <UpdateReleaseNotesModal
          open
          onClose={() => undefined}
          version="0.9.1"
          releaseNotes={"## Feature\n\n- combined download panel\n"}
          downloadProgress={{
            status: 'downloading',
            percent: 42,
            downloaded: 42,
            total: 100,
            message: 'downloading…',
          }}
          formatBytes={(value) => `${value}B`}
        />,
      );
    });
    const modal = renderer.root.findByProps({ 'data-testid': 'release-notes-modal' });
    const text = collectText(modal);
    expect(text).toContain('app.about.release_notes.modal.download_section');
    expect(text).toContain('combined download panel');
    expect(text).toContain('42B / 100B');
  });
});
