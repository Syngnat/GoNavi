import type { Worker as TesseractWorker } from 'tesseract.js';

import { prepareImageForOcr } from './ocrImagePrepare';
import { normalizeRecognizedText } from './ocrText';

/**
 * The recognizer: tesseract.js in a web worker. Its worker script, WebAssembly core
 * and language data are the installed component (see internal/ocr), served by the
 * desktop on a local address; none of it is bundled or fetched from the internet
 * here. A worker takes a second or two to start and holds some memory, so one is
 * kept for a while after use and then released.
 */

export interface OcrServiceConfig {
  /** URL prefix the component's files are served under. */
  baseUrl: string;
  /** Language data to load, e.g. ["eng", "chi_sim"]. */
  languages: string[];
}

export interface OcrRecognition {
  text: string;
  /** 0-100, as reported by the recognizer. */
  confidence: number;
}

export class OcrEngineError extends Error {
  constructor(readonly reason: 'timeout' | 'engine', message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'OcrEngineError';
  }
}

/** How long an idle worker is kept, and the longest a single image may take. */
export const OCR_WORKER_IDLE_MS = 90_000;
export const OCR_RECOGNIZE_TIMEOUT_MS = 120_000;

/** The limits in force; a variable only so that tests can use short ones. */
export const ocrTimings = { idleMs: OCR_WORKER_IDLE_MS, recognizeMs: OCR_RECOGNIZE_TIMEOUT_MS };

const WASM_SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

export const supportsWasmSimd = (): boolean => {
  try {
    return typeof WebAssembly === 'object' && WebAssembly.validate(WASM_SIMD_PROBE);
  } catch {
    return false;
  }
};

/** The installed component has the plain and the SIMD build of the LSTM core. */
export const coreFileName = (simd: boolean): string => (simd ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js');

export const buildWorkerOptions = (config: OcrServiceConfig, simd: boolean) => {
  const base = config.baseUrl.replace(/\/+$/, '');
  return {
    workerPath: `${base}/worker.min.js`,
    // A single file rather than a directory: only the two builds above are installed.
    corePath: `${base}/core/${coreFileName(simd)}`,
    langPath: `${base}/lang`,
    gzip: true,
    // Everything is local: nothing is cached in the browser's storage.
    cacheMethod: 'none' as const,
    legacyCore: false,
    legacyLang: false,
    workerBlobURL: true,
  };
};

const LSTM_ONLY = 1;

let held: { key: string; worker: Promise<TesseractWorker> } | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let jobs: Promise<unknown> = Promise.resolve();

const keyOf = (config: OcrServiceConfig): string => `${config.baseUrl}|${config.languages.join('+')}`;

const clearIdleTimer = () => {
  if (idleTimer !== undefined) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
};

/** Stops the worker and frees its memory. A later recognition starts a new one. */
export const disposeOcrEngine = async (): Promise<void> => {
  clearIdleTimer();
  const current = held;
  held = null;
  if (!current) return;
  try {
    await (await current.worker).terminate();
  } catch {
    // It never started, or is already gone.
  }
};

const startWorker = (config: OcrServiceConfig): Promise<TesseractWorker> => {
  const worker = import('tesseract.js').then(({ createWorker }) => (
    createWorker(config.languages, LSTM_ONLY as never, buildWorkerOptions(config, supportsWasmSimd()))
  ));
  worker.catch(() => {
    if (held?.worker === worker) held = null;
  });
  return worker;
};

const workerFor = (config: OcrServiceConfig): Promise<TesseractWorker> => {
  const key = keyOf(config);
  if (held && held.key !== key) {
    // The file service moved (the app restarted it): the old worker points nowhere.
    void disposeOcrEngine();
  }
  if (!held) {
    held = { key, worker: startWorker(config) };
  }
  return held.worker;
};

const withTimeout = <T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => {
    onTimeout();
    reject(new OcrEngineError('timeout', `recognition took longer than ${Math.round(ms / 1000)}s`));
  }, ms);
  work.then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); },
  );
});

const recognizeOnce = async (dataUrl: string, config: OcrServiceConfig): Promise<OcrRecognition> => {
  // Reading the image can fail on its own account (too large, not decodable).
  const image = await prepareImageForOcr(dataUrl);
  clearIdleTimer();
  try {
    const worker = await workerFor(config);
    const result = await withTimeout(worker.recognize(image), ocrTimings.recognizeMs, () => { void disposeOcrEngine(); });
    return { text: normalizeRecognizedText(result.data.text), confidence: Number(result.data.confidence) || 0 };
  } catch (error) {
    if (error instanceof OcrEngineError) throw error;
    // A worker that failed is not trusted with the next image.
    await disposeOcrEngine();
    throw new OcrEngineError('engine', error instanceof Error ? error.message : String(error), error);
  } finally {
    if (held) idleTimer = setTimeout(() => { void disposeOcrEngine(); }, ocrTimings.idleMs);
  }
};

/** Recognizes the text in an image (a data URL). Images are read one after another. */
export const recognizeImageText = (dataUrl: string, config: OcrServiceConfig): Promise<OcrRecognition> => {
  const run = jobs.then(() => recognizeOnce(dataUrl, config));
  jobs = run.catch(() => undefined);
  return run;
};
