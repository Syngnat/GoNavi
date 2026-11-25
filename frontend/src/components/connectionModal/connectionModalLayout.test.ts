import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  CONNECTION_MODAL_BODY_HEIGHT,
  buildConnectionModalBodyStyle,
} from './connectionModalHelpers';

const connectionModalCss = readFileSync(
  new URL('../../styles/app/app-03-connection-modal.css', import.meta.url),
  'utf8',
);

describe('connection modal small-screen scroll layout', () => {
  it('makes the form body fill the bounded modal instead of growing past it', () => {
    expect(buildConnectionModalBodyStyle(true)).toMatchObject({
      height: 0,
      minHeight: 0,
      maxHeight: 'none',
      flex: '1 1 auto',
      overflowY: 'hidden',
    });
    expect(buildConnectionModalBodyStyle(false)).toMatchObject({
      height: CONNECTION_MODAL_BODY_HEIGHT,
      minHeight: CONNECTION_MODAL_BODY_HEIGHT,
    });
  });

  it('keeps a definite content height before the user manually resizes the modal', () => {
    expect(connectionModalCss).toMatch(
      /\.connection-modal-wrap\.connection-modal-form \.ant-modal-content\s*\{[^}]*height:\s*min\(780px, calc\(100vh - 72px\)\)/s,
    );
    expect(connectionModalCss).toMatch(
      /\.connection-modal-wrap\.connection-modal-form \.gn-connection-content-stage\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s,
    );
    expect(connectionModalCss).toMatch(
      /\.connection-modal-wrap\.connection-modal-form \.gn-conn-studio-form\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/s,
    );
  });
});
