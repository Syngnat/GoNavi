import { OCRCancelInstall, OCRGetStatus, OCRInstall, OCRRemove, OCRServe } from '../../../../wailsjs/go/app/App';
import { EventsOn } from '../../../../wailsjs/runtime/runtime';
import { isWebRuntime } from '../../../utils/browserFileTransfer';
import type { OcrServiceConfig } from './ocrEngine';

/**
 * The text-recognition component as the desktop manages it (see internal/ocr and
 * internal/app/methods_ocr.go): installed on request, served on a local address for
 * the recognition worker, removable. This module only calls those bindings and
 * reads their results.
 */

export interface OcrComponentStatus {
  installed: boolean;
  installing: boolean;
  version: string;
  languages: string[];
  /** What the component takes on disk when installed, and what installing it downloads. */
  sizeBytes: number;
  path: string;
  /** Set on the result of an installation the person canceled. */
  canceled?: boolean;
}

export interface OcrInstallProgress {
  phase: string;
  file?: string;
  downloaded: number;
  total: number;
  percent: number;
}

export interface OcrCallResult {
  ok: boolean;
  message: string;
  status?: OcrComponentStatus;
}

export const OCR_INSTALL_PROGRESS_EVENT = 'ocr:install-progress';

/** The component is served on this machine's loopback: a browser-served session cannot reach it. */
export const isOcrSupported = (): boolean => !isWebRuntime();

const asStatus = (data: unknown): OcrComponentStatus | undefined => {
  if (!data || typeof data !== 'object') return undefined;
  const value = data as Record<string, unknown>;
  if (typeof value.installed !== 'boolean') return undefined;
  return {
    installed: value.installed,
    installing: value.installing === true,
    version: String(value.version || ''),
    languages: Array.isArray(value.languages) ? value.languages.map(String) : [],
    sizeBytes: Number(value.sizeBytes) || 0,
    path: String(value.path || ''),
    ...(value.canceled === true ? { canceled: true } : {}),
  };
};

const call = async (invoke: () => Promise<{ success?: boolean; message?: string; data?: unknown }>): Promise<OcrCallResult> => {
  try {
    const result = await invoke();
    return { ok: result?.success === true, message: String(result?.message || ''), status: asStatus(result?.data) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
};

export const fetchOcrStatus = (): Promise<OcrCallResult> => call(OCRGetStatus);

/** Downloads and verifies the component; resolves when it is done, failed or canceled. */
export const installOcrComponent = (): Promise<OcrCallResult> => call(OCRInstall);

export const cancelOcrInstall = (): Promise<OcrCallResult> => call(OCRCancelInstall);

export const removeOcrComponent = (): Promise<OcrCallResult> => call(OCRRemove);

/** The address the recognition worker loads its files from, or why there is none. */
export const fetchOcrServiceConfig = async (): Promise<{ config?: OcrServiceConfig; message: string }> => {
  try {
    const result = await OCRServe();
    const data = (result?.data ?? {}) as { baseUrl?: unknown; languages?: unknown };
    if (result?.success === true && typeof data.baseUrl === 'string' && data.baseUrl) {
      const languages = Array.isArray(data.languages) ? data.languages.map(String) : [];
      return { config: { baseUrl: data.baseUrl, languages }, message: '' };
    }
    return { message: String(result?.message || '') };
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error) };
  }
};

/** Progress of a running installation. Returns the function that stops listening. */
export const subscribeOcrInstallProgress = (listener: (progress: OcrInstallProgress) => void): (() => void) => {
  try {
    return EventsOn(OCR_INSTALL_PROGRESS_EVENT, (payload: unknown) => {
      const value = (payload ?? {}) as Record<string, unknown>;
      listener({
        phase: String(value.phase || ''),
        file: value.file ? String(value.file) : undefined,
        downloaded: Number(value.downloaded) || 0,
        total: Number(value.total) || 0,
        percent: Number(value.percent) || 0,
      });
    });
  } catch {
    return () => undefined;
  }
};
