import type { PluginState } from '../types';
export interface PluginAIModel { id: string; name: string; contextWindow: number; maxOutputTokens: number }
export interface PluginAIProviderView {
  type: string;
  pluginId: string;
  id: string;
  name: string;
  icon?: string;
  /** Gateway the plugin ships with; the editor prefills it when baseUrl is empty. */
  defaultBaseUrl?: string;
  models: readonly PluginAIModel[];
  supportsTools: boolean;
  supportsImages: boolean;
  version: string;
  digest: string;
  generation: number;
  available: boolean;
  state: PluginState;
  reason?: string;
}
