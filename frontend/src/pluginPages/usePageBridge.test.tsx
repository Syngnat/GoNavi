/** @vitest-environment jsdom */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ pageCall: vi.fn(() => Promise.resolve({ ok: true })) }));
vi.mock('./api', () => api);
vi.mock('../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { usePageBridge } from './usePageBridge';

const TOKEN = 'frame-token-1';
const Harness = ({ frame, enabled = true, token = TOKEN }: { frame: HTMLIFrameElement; enabled?: boolean; token?: string }) => {
  const ref = React.useRef<HTMLIFrameElement | null>(frame);
  usePageBridge({ frameRef: ref, pluginID: 'test.pages', pageID: 'overview', token, enabled });
  return null;
};

const message = { type: 'gonavi:page-call', token: TOKEN, id: 'r1', method: 'app.info', arguments: {} };
let renderer: ReactTestRenderer | undefined;
const frames: HTMLIFrameElement[] = [];

const addFrame = () => {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  frames.push(frame);
  return frame;
};

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  frames.splice(0).forEach((frame) => frame.remove());
  vi.clearAllMocks();
});

describe('usePageBridge', () => {
  it('ignores messages from another window and accepts only its own frame', async () => {
    const frame = addFrame();
    const foreign = addFrame();
    act(() => {
      renderer = create(<Harness frame={frame} />);
    });
    window.dispatchEvent(new MessageEvent('message', { data: message, source: foreign.contentWindow }));
    await act(async () => undefined);
    expect(api.pageCall).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent('message', { data: message, source: frame.contentWindow }));
    await act(async () => undefined);
    expect(api.pageCall).toHaveBeenCalledWith('test.pages', 'overview', 'app.info', '{}');
  });

  it('routes results over the per-document port instead of the frame window', async () => {
    const frame = addFrame();
    let resolve!: (value: { ok: boolean }) => void;
    api.pageCall.mockReturnValueOnce(new Promise<{ ok: boolean }>(yes => { resolve = yes; }));
    const port = { postMessage: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null, close: vi.fn() };
    const framePost = vi.spyOn(frame.contentWindow!, 'postMessage');
    act(() => { renderer = create(<Harness frame={frame} />); });
    const ready = new MessageEvent('message', { data: { type: 'gonavi:page-ready', token: TOKEN }, source: frame.contentWindow });
    Object.defineProperty(ready, 'ports', { value: [port] });
    window.dispatchEvent(ready);
    port.onmessage!(new MessageEvent('message', { data: message }));
    await act(async () => undefined);
    expect(api.pageCall).toHaveBeenCalledWith('test.pages', 'overview', 'app.info', '{}');
    framePost.mockClear();
    await act(async () => { resolve({ ok: true }); });
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'gonavi:page-result', id: 'r1', ok: true }));
    expect(framePost).not.toHaveBeenCalled();
    port.close.mockClear(); framePost.mockRestore();
  });

  it('drops a message whose token does not match the frame token', async () => {
    const frame = addFrame();
    act(() => {
      renderer = create(<Harness frame={frame} />);
    });
    window.dispatchEvent(new MessageEvent('message', {
      data: { ...message, token: 'another-frame' },
      source: frame.contentWindow,
    }));
    await act(async () => undefined);
    expect(api.pageCall).not.toHaveBeenCalled();
  });

  it.each(['disable', 'unmount', 'token'])('drops pending responses after %s without crossing frame identity', async mode => {
    const frame = addFrame(); const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    let resolve!: (value: { ok: boolean }) => void;
    api.pageCall.mockReturnValueOnce(new Promise<{ ok: boolean }>(yes => { resolve = yes; }));
    act(() => { renderer = create(<Harness frame={frame} />); });
    window.dispatchEvent(new MessageEvent('message', { data: message, source: frame.contentWindow }));
    await act(async () => undefined);
    expect(api.pageCall).toHaveBeenCalledTimes(1);
    if (mode === 'unmount') { act(() => renderer!.unmount()); renderer = undefined; }
    else act(() => renderer!.update(<Harness frame={frame} enabled={mode !== 'disable'} token={mode === 'token' ? 'new-token' : TOKEN} />));
    post.mockClear();
    await act(async () => { resolve({ ok: true }); });
    expect(post).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent('message', { data: message, source: frame.contentWindow }));
    await act(async () => undefined);
    expect(api.pageCall).toHaveBeenCalledTimes(1);
    post.mockRestore();
  });
  it('stops listening once the page is not available anymore', async () => {
    const frame = addFrame();
    act(() => {
      renderer = create(<Harness frame={frame} enabled={false} />);
    });
    window.dispatchEvent(new MessageEvent('message', { data: message, source: frame.contentWindow }));
    await act(async () => undefined);
    expect(api.pageCall).not.toHaveBeenCalled();
  });
});
