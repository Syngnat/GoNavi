import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
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
const engine = vi.hoisted(() => ({ recognizeImageText: vi.fn() }));

vi.mock('./ocrComponentClient', () => client);
vi.mock('./ocrEngine', () => engine);

import type { AIChatAttachment } from '../../../types';
import {
  approveOcrInstall,
  getOcrComponentState,
  refreshOcrStatus,
  resetOcrComponentStore,
} from './ocrComponentStore';
import { providerNeedsImageText, useAIImageOcr } from './useAIImageOcr';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const builtin = { id: 'gonavi-ai' };
const openai = { id: 'openai-main' };
const service = { config: { baseUrl: 'http://127.0.0.1:1/t', languages: ['eng'] }, message: '' };
const status = (installed: boolean) => ({ ok: true, message: '', status: { installed, installing: false, version: 'v1', languages: ['eng'], sizeBytes: 1, path: '/p' } });

const image = (id = 'img-1'): AIChatAttachment => ({ id, name: `${id}.png`, mimeType: 'image/png', size: 10, kind: 'image', dataUrl: 'data:image/png;base64,AA==' });
const document = (): AIChatAttachment => ({ id: 'doc-1', name: 'notes.md', mimeType: 'text/markdown', size: 10, kind: 'markdown', text: '# hi' });

interface Probe {
  ocr: ReturnType<typeof useAIImageOcr>;
  attachments: AIChatAttachment[];
  add: (attachment: AIChatAttachment) => void;
}

const mount = (provider: { id: string } | null, initial: AIChatAttachment[] = []) => {
  const probe = {} as Probe;
  const Harness: React.FC<{ provider: { id: string } | null }> = ({ provider: current }) => {
    const [attachments, setAttachments] = React.useState(initial);
    const ocr = useAIImageOcr({ provider: current, draftAttachments: attachments, setDraftAttachments: setAttachments });
    probe.ocr = ocr;
    probe.attachments = attachments;
    probe.add = (attachment) => { setAttachments((previous) => [...previous, attachment]); ocr.onAttachmentAdded(attachment); };
    return null;
  };
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<Harness provider={provider} />); });
  return { probe, rerender: (next: { id: string } | null) => act(() => renderer.update(<Harness provider={next} />)) };
};

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const statusOf = (probe: Probe, id = 'img-1') => probe.attachments.find((item) => item.id === id)?.ocr;

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  Object.values(client).forEach((fn) => 'mockReset' in fn && fn.mockReset());
  engine.recognizeImageText.mockReset();
  client.isOcrSupported.mockReturnValue(true);
  client.subscribeOcrInstallProgress.mockImplementation(() => () => undefined);
  client.fetchOcrServiceConfig.mockResolvedValue(service);
  client.fetchOcrStatus.mockResolvedValue(status(true));
  engine.recognizeImageText.mockResolvedValue({ text: 'SELECT 1', confidence: 90 });
  resetOcrComponentStore();
});

describe('providerNeedsImageText', () => {
  it('is for the built-in model and for any provider that says it cannot see images', () => {
    expect(providerNeedsImageText(builtin)).toBe(true);
    expect(providerNeedsImageText({ id: 'x', supportsImages: false })).toBe(true);
    expect(providerNeedsImageText(openai)).toBe(false);
    expect(providerNeedsImageText({ id: 'x', supportsImages: true })).toBe(false);
    expect(providerNeedsImageText(null)).toBe(false);
  });
});

describe('useAIImageOcr', () => {
  it('reads an image added for the built-in model and keeps the text on the attachment', async () => {
    const { probe } = mount(builtin);
    act(() => probe.add(image()));
    await settle();
    expect(statusOf(probe)).toEqual({ status: 'done', text: 'SELECT 1' });
    expect(engine.recognizeImageText).toHaveBeenCalledWith('data:image/png;base64,AA==', service.config);
    expect(probe.ocr.recognizing).toBe(false);
  });

  it('shows the image as being read while it is, so a message is not sent without its text', async () => {
    let finish: (value: unknown) => void = () => undefined;
    engine.recognizeImageText.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { probe } = mount(builtin);
    act(() => probe.add(image()));
    await settle();
    expect(statusOf(probe)?.status).toBe('running');
    expect(probe.ocr.recognizing).toBe(true);
    await act(async () => { finish({ text: 'done now', confidence: 80 }); });
    expect(probe.ocr.recognizing).toBe(false);
    expect(statusOf(probe)?.text).toBe('done now');
  });

  it('leaves images alone for a model that can see them, and files that are not images', async () => {
    const { probe } = mount(openai);
    act(() => probe.add(image()));
    act(() => probe.add(document()));
    await settle();
    expect(engine.recognizeImageText).not.toHaveBeenCalled();
    expect(statusOf(probe)).toBeUndefined();

    const built = mount(builtin);
    act(() => built.probe.add(document()));
    await settle();
    expect(engine.recognizeImageText).not.toHaveBeenCalled();
  });

  it('asks before installing, then reads the image once the person agrees', async () => {
    client.fetchOcrStatus.mockResolvedValue(status(false));
    const { probe } = mount(builtin);
    act(() => probe.add(image()));
    await settle();
    expect(getOcrComponentState().promptOpen).toBe(true);
    expect(statusOf(probe)?.status).toBe('waiting');
    expect(probe.ocr.recognizing).toBe(true);
    expect(engine.recognizeImageText).not.toHaveBeenCalled();

    client.installOcrComponent.mockResolvedValue(status(true));
    await act(async () => { await approveOcrInstall(); });
    await settle();
    expect(statusOf(probe)?.status).toBe('done');
  });

  it('marks an image as needing the component after "not now", and reads it once the component is installed', async () => {
    client.fetchOcrStatus.mockResolvedValue(status(false));
    localStorage.setItem('gonavi.ocr.install_prompt', 'declined');
    const { probe } = mount(builtin);
    act(() => probe.add(image()));
    await settle();
    expect(statusOf(probe)?.status).toBe('needs_install');
    expect(getOcrComponentState().promptOpen).toBe(false);
    expect(probe.ocr.recognizing).toBe(false);

    // Installed elsewhere (the settings page): the image that was waiting for it is read.
    client.fetchOcrStatus.mockResolvedValue(status(true));
    await act(async () => { await refreshOcrStatus(); });
    await settle();
    expect(statusOf(probe)?.status).toBe('done');
  });

  it('reports a failure and reads again when asked', async () => {
    engine.recognizeImageText.mockRejectedValueOnce(new Error('engine crashed'));
    const { probe } = mount(builtin);
    act(() => probe.add(image()));
    await settle();
    expect(statusOf(probe)).toEqual({ status: 'failed', error: 'engine crashed' });

    act(() => probe.ocr.readNow(probe.attachments[0]));
    await settle();
    expect(statusOf(probe)).toEqual({ status: 'done', text: 'SELECT 1' });
  });

  it('says so when there is no text in the image', async () => {
    engine.recognizeImageText.mockResolvedValue({ text: ' . , ', confidence: 3 });
    const { probe } = mount(builtin);
    act(() => probe.add(image()));
    await settle();
    expect(statusOf(probe)).toEqual({ status: 'no_text' });
  });

  it('reports why the file service is not available', async () => {
    client.fetchOcrServiceConfig.mockResolvedValue({ message: 'not installed' });
    const { probe } = mount(builtin);
    act(() => probe.add(image()));
    await settle();
    expect(statusOf(probe)).toEqual({ status: 'failed', error: 'not installed' });
  });

  it('reads images that were attached before switching to a model that cannot see them', async () => {
    const { probe, rerender } = mount(openai, [image('early')]);
    await settle();
    expect(engine.recognizeImageText).not.toHaveBeenCalled();
    rerender(builtin);
    await settle();
    expect(statusOf(probe, 'early')?.status).toBe('done');
  });

  it('reads each image once however often the state changes', async () => {
    const { probe } = mount(builtin);
    act(() => probe.add(image('a')));
    act(() => probe.add(image('b')));
    await settle();
    await settle();
    expect(engine.recognizeImageText).toHaveBeenCalledTimes(2);
    expect(statusOf(probe, 'a')?.status).toBe('done');
    expect(statusOf(probe, 'b')?.status).toBe('done');
  });

  it('ignores a second request for an image that is already being read', async () => {
    const { probe } = mount(builtin, [image('busy')]);
    act(() => {
      probe.ocr.readNow(probe.attachments[0]);
      probe.ocr.readNow(probe.attachments[0]);
    });
    await settle();
    expect(engine.recognizeImageText).toHaveBeenCalledTimes(1);
  });

  it('does nothing where the component cannot be used (the browser-served runtime)', async () => {
    client.isOcrSupported.mockReturnValue(false);
    const { probe } = mount(builtin);
    act(() => probe.add(image()));
    await settle();
    expect(probe.ocr.wanted).toBe(false);
    expect(statusOf(probe)).toBeUndefined();
  });
});
