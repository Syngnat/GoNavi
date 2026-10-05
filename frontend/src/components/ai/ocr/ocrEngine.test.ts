import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock('tesseract.js', () => ({ createWorker: mocks.createWorker }));
vi.mock('./ocrImagePrepare', () => ({ prepareImageForOcr: mocks.prepare }));

import {
  OCR_RECOGNIZE_TIMEOUT_MS,
  OCR_WORKER_IDLE_MS,
  ocrTimings,
  OcrEngineError,
  buildWorkerOptions,
  coreFileName,
  disposeOcrEngine,
  recognizeImageText,
  supportsWasmSimd,
} from './ocrEngine';

const config = { baseUrl: 'http://127.0.0.1:5000/token', languages: ['eng', 'chi_sim'] };

interface FakeWorker {
  recognize: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

const fakeWorker = (text = 'SELECT 1', confidence = 90): FakeWorker => ({
  recognize: vi.fn(async () => ({ data: { text, confidence } })),
  terminate: vi.fn(async () => undefined),
});

beforeEach(() => {
  mocks.createWorker.mockReset();
  mocks.prepare.mockReset();
  mocks.prepare.mockResolvedValue(new Blob(['png']));
});

afterEach(async () => {
  ocrTimings.idleMs = OCR_WORKER_IDLE_MS;
  ocrTimings.recognizeMs = OCR_RECOGNIZE_TIMEOUT_MS;
  await disposeOcrEngine();
});

describe('worker options', () => {
  it('load everything from the local file service, not from the internet', () => {
    const options = buildWorkerOptions({ ...config, baseUrl: `${config.baseUrl}/` }, true);
    expect(options.workerPath).toBe('http://127.0.0.1:5000/token/worker.min.js');
    expect(options.langPath).toBe('http://127.0.0.1:5000/token/lang');
    expect(options.corePath).toBe('http://127.0.0.1:5000/token/core/tesseract-core-simd-lstm.wasm.js');
    expect(options.gzip).toBe(true);
    expect(options.cacheMethod).toBe('none');
    expect(options.legacyCore).toBe(false);
  });

  it('use the plain core where the web view has no SIMD, and name only files the component installs', () => {
    expect(buildWorkerOptions(config, false).corePath).toMatch(/\/core\/tesseract-core-lstm\.wasm\.js$/);
    expect(coreFileName(true)).toBe('tesseract-core-simd-lstm.wasm.js');
    expect(coreFileName(false)).toBe('tesseract-core-lstm.wasm.js');
  });

  it('detect SIMD support without throwing', () => {
    const validate = vi.spyOn(WebAssembly, 'validate');
    validate.mockReturnValueOnce(true);
    expect(supportsWasmSimd()).toBe(true);
    validate.mockReturnValueOnce(false);
    expect(supportsWasmSimd()).toBe(false);
    validate.mockImplementationOnce(() => { throw new Error('no wasm'); });
    expect(supportsWasmSimd()).toBe(false);
    validate.mockRestore();
  });
});

describe('recognizeImageText', () => {
  it('returns the cleaned text and confidence, starting one worker and reusing it', async () => {
    const worker = fakeWorker('查 询 订 单\n\n\n\nSELECT 1', 87.5);
    mocks.createWorker.mockResolvedValue(worker);

    const first = await recognizeImageText('data:image/png;base64,AA==', config);
    const second = await recognizeImageText('data:image/png;base64,BB==', config);

    expect(first).toEqual({ text: '查询订单\n\nSELECT 1', confidence: 87.5 });
    expect(second.text).toBe(first.text);
    expect(mocks.createWorker).toHaveBeenCalledTimes(1);
    expect(mocks.createWorker.mock.calls[0][0]).toEqual(['eng', 'chi_sim']);
    expect(mocks.createWorker.mock.calls[0][2].workerPath).toBe('http://127.0.0.1:5000/token/worker.min.js');
    expect(worker.recognize).toHaveBeenCalledTimes(2);
  });

  it('starts a new worker when the file service has moved', async () => {
    const old = fakeWorker();
    const fresh = fakeWorker();
    mocks.createWorker.mockResolvedValueOnce(old).mockResolvedValueOnce(fresh);
    await recognizeImageText('data:image/png;base64,AA==', config);
    await recognizeImageText('data:image/png;base64,AA==', { ...config, baseUrl: 'http://127.0.0.1:6000/other' });
    expect(old.terminate).toHaveBeenCalled();
    expect(fresh.recognize).toHaveBeenCalledTimes(1);
  });

  it('reads one image after another, never two at once', async () => {
    let releaseFirst: (value: unknown) => void = () => undefined;
    const order: string[] = [];
    const worker = fakeWorker();
    worker.recognize
      .mockImplementationOnce(() => new Promise((resolve) => { order.push('first started'); releaseFirst = resolve; }))
      .mockImplementationOnce(async () => { order.push('second started'); return { data: { text: 'two', confidence: 1 } }; });
    mocks.createWorker.mockResolvedValue(worker);

    const first = recognizeImageText('data:image/png;base64,AA==', config);
    const second = recognizeImageText('data:image/png;base64,BB==', config);
    await vi.waitFor(() => expect(order).toEqual(['first started']));
    releaseFirst({ data: { text: 'one', confidence: 1 } });
    expect((await first).text).toBe('one');
    expect((await second).text).toBe('two');
    expect(order).toEqual(['first started', 'second started']);
  });

  it('does not trust a worker that failed with the next image', async () => {
    const broken = fakeWorker();
    broken.recognize.mockRejectedValueOnce(new Error('wasm trap'));
    const fresh = fakeWorker('after');
    mocks.createWorker.mockResolvedValueOnce(broken).mockResolvedValueOnce(fresh);

    await expect(recognizeImageText('data:image/png;base64,AA==', config)).rejects.toMatchObject({ name: 'OcrEngineError', reason: 'engine', message: 'wasm trap' });
    expect(broken.terminate).toHaveBeenCalled();
    expect((await recognizeImageText('data:image/png;base64,AA==', config)).text).toBe('after');
  });

  it('retries starting the engine after a failure to start it', async () => {
    mocks.createWorker.mockRejectedValueOnce(new Error('could not load worker')).mockResolvedValueOnce(fakeWorker('ok'));
    await expect(recognizeImageText('data:image/png;base64,AA==', config)).rejects.toBeInstanceOf(OcrEngineError);
    expect((await recognizeImageText('data:image/png;base64,AA==', config)).text).toBe('ok');
  });

  it('passes on a problem with the image itself without starting an engine', async () => {
    mocks.prepare.mockRejectedValueOnce(Object.assign(new Error('too large'), { reason: 'too_large' }));
    await expect(recognizeImageText('data:image/png;base64,AA==', config)).rejects.toMatchObject({ reason: 'too_large' });
    expect(mocks.createWorker).not.toHaveBeenCalled();
  });

  it('gives up on an image that takes too long, and drops the worker', async () => {
    ocrTimings.recognizeMs = 30;
    const worker = fakeWorker();
    worker.recognize.mockImplementation(() => new Promise(() => undefined));
    mocks.createWorker.mockResolvedValue(worker);

    await expect(recognizeImageText('data:image/png;base64,AA==', config)).rejects.toMatchObject({ name: 'OcrEngineError', reason: 'timeout' });
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('releases an idle worker after a while', async () => {
    ocrTimings.idleMs = 30;
    const worker = fakeWorker();
    mocks.createWorker.mockResolvedValue(worker);
    await recognizeImageText('data:image/png;base64,AA==', config);
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledTimes(1));
  });

  it('keeps a worker that is used again before it idles out', async () => {
    ocrTimings.idleMs = 200;
    const worker = fakeWorker();
    mocks.createWorker.mockResolvedValue(worker);
    await recognizeImageText('data:image/png;base64,AA==', config);
    await recognizeImageText('data:image/png;base64,AA==', config);
    expect(mocks.createWorker).toHaveBeenCalledTimes(1);
    expect(worker.terminate).not.toHaveBeenCalled();
  });
});
