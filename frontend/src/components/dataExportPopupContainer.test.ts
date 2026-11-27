// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { resolveDataExportPopupContainer } from './dataExportPopupContainer';

describe('data export popup container', () => {
  it('anchors select popups to the draggable modal frame', () => {
    const frame = document.createElement('div');
    frame.className = 'gn-resizable-draggable-modal';
    const trigger = document.createElement('div');
    frame.appendChild(trigger);
    document.body.appendChild(frame);

    expect(resolveDataExportPopupContainer(trigger)).toBe(frame);
    frame.remove();
  });

  it('falls back to body outside the resizable modal frame', () => {
    const trigger = document.createElement('div');
    document.body.appendChild(trigger);

    expect(resolveDataExportPopupContainer(trigger)).toBe(document.body);
    trigger.remove();
  });
});
