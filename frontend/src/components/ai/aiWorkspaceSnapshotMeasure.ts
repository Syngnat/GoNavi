import { MESSAGE_ENVELOPE_BYTES, WORKSPACE_WRAPPER_BYTES, jsonStringBytes } from './aiContextBreakdown';

/**
 * How much of the model's context the workspace snapshot takes. The snapshot is
 * built and published by useAIWorkspaceSnapshot; the context ring only needs its
 * size, so the hook records what it last published here and the ring reads it.
 */

export interface AIWorkspaceSnapshotMeasure {
  /** The snapshot without the items the person bound. */
  workspaceBytes: number;
  /** The bound items inside it. */
  attachedBytes: number;
}

let published: object | null = null;
let version = 0;
let cached: { snapshot: object; measure: AIWorkspaceSnapshotMeasure } | null = null;
const listeners = new Set<() => void>();

/** The Go side sends the snapshot as the string content of one system message. */
export const measureWorkspaceSnapshot = (snapshot: object): AIWorkspaceSnapshotMeasure => {
  const attached = (snapshot as { activeContext?: { attachedItems?: unknown } }).activeContext?.attachedItems;
  const attachedBytes = Array.isArray(attached) && attached.length > 0 ? jsonStringBytes(JSON.stringify(attached)) : 0;
  const total = MESSAGE_ENVELOPE_BYTES + WORKSPACE_WRAPPER_BYTES + jsonStringBytes(JSON.stringify(snapshot));
  return { workspaceBytes: Math.max(0, total - attachedBytes), attachedBytes };
};

export const recordPublishedWorkspaceSnapshot = (snapshot: object | null): void => {
  if (snapshot === published) return;
  published = snapshot;
  version += 1;
  listeners.forEach((listener) => listener());
};

/** Measured on first read after a change, so a snapshot nobody looks at costs nothing. */
export const getPublishedWorkspaceMeasure = (): AIWorkspaceSnapshotMeasure => {
  if (!published) return { workspaceBytes: 0, attachedBytes: 0 };
  if (!cached || cached.snapshot !== published) {
    cached = { snapshot: published, measure: measureWorkspaceSnapshot(published) };
  }
  return cached.measure;
};

export const subscribeToWorkspaceSnapshot = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const getWorkspaceSnapshotVersion = (): number => version;
