/** Non-secret identity for a connection action opened as a workbench tab. */
export interface PluginPageLaunch {
  kind: 'connectionAction';
  actionId: string;
  connectionId: string;
  connectionName: string;
  connectionType: string;
  database?: string;
  collection?: string;
  environmentType?: string;
  readOnly: boolean;
}

/** Escapes a JSON value for an inline script while preserving its data shape. */
export function serializePluginPageLaunch(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) return 'null';
  return json.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
