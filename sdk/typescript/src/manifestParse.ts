import type { Manifest } from './types.js';

const topLevel = ['schemaVersion', 'apiVersion', 'id', 'name', 'version', 'description', 'author', 'license', 'icon', 'minHostVersion', 'permissions', 'permissionNotes', 'requires', 'backend', 'contributes', 'window', 'configSchema'];
const entryKeys = ['executable', 'args', 'runtime'];
const nodeKeys = ['type', 'text', 'title', 'children', 'command', 'arguments', 'columns', 'rows'];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fieldLabel(name: string): string {
  if (name.length === 0 || name.length > 64 || !/^[\x20-\x7e]+$/.test(name)) return '';
  return ` "${name}"`;
}
function only(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`unknown manifest field${fieldLabel(unknown)}`);
}
function node(value: unknown): void {
  if (!record(value)) throw new Error('invalid manifest JSON');
  only(value, nodeKeys);
  if (Array.isArray(value.children)) for (const child of value.children) node(child);
  if (Array.isArray(value.columns)) for (const column of value.columns) {
    if (!record(column)) throw new Error('invalid manifest JSON');
    only(column, ['key', 'title']);
  }
}
function list(value: unknown, check: (item: Record<string, unknown>) => void): void {
  if (!Array.isArray(value)) throw new Error('invalid manifest JSON');
  for (const item of value) {
    if (!record(item)) throw new Error('invalid manifest JSON');
    check(item);
  }
}

/** Rejects oversized JSON and unknown fields. It does not replace host validation or plugin check. */
export function parseManifest(data: unknown): Manifest {
  if (new TextEncoder().encode(JSON.stringify(data)).length > 1024 * 1024) throw new Error('manifest exceeds size limit');
  if (!record(data)) throw new Error('invalid manifest JSON');
  only(data, topLevel);
  if (Array.isArray(data.requires)) list(data.requires, (item) => only(item, ['id', 'minVersion', 'optional']));
  if (record(data.backend)) {
    only(data.backend, ['default', 'platforms']);
    if (data.backend.default != null) {
      if (!record(data.backend.default)) throw new Error('invalid manifest JSON');
      only(data.backend.default, entryKeys);
    }
    if (record(data.backend.platforms)) for (const entry of Object.values(data.backend.platforms)) {
      if (!record(entry)) throw new Error('invalid manifest JSON');
      only(entry, entryKeys);
    }
  }
  if (record(data.contributes)) {
    const contributes = data.contributes;
    only(contributes, ['commands', 'panels', 'dataSources', 'skills', 'aiProviders', 'exporters', 'pages', 'navigation', 'connectionActions']);
    if (contributes.commands != null) list(contributes.commands, (item) => only(item, ['id', 'title', 'description', 'inputSchema', 'effect']));
    if (contributes.panels != null) list(contributes.panels, (item) => { only(item, ['id', 'title', 'body']); if (item.body != null) node(item.body); });
    if (contributes.dataSources != null) list(contributes.dataSources, (item) => only(item, ['id', 'name', 'dialect', 'command', 'defaultPort', 'readOnly']));
    if (contributes.skills != null) list(contributes.skills, (item) => only(item, ['id', 'name', 'description', 'entry', 'resources']));
    if (contributes.exporters != null) list(contributes.exporters, (item) => only(item, ['id', 'name', 'command', 'extension', 'contentType', 'streaming']));
    if (contributes.aiProviders != null) list(contributes.aiProviders, (item) => {
      only(item, ['id', 'name', 'command', 'icon', 'models', 'supportsTools', 'supportsImages']);
      if (item.models != null) list(item.models, (model) => only(model, ['id', 'name', 'contextWindow', 'maxOutputTokens']));
    });
    if (contributes.pages != null) list(contributes.pages, (item) => {
      only(item, ['id', 'title', 'body', 'html']);
      if (item.body != null) node(item.body);
      if (item.html != null) {
        if (!record(item.html)) throw new Error('invalid manifest JSON');
        only(item.html, ['source']);
      }
    });
    if (contributes.navigation != null) list(contributes.navigation, (item) => only(item, ['id', 'title', 'target', 'page', 'location', 'order']));
    if (contributes.connectionActions != null) list(contributes.connectionActions, (item) => {
      only(item, ['id', 'title', 'description', 'connectionTypes', 'scopes', 'target']);
      if (!record(item.target)) throw new Error('invalid manifest JSON');
      only(item.target, ['type', 'page']);
    });
  }
  if (record(data.window)) only(data.window, ['entry', 'title', 'width', 'height']);
  return data as unknown as Manifest;
}
