import { create } from 'zustand';
import { BackgroundImageError, isBackgroundImageDataUrl, prepareBackgroundImage } from './utils/backgroundImage';
import { normalizeBackgroundPosition, type BackgroundImagePosition } from './utils/backgroundImagePosition';
import type { GalleryInstalled, GalleryProgress } from './backgroundGallery/types';
import { createGallerySelectionActions, createSelectionGate } from './backgroundImageStoreGallery';
import { defaults, loadSnapshot, normalizeOpacity, persistSnapshot, snapshotOf, type BackgroundImageSnapshot } from './backgroundImageStorePersistence';
export { BACKGROUND_IMAGE_STORAGE_KEY } from './backgroundImageStorePersistence';

export interface BackgroundImageState extends BackgroundImageSnapshot {
  previewPosition: BackgroundImagePosition | null;
  resolvedGallery: GalleryInstalled | null;
  galleryError: string | null;
  resolutionRevision: number;
  previewPositionAt: (x: number, y: number) => void;
  cancelPositionPreview: () => void;
  setPosition: (x: number, y: number) => void;
  importImage: (file: File) => Promise<void>;
  /** Applies an already-prepared image (plugin capability path, JPEG data URL). */
  setImage: (image: { dataUrl: string; name: string }) => void;
  selectBuiltin: (id: string, version?: string, onProgress?: (progress: GalleryProgress) => void) => Promise<void>;
  resolveSelected: () => Promise<void>;
  cancelGallerySelection: () => void;
  setEnabled: (enabled: boolean) => void;
  clearImage: () => void;
  reset: () => void;
  setOpacity: (value: number) => void;
  reload: () => void;
}

export const useBackgroundImageStore = create<BackgroundImageState>((set, get) => {
  const gate = createSelectionGate();
  const gallery = createGallerySelectionActions(get, set, gate);
  const clear = (resetOpacity: boolean) => {
    const next = { ...defaults(), opacity: resetOpacity ? 15 : get().opacity };
    persistSnapshot(next);
    gallery.cancelGallerySelection();
    set({ ...next, resolvedGallery: null, galleryError: null, previewPosition: null });
  };
  return {
    ...loadSnapshot(), ...gallery,
    previewPosition: null, resolvedGallery: null, galleryError: null, resolutionRevision: 0,
    previewPositionAt: (x, y) => set({ previewPosition: normalizeBackgroundPosition(x, y) }),
    cancelPositionPreview: () => set({ previewPosition: null }),
    setPosition: (x, y) => {
      const next = { ...snapshotOf(get()), ...normalizeBackgroundPosition(x, y) };
      try { persistSnapshot(next); }
      catch (error) { set({ previewPosition: null }); throw error; }
      set({ ...next, previewPosition: null });
    },
    importImage: async (file) => {
      const revision = gate.invalidate();
      const image = await prepareBackgroundImage(file);
      if (revision !== gate.current()) return;
      const next = { image, opacity: get().opacity, positionX: 0, positionY: 0, enabled: true, builtinId: null, builtinVersion: '' };
      persistSnapshot(next);
      set({ ...next, resolvedGallery: null, galleryError: null, previewPosition: null });
    },
    setImage: (image) => {
      if (!isBackgroundImageDataUrl(image.dataUrl) || typeof image.name !== 'string' || !image.name.trim()) {
        throw new BackgroundImageError('invalid-image');
      }
      gate.invalidate();
      const next = {
        image: { dataUrl: image.dataUrl, name: image.name.trim().slice(0, 256) },
        opacity: get().opacity,
        positionX: 0,
        positionY: 0,
        enabled: true,
        builtinId: null,
        builtinVersion: '',
      };
      persistSnapshot(next);
      set({ ...next, resolvedGallery: null, galleryError: null, previewPosition: null });
    },
    setEnabled: (enabled) => {
      const current = snapshotOf(get());
      const next = { ...current, enabled: enabled && Boolean(current.image || current.builtinId) };
      persistSnapshot(next);
      gallery.cancelGallerySelection();
      set({ ...next, previewPosition: null, resolutionRevision: get().resolutionRevision + 1 });
    },
    clearImage: () => clear(false),
    reset: () => clear(true),
    setOpacity: (value) => {
      const next = { ...snapshotOf(get()), opacity: normalizeOpacity(value) };
      persistSnapshot(next); set(next);
    },
    reload: () => {
      gallery.cancelGallerySelection();
      set({ ...loadSnapshot(), previewPosition: null, resolvedGallery: null, galleryError: null, resolutionRevision: get().resolutionRevision + 1 });
    },
  };
});
