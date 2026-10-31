const knownPermissions: Record<string, string> = {
  'ai.tools': 'plugin.permission.ai_tools',
  'ai.skills': 'plugin.permission.ai_skills',
  'ai.providers': 'plugin.permission.ai_providers',
  'data.sources': 'plugin.permission.data_sources',
  'ui.html-panel': 'plugin.permission.ui_html_panel',
  'data.export': 'plugin.permission.data_export',
  'host.log': 'plugin.permission.host_log',
  'host.describe': 'plugin.permission.host_describe',
  'ui.pages': 'plugin.permission.ui_pages',
  'system.open-external': 'plugin.permission.system_open_external',
  'host.connections.read': 'plugin.permission.host_connections_read',
  'host.connections.credentials': 'plugin.permission.host_connections_credentials',
  'host.metadata.read': 'plugin.permission.host_metadata_read',
  'host.query.read': 'plugin.permission.host_query_read',
  'host.schema.write': 'plugin.permission.host_schema_write',
};

export function pluginPermissionText(permission: string, t: (key: string) => string, note?: string): string {
  const key = knownPermissions[permission];
  if (key) {
    const label = t(key);
    const descriptionKey = key + '.description';
    const description = t(descriptionKey);
    const localized = description && description !== descriptionKey ? label + ' — ' + description : label;
    return localized + ' (' + permission + ')';
  }
  const custom = cleanPermissionNote(note);
  return custom ? custom + ' (' + permission + ')' : permission;
}

function cleanPermissionNote(note?: string): string {
  if (!note) return '';
  const trimmed = note.trim();
  if (trimmed.length === 0 || new TextEncoder().encode(note).length > 160 || /[<>\u0000-\u001f\u007f]/.test(trimmed)) return '';
  return trimmed;
}
