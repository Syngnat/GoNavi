export const PLUGIN_LIFECYCLE_EVENT = 'gonavi:plugin-lifecycle';

/** Tell host surfaces (sidebar actions, pages) that a plugin package changed. */
export function notifyPluginLifecycle(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PLUGIN_LIFECYCLE_EVENT));
}
