import React from 'react';
import { act, create } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  fetchOcrStatus: vi.fn(),
  installOcrComponent: vi.fn(),
  cancelOcrInstall: vi.fn(),
  removeOcrComponent: vi.fn(),
  subscribeOcrInstallProgress: vi.fn(() => () => undefined),
  fetchOcrServiceConfig: vi.fn(),
  isOcrSupported: vi.fn(() => true),
}));

vi.mock('./ocrComponentClient', () => client);
// antd's components and icons run browser-only effects; plain elements stand in for them.
// Modal and Popconfirm render into portals, so their content is shown in place.
vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  return {
    ...actual,
    Modal: ({ open, title, footer, children }: any) => (open ? <div data-modal>{title}{children}{footer}</div> : null),
    Popconfirm: ({ children, onConfirm, title }: any) => <span data-confirm={title} onClick={onConfirm}>{children}</span>,
    Button: ({ children, onClick, disabled }: any) => <button type="button" onClick={onClick} disabled={disabled}>{children}</button>,
    Tag: ({ children }: any) => <span>{children}</span>,
    Alert: ({ message, description }: any) => <div role="alert">{message}{description}</div>,
    Progress: ({ percent }: any) => <div data-progress={percent} />,
    Tooltip: ({ children }: any) => children,
  };
});
vi.mock('@ant-design/icons', () => {
  const icon = (name: string) => () => <span data-icon={name} />;
  return {
    LoadingOutlined: icon('loading'), CheckCircleFilled: icon('check'), MinusCircleOutlined: icon('minus'),
    ReloadOutlined: icon('reload'), DownloadOutlined: icon('download'), FileTextOutlined: icon('file'),
    WarningOutlined: icon('warning'), SafetyCertificateOutlined: icon('shield'),
  };
});

import { buildOverlayWorkbenchTheme } from '../../../utils/overlayWorkbenchTheme';
import AISettingsOcrSection from '../AISettingsOcrSection';
import AIChatAttachmentStrip from '../AIChatAttachmentStrip';
import AIChatComposerActions from '../AIChatComposerActions';
import { AIOcrBadge } from './AIOcrBadge';
import { AIOcrInstallModal } from './AIOcrInstallModal';
import { refreshOcrStatus, requestOcrInstallApproval, resetOcrComponentStore } from './ocrComponentStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const status = (installed: boolean, extra: Record<string, unknown> = {}) => ({
  ok: true, message: '', status: { installed, installing: false, version: 'tesseract.js-7.0.0', languages: ['eng', 'chi_sim'], sizeBytes: 12_578_904, path: '/data/ocr/current', ...extra },
});
const text = (renderer: ReturnType<typeof create>) => JSON.stringify(renderer.toJSON());

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  Object.values(client).forEach((fn) => 'mockReset' in fn && fn.mockReset());
  client.isOcrSupported.mockReturnValue(true);
  client.subscribeOcrInstallProgress.mockImplementation(() => () => undefined);
  client.fetchOcrStatus.mockResolvedValue(status(false));
  resetOcrComponentStore();
});

describe('AIOcrBadge', () => {
  it('names each state, with a tooltip that explains it', () => {
    const states = {
      waiting: 'Waiting', running: 'Reading…', done: 'Read', no_text: 'No text', failed: 'Retry', needs_install: 'Install',
    } as const;
    for (const [state, label] of Object.entries(states)) {
      const markup = renderToStaticMarkup(<AIOcrBadge ocr={{ status: state as keyof typeof states, text: 'abc', error: 'boom' }} onRead={() => undefined} />);
      expect(markup).toContain(`>${label}<`);
      expect(markup).toContain(`data-status="${state}"`);
      expect(markup).toContain('title="');
    }
    expect(renderToStaticMarkup(<AIOcrBadge ocr={{ status: 'done', text: 'abcde' }} onRead={() => undefined} />)).toContain('5 characters');
    expect(renderToStaticMarkup(<AIOcrBadge ocr={{ status: 'failed', error: 'worker crashed' }} onRead={() => undefined} />)).toContain('worker crashed');
  });

  it('can be clicked only where there is something to do', () => {
    const onRead = vi.fn();
    for (const [state, clickable] of [['failed', true], ['needs_install', true], ['done', false], ['running', false], ['no_text', false], ['waiting', false]] as const) {
      onRead.mockClear();
      const renderer = create(<AIOcrBadge ocr={{ status: state }} onRead={onRead} />);
      const badge = renderer.root.findByProps({ className: 'gn-ocr-badge' });
      expect(badge.props.role).toBe(clickable ? 'button' : 'status');
      badge.props.onClick?.();
      expect(onRead).toHaveBeenCalledTimes(clickable ? 1 : 0);
    }
  });
});

describe('AIChatAttachmentStrip', () => {
  const image = (ocr?: any) => ({ id: 'a', name: 'a.png', mimeType: 'image/png', size: 1, kind: 'image', dataUrl: 'data:image/png;base64,AA==', ...(ocr ? { ocr } : {}) });

  it('shows the badge only under an image whose text is being read, and passes the click on', () => {
    const onReadImage = vi.fn();
    const plain = create(<AIChatAttachmentStrip attachments={[image() as any]} onRemove={() => undefined} onReadImage={onReadImage} />);
    expect(text(plain)).not.toContain('gn-ocr-badge');
    const reading = create(<AIChatAttachmentStrip attachments={[image({ status: 'failed' }) as any]} onRemove={() => undefined} onReadImage={onReadImage} />);
    expect(text(reading)).toContain('gn-ocr-badge');
    reading.root.findByProps({ className: 'gn-ocr-badge' }).props.onClick();
    expect(onReadImage).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });
});

describe('AIChatComposerActions', () => {
  const markup = (recognizingImages: boolean) => renderToStaticMarkup(
    <AIChatComposerActions
      input="hello" draftAttachmentCount={1} recognizingImages={recognizingImages} sending={false}
      overlayTheme={buildOverlayWorkbenchTheme(false)} fileInputRef={React.createRef() as any}
      onAttachmentUpload={() => undefined} onOpenContext={() => undefined} onSend={() => undefined} onStop={() => undefined}
    />,
  );
  const sendButton = (html: string) => html.match(/<button[^>]*class="ai-chat-send-btn gn-v2-ai-send"[^>]*>/)?.[0] ?? '';

  it('does not let a message go while the text in an image is still being read', () => {
    expect(sendButton(markup(false))).not.toContain('disabled');
    const busy = sendButton(markup(true));
    expect(busy).toContain('disabled=""');
    expect(busy).toContain('title="Reading the text in your images…"');
  });
});

describe('AIOcrInstallModal', () => {
  it('asks the person, with what is downloaded, from where, where it goes and how to remove it', async () => {
    client.fetchOcrStatus.mockResolvedValue(status(false));
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(<AIOcrInstallModal />); });
    expect(text(renderer)).not.toContain('data-modal');

    await act(async () => { void requestOcrInstallApproval(); await refreshOcrStatus(); });
    const shown = text(renderer);
    for (const expected of ['Install the image recognition component?', 'Needs your approval', 'About 12.0 MB', 'tesseract.js', 'jsDelivr', '/data/ocr/current', 'AI settings', 'Not now', 'Install and recognize']) {
      expect(shown).toContain(expected);
    }
  });

  it('shows a failed installation with a way to try again', async () => {
    client.installOcrComponent.mockResolvedValue({ ok: false, message: 'checksum mismatch', status: status(false).status });
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(<AIOcrInstallModal />); });
    await act(async () => { void requestOcrInstallApproval(); await refreshOcrStatus(); });
    const install = renderer.root.findAllByType('button').find((button) => JSON.stringify(button.props.children).includes('Install and recognize'));
    await act(async () => { install?.props.onClick(); });
    expect(text(renderer)).toContain('checksum mismatch');
    expect(text(renderer)).toContain('Try again');
  });

  it('renders nothing where the component cannot be used', () => {
    client.isOcrSupported.mockReturnValue(false);
    expect(create(<AIOcrInstallModal />).toJSON()).toBeNull();
  });
});

describe('AISettingsOcrSection', () => {
  const theme = buildOverlayWorkbenchTheme(false);
  const render = () => create(<AISettingsOcrSection active overlayTheme={theme} cardBg="#fff" cardBorder="#ddd" />);

  it('offers to install when the component is not there', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = render(); });
    const shown = text(renderer);
    expect(shown).toContain('Not installed');
    expect(shown).toContain('Install (12.0 MB)');
    expect(shown).toContain('English · Simplified Chinese');
    expect(shown).not.toContain('Remove');
  });

  it('shows what is installed, with a reinstall and a confirmed removal', async () => {
    client.fetchOcrStatus.mockResolvedValue(status(true));
    client.removeOcrComponent.mockResolvedValue(status(false));
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = render(); });
    const shown = text(renderer);
    expect(shown).toContain('Installed');
    expect(shown).toContain('/data/ocr/current');
    expect(shown).toContain('Reinstall');
    const confirm = renderer.root.findByProps({ 'data-confirm': 'Remove the image recognition component?' });
    await act(async () => { confirm.props.onClick(); });
    expect(client.removeOcrComponent).toHaveBeenCalledTimes(1);
  });

  it('says it is for the desktop app when it cannot be used', async () => {
    client.isOcrSupported.mockReturnValue(false);
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = render(); });
    expect(text(renderer)).toContain('only available in the desktop app');
    expect(client.fetchOcrStatus).not.toHaveBeenCalled();
  });
});
