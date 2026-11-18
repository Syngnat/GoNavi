import { useBackgroundImageStore } from '../backgroundImageStore';
import { validGalleryId, validGalleryVersion } from '../backgroundImageStorePersistence';
import { getGalleryAdapter } from '../backgroundGallery/adapter';
import type { GalleryEntry, GalleryInstalled, GalleryProgress, GalleryState } from '../backgroundGallery/types';
import { isBackgroundImageDataUrl } from '../utils/backgroundImage';
import { PluginAPIError } from '../plugins/apiResult';
import type { JSONValue } from '../plugins/types';

// Appearance settings live in the host window (localStorage + gallery adapters), so
// these page capabilities stay in the frontend instead of crossing the Go gateway.
export const APPEARANCE_READ_PERMISSION = 'host.appearance.read';
export const APPEARANCE_WRITE_PERMISSION = 'host.appearance.write';
export const APPEARANCE_MAX_ARGUMENT_BYTES = 2 * 1024 * 1024;

const READ_METHODS = new Set([
  'appearance.background.state',
  'appearance.background.image',
  'appearance.gallery.state',
  'appearance.gallery.thumbnail',
]);
const WRITE_METHODS = new Set([
  'appearance.background.set-custom',
  'appearance.background.clear',
  'appearance.background.reset',
  'appearance.background.set-enabled',
  'appearance.background.set-opacity',
  'appearance.background.set-position',
  'appearance.background.select-builtin',
  'appearance.background.cancel-builtin',
  'appearance.background.resolve',
  'appearance.gallery.refresh',
  'appearance.gallery.download',
  'appearance.gallery.cancel',
  'appearance.gallery.remove',
]);

export const isAppearanceMethod = (method: string): boolean => (
  READ_METHODS.has(method) || WRITE_METHODS.has(method)
);

interface GalleryEntryView {
  id: string;
  version: string;
  names: Record<string, string>;
  fit: 'contain' | 'cover';
  attribution: string;
  sourceUrl: string;
  license: { name: string; url: string; nonCommercial: boolean };
  downloaded: boolean;
  selected: boolean;
}

interface DownloadState {
  requestId: string;
  id: string;
  version: string;
  phase: string;
  downloaded: number;
  total: number;
  done: boolean;
  error: string | null;
}

let galleryState: GalleryState | null = null;
let galleryEntries = new Map<string, GalleryEntry>();
let galleryError: string | null = null;
let thumbnails = new Map<string, string>();
let galleryPreview = { key: '', dataUrl: '' };
let download: DownloadState | null = null;
let selection: DownloadState | null = null;
let downloadSeq = 0;

const entryKey = (id: string, version: string) => id + '@' + version;
const errorCode = (error: unknown): string => (
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'operation_failed'
);

const requireString = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') throw new PluginAPIError('plugin.backend.error.page_invalid_arguments');
  return value;
};

const parseArgs = (argumentsJSON: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(argumentsJSON || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    return value as Record<string, unknown>;
  } catch {
    throw new PluginAPIError('plugin.backend.error.page_invalid_arguments');
  }
};

const loadGalleryState = async (refresh: boolean): Promise<GalleryState | null> => {
  try {
    const adapter = await getGalleryAdapter();
    const local = await adapter.status();
    galleryState = local;
    const next = refresh ? await adapter.refresh() : local;
    galleryState = next;
    galleryEntries = new Map((next.catalog?.entries ?? []).map((entry) => [entryKey(entry.id, entry.version), entry]));
    for (const installed of next.installed) {
      const key = entryKey(installed.entry.id, installed.entry.version);
      if (!galleryEntries.has(key)) galleryEntries.set(key, installed.entry);
    }
    galleryError = null;
    return next;
  } catch (error) {
    galleryError = errorCode(error);
    return null;
  }
};

const ensureGalleryEntries = async (): Promise<Map<string, GalleryEntry>> => {
  if (galleryEntries.size === 0) await loadGalleryState(false);
  return galleryEntries;
};

const galleryView = (state: GalleryState | null): GalleryEntryView[] => {
  if (!state) return [];
  const store = useBackgroundImageStore.getState();
  const selectedVersion = store.builtinVersion || store.resolvedGallery?.entry.version || '';
  const entries = [...(state.catalog?.entries ?? [])];
  const seen = new Set(entries.map((entry) => entryKey(entry.id, entry.version)));
  for (const installed of state.installed) {
    const key = entryKey(installed.entry.id, installed.entry.version);
    if (!seen.has(key)) { seen.add(key); entries.push(installed.entry); }
  }
  return entries.map((entry) => ({
    id: entry.id,
    version: entry.version,
    names: { ...entry.names },
    fit: entry.fit,
    attribution: entry.attribution,
    sourceUrl: entry.sourceUrl,
    license: { name: entry.license.name, url: entry.license.url, nonCommercial: entry.license.nonCommercial },
    downloaded: state.installed.some((value) => value.entry.id === entry.id && value.entry.version === entry.version),
    selected: store.builtinId === entry.id && (!selectedVersion || selectedVersion === entry.version),
  }));
};

const galleryStatePayload = (): JSONValue => ({
  stale: galleryState?.stale === true,
  warningCode: galleryState?.warningCode ?? null,
  error: galleryError,
  entries: galleryView(galleryState),
  download: download ? { ...download } : null,
  selection: selection ? { ...selection } : null,
} as unknown as JSONValue);

// The sandboxed page cannot read the host's blob URLs, and full gallery images can
// exceed the bridge limits. Downscale once into a preview data URL for position
// editing; the host keeps rendering the full image as the app background.
const galleryPreviewDataURL = async (id: string, version: string, url: string): Promise<string> => {
  const key = entryKey(id, version);
  if (galleryPreview.key === key) return galleryPreview.dataUrl;
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    const objectURL = URL.createObjectURL(blob);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          try {
            const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            const context = canvas.getContext('2d');
            if (!context) throw new Error('canvas');
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.7));
          } catch (error) {
            reject(error);
          }
        };
        image.onerror = () => reject(new Error('image'));
        image.src = objectURL;
      });
      galleryPreview = { key, dataUrl };
      return dataUrl;
    } finally {
      URL.revokeObjectURL(objectURL);
    }
  } catch {
    return '';
  }
};

const blobURLToDataURL = async (url: string): Promise<string> => {
  const response = await fetch(url);
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new PluginAPIError('plugin.backend.error.operation_failed'));
    reader.readAsDataURL(blob);
  });
};

const requireGalleryEntry = async (args: Record<string, unknown>): Promise<GalleryEntry> => {
  const id = requireString(args, 'id');
  const version = requireString(args, 'version');
  if (!validGalleryId(id) || !validGalleryVersion(version)) throw new PluginAPIError('plugin.backend.error.page_invalid_arguments');
  const entries = await ensureGalleryEntries();
  const entry = entries.get(entryKey(id, version));
  if (!entry) throw new PluginAPIError('plugin.backend.error.page_invalid_arguments');
  return entry;
};

const startDownload = async (args: Record<string, unknown>): Promise<JSONValue> => {
  const entry = await requireGalleryEntry(args);
  if (download && !download.done) throw new PluginAPIError('plugin.backend.error.operation_failed', 'gallery_busy');
  const requestId = 'plugin-gallery-' + Date.now().toString(36) + '-' + (++downloadSeq).toString(36);
  const record: DownloadState = {
    requestId, id: entry.id, version: entry.version, phase: 'starting',
    downloaded: 0, total: 0, done: false, error: null,
  };
  download = record;
  void (async () => {
    try {
      const adapter = await getGalleryAdapter();
      const installed: GalleryInstalled = await adapter.download(entry.id, entry.version, requestId, (progress: GalleryProgress) => {
        record.phase = progress.phase;
        record.downloaded = progress.downloaded;
        record.total = progress.total;
      });
      if (galleryState) {
        galleryState = {
          ...galleryState,
          installed: [
            ...galleryState.installed.filter((value) => !(value.entry.id === entry.id && value.entry.version === entry.version)),
            installed,
          ],
        };
      }
    } catch (error) {
      record.error = errorCode(error);
    } finally {
      record.done = true;
      record.phase = 'done';
      // Installed entries live in the adapter, not this module: reload once so the
      // next gallery.state reports the downloaded flag.
      void loadGalleryState(false);
      setTimeout(() => { if (download?.requestId === requestId) download = null; }, 30_000);
    }
  })();
  return { requestId };
};

const requirePermission = (permissions: readonly string[], permission: string): void => {
  if (!permissions.includes(permission)) throw new PluginAPIError('plugin.backend.error.page_permission_denied');
};

const callAppearance = async (
  method: string,
  argumentsJSON: string,
  permissions: readonly string[],
): Promise<JSONValue> => {
  const write = WRITE_METHODS.has(method);
  requirePermission(permissions, write ? APPEARANCE_WRITE_PERMISSION : APPEARANCE_READ_PERMISSION);
  const args = parseArgs(argumentsJSON);
  const store = useBackgroundImageStore.getState();

  switch (method) {
    case 'appearance.background.state': {
      const resolved = store.resolvedGallery;
      const resolvedURL = resolved ? new URL(resolved.url, window.location.origin).href : '';
      return {
        enabled: store.enabled,
        opacity: store.opacity,
        positionX: store.positionX,
        positionY: store.positionY,
        // The sandboxed page cannot measure the host window; the preview keeps the
        // host viewport ratio so dragging maps to the same background offsets.
        viewportRatio: window.innerWidth / Math.max(1, window.innerHeight),
        hostOrigin: window.location.origin,
        hasImage: Boolean(store.image),
        imageName: store.image?.name ?? null,
        builtin: store.builtinId ? { id: store.builtinId, version: store.builtinVersion } : null,
        resolved: resolved
          ? {
            id: resolved.entry.id,
            version: resolved.entry.version,
            name: resolved.entry.names,
            fit: resolved.entry.fit,
            url: resolvedURL,
            previewUrl: await galleryPreviewDataURL(resolved.entry.id, resolved.entry.version, resolvedURL),
          }
          : null,
        galleryError: store.galleryError,
      };
    }
    case 'appearance.background.image':
      return store.image ? { dataUrl: store.image.dataUrl, name: store.image.name } : { dataUrl: null, name: null };
    case 'appearance.background.set-custom': {
      const dataUrl = requireString(args, 'dataUrl');
      const name = typeof args.name === 'string' && args.name.trim() ? args.name : 'background.jpg';
      if (!isBackgroundImageDataUrl(dataUrl)) throw new PluginAPIError('plugin.backend.error.page_invalid_arguments');
      store.setImage({ dataUrl, name });
      return { ok: true };
    }
    case 'appearance.background.clear':
      store.clearImage();
      return { ok: true };
    case 'appearance.background.reset':
      store.reset();
      return { ok: true };
    case 'appearance.background.set-enabled':
      store.setEnabled(args.enabled === true);
      return { ok: true };
    case 'appearance.background.set-opacity':
      store.setOpacity(Number(args.opacity));
      return { ok: true };
    case 'appearance.background.set-position':
      store.setPosition(Number(args.positionX), Number(args.positionY));
      return { ok: true };
    case 'appearance.background.select-builtin': {
      const id = requireString(args, 'id');
      const version = typeof args.version === 'string' ? args.version : '';
      if (selection && !selection.done) throw new PluginAPIError('plugin.backend.error.operation_failed', 'gallery_busy');
      const record: DownloadState = {
        requestId: 'plugin-select-' + Date.now().toString(36),
        id, version, phase: 'starting', downloaded: 0, total: 0, done: false, error: null,
      };
      selection = record;
      void (async () => {
        try {
          await useBackgroundImageStore.getState().selectBuiltin(id, version, (progress) => {
            record.phase = progress.phase;
            record.downloaded = progress.downloaded;
            record.total = progress.total;
          });
        } catch (error) {
          record.error = errorCode(error);
        } finally {
          record.done = true;
          record.phase = 'done';
          void loadGalleryState(false);
          setTimeout(() => { if (selection === record) selection = null; }, 30_000);
        }
      })();
      return { ok: true };
    }
    case 'appearance.background.cancel-builtin':
      store.cancelGallerySelection();
      selection = null;
      return { ok: true };
    case 'appearance.background.resolve':
      await store.resolveSelected();
      return { ok: true };
    case 'appearance.gallery.state':
      if (!galleryState && !galleryError) await loadGalleryState(false);
      return galleryStatePayload();
    case 'appearance.gallery.refresh':
      await loadGalleryState(true);
      return galleryStatePayload();
    case 'appearance.gallery.download':
      return await startDownload(args);
    case 'appearance.gallery.cancel': {
      const adapter = await getGalleryAdapter();
      if (download && !download.done) {
        await adapter.cancel(download.requestId);
        download = null;
      }
      if (selection && !selection.done) {
        useBackgroundImageStore.getState().cancelGallerySelection();
        selection = null;
      }
      return { ok: true };
    }
    case 'appearance.gallery.remove': {
      const entry = await requireGalleryEntry(args);
      const current = useBackgroundImageStore.getState();
      const version = current.builtinVersion || current.resolvedGallery?.entry.version || '';
      if (current.builtinId === entry.id && (!version || version === entry.version)) {
        throw new PluginAPIError('plugin.backend.error.operation_failed', 'gallery_in_use');
      }
      const adapter = await getGalleryAdapter();
      await adapter.remove(entry.id, entry.version);
      if (galleryState) {
        galleryState = {
          ...galleryState,
          installed: galleryState.installed.filter((value) => !(value.entry.id === entry.id && value.entry.version === entry.version)),
        };
      }
      return { ok: true };
    }
    case 'appearance.gallery.thumbnail': {
      const entry = await requireGalleryEntry(args);
      const key = entryKey(entry.id, entry.version);
      const cached = thumbnails.get(key);
      if (cached) return { dataUrl: cached };
      const adapter = await getGalleryAdapter();
      const objectURL = await adapter.thumbnail(entry);
      try {
        const dataUrl = await blobURLToDataURL(objectURL);
        if (thumbnails.size > 128) thumbnails.clear();
        thumbnails.set(key, dataUrl);
        return { dataUrl };
      } finally {
        URL.revokeObjectURL(objectURL);
      }
    }
    default:
      throw new PluginAPIError('plugin.backend.error.page_unknown_method');
  }
};

/** Resolves a page-bridge call to the host-window appearance handler. */
export function createAppearanceResolver(permissions: readonly string[]) {
  return (method: string) => (isAppearanceMethod(method)
    ? (argumentsJSON: string) => callAppearance(method, argumentsJSON, permissions)
    : null);
}
