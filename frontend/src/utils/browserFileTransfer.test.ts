import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadBrowserFileFromResult,
  downloadBrowserTextFile,
  isWebRuntime,
  uploadBrowserFile,
} from './browserFileTransfer';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browser runtime file transfer', () => {
  it('detects the injected web runtime marker', () => {
    vi.stubGlobal('window', { __GONAVI_WEB_RUNTIME__: { buildType: 'web' } });
    expect(isWebRuntime()).toBe(true);
    (globalThis as any).window.__GONAVI_WEB_RUNTIME__.buildType = 'production';
    expect(isWebRuntime()).toBe(false);
  });

  it('streams the selected file as multipart form data to the purpose-scoped upload endpoint', async () => {
    const appended: Array<[string, unknown]> = [];
    const formData = {
      append: (name: string, value: unknown) => { appended.push([name, value]); },
    } as unknown as FormData;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          filePath: 'opaque-upload-token',
          name: 'seed.sql',
          fileSize: 24,
          fileSizeMB: '0.1',
        },
      }),
    }));
    const file = { name: 'seed.sql', size: 24 } as File;

    await expect(uploadBrowserFile(file, 'sql-execution', {
      fetch: fetchMock as unknown as typeof fetch,
      createFormData: () => formData,
    })).resolves.toEqual({
      filePath: 'opaque-upload-token',
      name: 'seed.sql',
      fileSize: 24,
      fileSizeMB: '0.1',
    });

    expect(appended).toEqual([['file', file]]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/__gonavi/api/upload?purpose=sql-execution',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: formData,
      }),
    );
  });

  it('downloads a token through a native anchor without fetching the file body', () => {
    const appended: any[] = [];
    const removed: any[] = [];
    const anchor = {
      href: '',
      download: '',
      clicked: false,
      click() { this.clicked = true; },
    };
    const documentLike = {
      body: {
        appendChild: (node: unknown) => { appended.push(node); },
        removeChild: (node: unknown) => { removed.push(node); },
      },
      createElement: () => anchor,
    } as unknown as Document;

    expect(downloadBrowserFileFromResult({
      data: {
        webDownload: {
          token: 'download/token',
          fileName: 'result.csv',
        },
      },
    }, { document: documentLike })).toBe(true);
    expect(anchor).toMatchObject({
      href: '/__gonavi/api/download/download%2Ftoken',
      download: 'result.csv',
      clicked: true,
    });
    expect(appended).toEqual([anchor]);
    expect(removed).toEqual([anchor]);
  });
});

describe('downloadBrowserTextFile', () => {
  it('creates a browser download and releases its object URL', () => {
    const created: Array<{ href: string; download: string; clicked: boolean }> = [];
    const removed: unknown[] = [];
    const revoked: string[] = [];
    const body = {
      appendChild: (node: unknown) => { created.push(node as { href: string; download: string; clicked: boolean }); },
      removeChild: (node: unknown) => { removed.push(node); },
    };
    const documentLike = {
      body,
      createElement: () => ({
        href: '',
        download: '',
        clicked: false,
        click() { this.clicked = true; },
      }),
    } as unknown as Document;
    const urlLike = {
      createObjectURL: () => 'blob:connection-package',
      revokeObjectURL: (value: string) => { revoked.push(value); },
    } as unknown as typeof URL;

    const downloaded = downloadBrowserTextFile('package-content', 'connections.gonavi-conn', 'application/json', {
      document: documentLike,
      url: urlLike,
    });

    expect(downloaded).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ href: 'blob:connection-package', download: 'connections.gonavi-conn', clicked: true });
    expect(removed).toHaveLength(1);
    expect(revoked).toEqual(['blob:connection-package']);
  });
});
