import { pluginHostPreferences, type PluginHostPreferences } from '../pluginPages/hostPreferences';

export const HOST_PREFERENCES_EVENT = 'gonavi:host-preferences';

declare global {
 interface Window { gonaviHostPrefs?: PluginHostPreferences; __gonaviPluginBootstrap?: unknown }
}

// Revision is bridge metadata only; the public plugin contract contains presentation values.
export function createPreferenceReceiver(target: Window = window): (value: unknown) => void {
 let revision = -1;
 let generation: number | undefined;
 let previous = '';
 return (value) => {
  if (!value || typeof value !== 'object') return;
  const source = value as Record<string, unknown>;
  if (typeof source.generation !== 'number' || !Number.isSafeInteger(source.generation) || source.generation <= 0) return;
  if (generation !== undefined && source.generation !== generation) return;
  const nextRevision = source.preferencesRevision ?? 0;
  if (typeof nextRevision !== 'number' || !Number.isSafeInteger(nextRevision) || nextRevision < 0 || nextRevision <= revision) return;
  if (!source.preferences || typeof source.preferences !== 'object' || Array.isArray(source.preferences)) return;
  const raw = source.preferences as Record<string, unknown>;
  if (typeof raw.locale !== 'string' || (raw.theme !== 'light' && raw.theme !== 'dark')) return;
  const preferences = pluginHostPreferences(raw.locale, raw.theme, raw.palette, raw.appearance);
  generation = source.generation;
  revision = nextRevision;
  const serialized = JSON.stringify(preferences);
  if (serialized === previous) return;
  previous = serialized;
  if (preferences.palette) Object.freeze(preferences.palette);
  if (preferences.appearance?.background) Object.freeze(preferences.appearance.background);
  if (preferences.appearance) Object.freeze(preferences.appearance);
  target.gonaviHostPrefs = Object.freeze(preferences);
  target.dispatchEvent(new CustomEvent(HOST_PREFERENCES_EVENT, { detail: preferences }));
 };
}
