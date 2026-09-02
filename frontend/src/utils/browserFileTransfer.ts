type BrowserFileDownloadEnvironment = {
  document?: Pick<Document, 'body' | 'createElement'>;
  url?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
};

type BrowserFileUploadEnvironment = {
  fetch?: typeof fetch;
  createFormData?: () => FormData;
};

export type BrowserFileUploadPurpose = 'data-import' | 'sql-execution';

export type BrowserUploadedFile = {
  filePath: string;
  name: string;
  fileSize: number;
  fileSizeMB: string;
};

export type BrowserFileDownload = {
  token: string;
  fileName: string;
  mimeType?: string;
  fileSize?: number;
};

type BrowserDownloadResult = {
  data?: {
    webDownload?: Partial<BrowserFileDownload>;
  };
};

export const isWebRuntime = (): boolean => typeof window !== 'undefined'
  && (window as any).__GONAVI_WEB_RUNTIME__?.buildType === 'web';

export const uploadBrowserFile = async (
  file: File,
  purpose: BrowserFileUploadPurpose,
  environment: BrowserFileUploadEnvironment = {},
): Promise<BrowserUploadedFile> => {
  const fetchImpl = environment.fetch ?? (typeof fetch === 'undefined' ? undefined : fetch);
  const createFormData = environment.createFormData
    ?? (typeof FormData === 'undefined' ? undefined : () => new FormData());
  if (!fetchImpl || !createFormData) {
    throw new Error('Browser file upload is unavailable');
  }

  const formData = createFormData();
  formData.append('file', file);
  const response = await fetchImpl(
    `/__gonavi/api/upload?purpose=${encodeURIComponent(purpose)}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      body: formData,
    },
  );
  let payload: any;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Browser file upload failed (${response.status})`);
  }
  if (!response.ok || payload?.success !== true) {
    throw new Error(String(payload?.message || payload?.error || `Browser file upload failed (${response.status})`));
  }

  const data = payload?.data || {};
  const filePath = String(data.filePath || '').trim();
  if (!filePath) {
    throw new Error('Browser file upload returned no file token');
  }
  const fileSize = Number.isFinite(Number(data.fileSize))
    ? Math.max(0, Number(data.fileSize))
    : Math.max(0, Number(file.size) || 0);
  return {
    filePath,
    name: String(data.name || file.name || '').trim(),
    fileSize,
    fileSizeMB: String(data.fileSizeMB || '').trim(),
  };
};

/** Trigger an authenticated browser download without buffering the response in JavaScript. */
export const downloadBrowserFile = (
  download: BrowserFileDownload,
  environment: Pick<BrowserFileDownloadEnvironment, 'document'> = {},
): boolean => {
  const token = String(download?.token || '').trim();
  const fileName = String(download?.fileName || '').trim();
  const documentRef = environment.document ?? (typeof document === 'undefined' ? undefined : document);
  if (!token || !fileName || !documentRef?.body) {
    return false;
  }

  const anchor = documentRef.createElement('a');
  anchor.href = `/__gonavi/api/download/${encodeURIComponent(token)}`;
  anchor.download = fileName;
  documentRef.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    documentRef.body.removeChild(anchor);
  }
  return true;
};

/** Desktop results have no webDownload. Treat that as success and leave them untouched. */
export const downloadBrowserFileFromResult = (
  result: BrowserDownloadResult | null | undefined,
  environment: Pick<BrowserFileDownloadEnvironment, 'document'> = {},
): boolean => {
  const descriptor = result?.data?.webDownload;
  if (descriptor === undefined) {
    return true;
  }
  return downloadBrowserFile({
    token: String(descriptor.token || ''),
    fileName: String(descriptor.fileName || ''),
    mimeType: descriptor.mimeType,
    fileSize: descriptor.fileSize,
  }, environment);
};

/** Trigger a local browser download without asking the server to write a client-side path. */
export const downloadBrowserTextFile = (
  content: string,
  filename: string,
  contentType: string,
  environment: BrowserFileDownloadEnvironment = {},
): boolean => {
  const documentRef = environment.document ?? (typeof document === 'undefined' ? undefined : document);
  const urlRef = environment.url ?? (typeof URL === 'undefined' ? undefined : URL);
  if (!documentRef?.body || !urlRef?.createObjectURL || !urlRef.revokeObjectURL) {
    return false;
  }

  const url = urlRef.createObjectURL(new Blob([content], { type: contentType }));
  const anchor = documentRef.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  documentRef.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    documentRef.body.removeChild(anchor);
    urlRef.revokeObjectURL(url);
  }
  return true;
};
