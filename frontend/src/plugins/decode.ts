import { PluginAPIError, requireRecord } from './apiResult';
import { boundedJSON } from './jsonBoundary';
import type { PluginInspection, PluginManifest, PluginRemoteInspection, PluginRemoteSource, PluginRuntimeInfo, PluginStatus } from './types';

function invalid(): never {
  throw new PluginAPIError('plugin.error.invalid_response');
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}
function onlyUINode(value: Record<string, unknown>): void {
  onlyKeys(value, ['type', 'text', 'title', 'children', 'command', 'arguments', 'columns', 'rows']);
  if (Array.isArray(value.children)) for (const child of value.children) onlyUINode(requireRecord(child));
  if (Array.isArray(value.columns)) for (const column of value.columns) onlyKeys(requireRecord(column), ['key', 'title']);
}
const utf8Within = (value: string, limit: number) => new TextEncoder().encode(value).length <= limit;
function validDataSource(source: Record<string, unknown>, command: Record<string, unknown> | undefined): boolean {
  const effect = command?.effect;
  const port = source.defaultPort;
  return typeof source.id === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(source.id)
    && typeof source.name === 'string' && source.name.trim() !== '' && utf8Within(source.name, 256) && !source.name.includes('\u0000')
    && typeof source.command === 'string' && source.readOnly === true
    && (source.dialect === 'mysql' || source.dialect === 'postgres' || source.dialect === 'sqlite') && command != null
    && (effect == null || effect === '' || effect === 'read' || effect === 'unknown')
    && (port == null || (typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65535));
}
function validExporter(exporter: Record<string, unknown>, commands: Map<string, Record<string, unknown>>): boolean {
  const command = typeof exporter.command === 'string' ? commands.get(exporter.command) : undefined;
  return typeof exporter.id === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(exporter.id)
    && typeof exporter.name === 'string' && exporter.name.trim() !== '' && utf8Within(exporter.name, 256) && !exporter.name.includes('\u0000')
    && command != null && typeof exporter.extension === 'string' && /^[a-z0-9]{1,16}$/.test(exporter.extension)
    && typeof exporter.contentType === 'string' && /^(text|application)\/[a-z0-9][a-z0-9.+-]{0,63}$/.test(exporter.contentType)
    && (exporter.streaming === undefined || typeof exporter.streaming === 'boolean');
}
// Mirrors internal/plugin's package icon rule (validPackageIcon + safePackagePath): a bounded
// package-relative raster path. An empty string means "no logo", because the host skips the
// check and IconPath falls back to the provider icon. SVG is refused: logos render in the host
// window, so an executable vector document is never needed.
const PACKAGE_ICON_PATH = /\.(?:png|jpe?g|webp|gif)$/i;
function validPackageIcon(value: unknown): value is string {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > 256 || !utf8Within(value, 256) || !PACKAGE_ICON_PATH.test(value)
    || /[\\:\u0000-\u001f<>"|?*]/.test(value) || value.startsWith('/')) return false;
  const parts = value.split('/');
  return parts.length <= 33 && parts.every((part) => part !== '' && part !== '.' && part !== '..'
    && part.length <= 240 && !part.endsWith(' ') && !part.endsWith('.') && !reservedSkillSegment(part));
}
function validAIProvider(provider: Record<string, unknown>, commands: Map<string, Record<string, unknown>>): boolean {
  const command = typeof provider.command === 'string' ? commands.get(provider.command) : undefined;
  const models = provider.models;
  if (typeof provider.id !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(provider.id)
    || typeof provider.name !== 'string' || provider.name.trim() === '' || !utf8Within(provider.name, 256) || provider.name.includes('\u0000')
    || (provider.icon != null && !validPackageIcon(provider.icon))
    || (provider.defaultBaseUrl != null && (typeof provider.defaultBaseUrl !== 'string' || provider.defaultBaseUrl.length > 2048))
    || command == null || typeof provider.supportsTools !== 'boolean' || typeof provider.supportsImages !== 'boolean'
    || !Array.isArray(models) || models.length < 1 || models.length > 32) return false;
  const seen = new Set<string>();
  for (const item of models) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
    const model = item as Record<string, unknown>;
    onlyKeys(model, ['id', 'name', 'contextWindow', 'maxOutputTokens']);
    const id = model.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$/.test(id) || seen.has(id)
      || typeof model.name !== 'string' || model.name.trim() === '' || !utf8Within(model.name, 256) || model.name.includes('\u0000')
      || typeof model.contextWindow !== 'number' || !Number.isInteger(model.contextWindow) || model.contextWindow < 1024 || model.contextWindow > 262144
      || typeof model.maxOutputTokens !== 'number' || !Number.isInteger(model.maxOutputTokens) || model.maxOutputTokens < 1 || model.maxOutputTokens > 65536
      || model.maxOutputTokens > model.contextWindow) return false;
    seen.add(id);
  }
  return true;
}
function reservedSkillSegment(part: string): boolean {
  const base = part.split('.')[0].toUpperCase();
  if (['CON', 'PRN', 'AUX', 'NUL', 'CLOCK$', 'CONIN$', 'CONOUT$'].includes(base)) return true;
  if (!base.startsWith('COM') && !base.startsWith('LPT')) return false;
  const suffix = base.slice(3);
  return suffix.length === 1 && suffix >= '0' && suffix <= '9' || suffix === '¹' || suffix === '²' || suffix === '³';
}
function validVersion(value: string): boolean {
  if (value.startsWith('v') || value.length > 128) return false;
  const build = value.split('+');
  if (build.length > 2 || (build.length === 2 && !build[1].split('.').every((part) => /^[0-9A-Za-z-]+$/.test(part)))) return false;
  const pre = build[0].split('-');
  const numbers = pre[0].split('.');
  if (pre.length > 2 || numbers.length !== 3 || numbers.some((part) => !/^(0|[1-9]\d*)$/.test(part))) return false;
  return pre.length === 1 || pre[1].split('.').every((part) => part !== '' && (!/^\d+$/.test(part) || !/^0\d/.test(part)) && /^[0-9A-Za-z-]+$/.test(part));
}
function validLocalID(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
}
function validPluginID(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/.test(value)) return false;
  return value.split('.').every((part) => part !== '' && !part.startsWith('-') && !part.endsWith('-'));
}
function validSchema(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return new TextEncoder().encode(JSON.stringify(value)).length <= 64 * 1024;
}
function validWindowEntry(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || !utf8Within(value, 1024) || /[\\:\u0000-\u001f<>"|?*]/.test(value) || value.startsWith('/')) return false;
  const parts = value.split('/');
  return parts.length <= 33 && parts.every((part) => part !== '' && part !== '.' && part !== '..' && utf8Within(part, 240) && !part.endsWith(' ') && !part.endsWith('.') && !reservedSkillSegment(part));
}
function validSkillPath(value: unknown, entry: boolean): value is string {
  if (typeof value !== 'string' || value.length === 0 || new TextEncoder().encode(value).length > 1024 || /[\\:\u0000-\u001f<>"|?*]/.test(value) || value.startsWith('/')) return false;
  const parts = value.split('/');
  if (parts.length > 33 || parts.some((part) => part === '' || part === '.' || part === '..' || new TextEncoder().encode(part).length > 240 || part.endsWith(' ') || part.endsWith('.') || reservedSkillSegment(part))) return false;
  const base = parts[parts.length - 1];
  return entry ? base === 'SKILL.md' : base.endsWith('.md') && base !== 'SKILL.md';
}
const PAGE_CONTRIBUTION_LIMIT = 32;
const PAGE_NODE_LIMITS = { depth: 16, nodes: 512 } as const;
function validLocalTitle(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && utf8Within(value, 256) && !value.includes('\u0000');
}
// Mirrors plugin.validateNode: the root is depth 0 and every page shares one cumulative
// node budget for the whole manifest, exactly like panels.
function chargePageNodeBudget(value: unknown, depth: number, budget: { nodes: number }): void {
  budget.nodes += 1;
  if (budget.nodes > PAGE_NODE_LIMITS.nodes || depth > PAGE_NODE_LIMITS.depth) invalid();
  const node = requireRecord(value);
  if (Array.isArray(node.children)) {
    for (const child of node.children) chargePageNodeBudget(child, depth + 1, budget);
  }
}
/** Contract threshold check for one page body, exported so tests pin the host budget. */
export function validatePageNodeBudget(body: unknown): void {
  chargePageNodeBudget(body, 0, { nodes: 0 });
}
function validatePageHTML(value: unknown, permissions: readonly string[]): void {
  if (!permissions.includes('ui.html-panel')) invalid();
  const html = requireRecord(value);
  onlyKeys(html, ['source']);
  if (typeof html.source !== 'string' || html.source.trim() === '' || !utf8Within(html.source, 256 << 10) || html.source.includes('\u0000')) invalid();
}
function validatePages(pages: unknown, permissions: readonly string[]): Set<string> {
  if (!Array.isArray(pages) || pages.length > PAGE_CONTRIBUTION_LIMIT) invalid();
  const seen = new Set<string>();
  const budget = { nodes: 0 };
  for (const item of pages) {
    const page = requireRecord(item);
    onlyKeys(page, ['id', 'title', 'body', 'html']);
    const hasBody = page.body != null;
    const hasHTML = page.html != null;
    if (hasBody === hasHTML) invalid();
    if (hasBody) {
      const body = requireRecord(page.body);
      onlyUINode(body);
      chargePageNodeBudget(body, 0, budget);
    }
    if (hasHTML) validatePageHTML(page.html, permissions);
    if (!validLocalID(page.id) || seen.has(page.id) || !validLocalTitle(page.title)) invalid();
    seen.add(page.id as string);
  }
  return seen;
}
function validateNavigation(entries: unknown, pageIDs: ReadonlySet<string>, hasWindow: boolean): void {
  if (!Array.isArray(entries) || entries.length > PAGE_CONTRIBUTION_LIMIT) invalid();
  const seen = new Set<string>();
  for (const item of entries) {
    const entry = requireRecord(item);
    onlyKeys(entry, ['id', 'title', 'target', 'page', 'location', 'order']);
    const order = entry.order;
    if (!validLocalID(entry.id) || seen.has(entry.id) || !validLocalTitle(entry.title)
      || entry.location !== 'tools'
      || (order != null && (typeof order !== 'number' || !Number.isInteger(order) || order < -1000 || order > 1000))) invalid();
    const target = entry.target ?? 'page';
    if (target === 'page') {
      if (typeof entry.page !== 'string' || !pageIDs.has(entry.page)) invalid();
    } else if (target === 'window') {
      if (!hasWindow || (entry.page != null && entry.page !== '')) invalid();
    } else {
      invalid();
    }
    seen.add(entry.id as string);
  }
}
function validSkill(skill: Record<string, unknown>): boolean {
  const resources = skill.resources == null ? [] : skill.resources;
  if (typeof skill.id !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(skill.id)
    || typeof skill.name !== 'string' || skill.name.trim() === '' || new TextEncoder().encode(skill.name).length > 256 || skill.name.includes('\u0000')
    || typeof skill.description !== 'string' || skill.description.trim() === '' || new TextEncoder().encode(skill.description).length > 2048 || skill.description.includes('\u0000')
    || !validSkillPath(skill.entry, true) || !Array.isArray(resources) || resources.length > 4) return false;
  const seen = new Set<string>([skill.entry]);
  for (const resource of resources) {
    if (!validSkillPath(resource, false) || seen.has(resource)) return false;
    seen.add(resource);
  }
  return true;
}
// Manifests opt in to the host's own envelope instead of the generic defaults: one manifest file is
// capped at 1 MiB (internal/plugin/manifest.go:40) and one inline panel or page HTML document at
// 256 KiB (internal/plugin/manifest_ui.go:16), while a page or panel body may nest 16 levels below
// the manifest, so 64 leaves room for the manifest plus that body.
// Every JSON value needs at least one byte, so matching the value budget to bytes keeps it
// from becoming a tighter gate than the manifest contract. Token and final byte checks still apply.
export const MANIFEST_JSON_LIMITS = { bytes: 1 << 20, text: 256 << 10, depth: 64, values: 1 << 20 } as const;
export function decodeManifest(data: unknown): PluginManifest {
  boundedJSON(data, MANIFEST_JSON_LIMITS.bytes, MANIFEST_JSON_LIMITS.text, MANIFEST_JSON_LIMITS.depth, MANIFEST_JSON_LIMITS.values);
  const raw = requireRecord(data);
  const allowed = new Set(['schemaVersion', 'apiVersion', 'id', 'name', 'version', 'description', 'author', 'license', 'icon', 'minHostVersion', 'permissions', 'permissionNotes', 'requires', 'backend', 'contributes', 'window', 'configSchema']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) invalid();
  const m: Record<string, unknown> = { ...raw, permissions: raw.permissions ?? [] };
  if (m.schemaVersion !== 1 || m.apiVersion !== 1 || typeof m.id !== 'string' || typeof m.name !== 'string'
    || typeof m.version !== 'string' || !Array.isArray(m.permissions) || m.permissions.length > 64
    || m.permissions.some((p) => typeof p !== 'string')) invalid();
  const name = m.name as string;
  if (!validPluginID(m.id) || typeof m.version !== 'string' || !validVersion(m.version) || name.trim() === '' || !utf8Within(name, 256) || name.includes('\u0000')) invalid();
  // Only an absent key means "no logo": a literal null is not a path, and the host never emits
  // one because the field is omitempty, so accepting it would only widen the contract.
  if (m.icon !== undefined && !validPackageIcon(m.icon)) invalid();
  const textLimits: Record<string, number> = { description: 16384, author: 512, license: 256 };
  for (const key of ['description', 'author', 'license', 'minHostVersion']) {
    const value = m[key];
    if (value == null) continue;
    if (typeof value !== 'string') invalid();
    const limit = textLimits[key];
    if (limit != null && !utf8Within(value, limit)) invalid();
    if (key === 'minHostVersion' && value !== '' && !validVersion(value)) invalid();
  }
  if (m.permissionNotes != null) {
    const notes = requireRecord(m.permissionNotes);
    const granted = new Set(m.permissions as string[]);
    const entries = Object.entries(notes);
    if (entries.length > granted.size) invalid();
    for (const [key, value] of entries) {
      if (!granted.has(key) || typeof value !== 'string' || value.trim() === '' || !utf8Within(value, 160) || /[<>\u0000-\u001f\u007f]/.test(value)) invalid();
    }
  }
  if (m.requires != null) {
    if (!Array.isArray(m.requires) || m.requires.length > 64) return invalid();
    const seenDeps = new Set<string>();
    for (const dependency of m.requires) {
      const entry = requireRecord(dependency);
      onlyKeys(entry, ['id', 'minVersion', 'optional']);
      if (!validPluginID(entry.id) || entry.id === m.id || seenDeps.has(entry.id)
        || (entry.minVersion != null && (typeof entry.minVersion !== 'string' || (entry.minVersion !== '' && !validVersion(entry.minVersion))))
        || (entry.optional != null && typeof entry.optional !== 'boolean')) invalid();
      seenDeps.add(entry.id as string);
    }
  }
  if (m.contributes != null) {
    const c = requireRecord(m.contributes);
    onlyKeys(c, ['commands', 'panels', 'dataSources', 'skills', 'aiProviders', 'exporters', 'pages', 'navigation', 'connectionActions']);
    const contributionLimits: Record<string, number> = { commands: 128, panels: 32 };
    for (const key of ['commands', 'panels']) {
      const entries = c[key];
      if (entries == null) continue;
      if (!Array.isArray(entries) || entries.length > contributionLimits[key]) return invalid();
      const seen = new Set<string>();
      for (const item of entries) {
        const entry = requireRecord(item);
        onlyKeys(entry, key === 'commands' ? ['id', 'title', 'description', 'inputSchema', 'effect'] : ['id', 'title', 'body', 'html']);
        if (key === 'panels') {
          // Go 的 omitempty 不会省略零值结构体，HTML-only 面板可能仍带 body:{"type":""}。
          const rawBody = entry.body;
          const hasBody = rawBody != null && !(typeof rawBody === 'object' && !Array.isArray(rawBody) && (rawBody as Record<string, unknown>).type === '');
          const hasHTML = entry.html != null;
          if (hasBody === hasHTML) invalid();
          if (!hasBody && rawBody != null) delete entry.body;
          if (hasBody) onlyUINode(requireRecord(entry.body));
          if (hasHTML) {
            if (!(m.permissions as string[]).includes('ui.html-panel')) invalid();
            const html = requireRecord(entry.html);
            onlyKeys(html, ['source']);
            if (typeof html.source !== 'string' || html.source.trim() === '' || !utf8Within(html.source, 256 << 10) || html.source.includes('\u0000')) invalid();
          }
        }
        const id = entry.id;
        if (!validLocalID(id) || seen.has(id) || typeof entry.title !== 'string' || entry.title.trim() === '' || !utf8Within(entry.title, 256) || entry.title.includes('\u0000')) invalid();
        seen.add(id);
        if (key === 'commands' && entry.effect != null && entry.effect !== '' && entry.effect !== 'read' && entry.effect !== 'write' && entry.effect !== 'unknown') invalid();
        if (key === 'commands' && entry.description != null && (typeof entry.description !== 'string' || !utf8Within(entry.description, 4096))) invalid();
        if (key === 'commands' && Object.prototype.hasOwnProperty.call(entry, 'inputSchema') && !validSchema(entry.inputSchema)) invalid();
      }
    }
    if (c.dataSources != null) {
      if (!Array.isArray(c.dataSources) || c.dataSources.length > 8) return invalid();
      const commands = new Map<string, Record<string, unknown>>();
      for (const item of Array.isArray(c.commands) ? c.commands : []) {
        const entry = requireRecord(item);
        if (typeof entry.id === 'string') commands.set(entry.id, entry);
      }
      for (const item of c.dataSources) {
        const source = requireRecord(item);
        onlyKeys(source, ['id', 'name', 'dialect', 'command', 'defaultPort', 'readOnly']);
        const command = typeof source.command === 'string' ? commands.get(source.command) : undefined;
        if (!validDataSource(source, command)) invalid();
      }
    }
    if (c.exporters != null) {
      if (!Array.isArray(c.exporters) || c.exporters.length > 8) return invalid();
      const commands = new Map<string, Record<string, unknown>>();
      for (const item of Array.isArray(c.commands) ? c.commands : []) {
        const entry = requireRecord(item);
        if (typeof entry.id === 'string') commands.set(entry.id, entry);
      }
      for (const item of c.exporters) {
        const exporter = requireRecord(item);
        onlyKeys(exporter, ['id', 'name', 'command', 'extension', 'contentType', 'streaming']);
        if (!validExporter(exporter, commands)) invalid();
      }
    }
    if (c.aiProviders != null) {
      if (!Array.isArray(c.aiProviders) || c.aiProviders.length > 8) return invalid();
      const commands = new Map<string, Record<string, unknown>>();
      for (const item of Array.isArray(c.commands) ? c.commands : []) {
        const entry = requireRecord(item);
        if (typeof entry.id === 'string') commands.set(entry.id, entry);
      }
      for (const item of c.aiProviders) {
        const provider = requireRecord(item);
        onlyKeys(provider, ['id', 'name', 'command', 'icon', 'defaultBaseUrl', 'models', 'supportsTools', 'supportsImages']);
        if (!validAIProvider(provider, commands)) invalid();
      }
    }
    if (c.connectionActions != null) {
      if (!Array.isArray(c.connectionActions) || c.connectionActions.length > 16) return invalid();
      const pageIDs = new Set<string>();
      for (const page of Array.isArray(c.pages) ? c.pages : []) {
        const id = requireRecord(page).id;
        if (typeof id === 'string') pageIDs.add(id);
      }
      const seenActions = new Set<string>();
      const validType = (value: unknown) => typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value);
      const validScope = (value: unknown) => value === 'connection' || value === 'database' || value === 'collection';
      for (const item of c.connectionActions) {
        const action = requireRecord(item);
        onlyKeys(action, ['id', 'title', 'description', 'connectionTypes', 'scopes', 'target']);
        if (!validLocalID(action.id) || seenActions.has(action.id as string)
          || typeof action.title !== 'string' || action.title.trim() === '' || !utf8Within(action.title, 256) || action.title.includes('\u0000')) invalid();
        seenActions.add(action.id as string);
        if (action.description != null && (typeof action.description !== 'string' || !utf8Within(action.description, 4096))) invalid();
        if (!Array.isArray(action.connectionTypes) || action.connectionTypes.length === 0 || action.connectionTypes.length > 32) invalid();
        const types = new Set<string>();
        for (const value of action.connectionTypes) {
          if (!validType(value) || types.has(value)) invalid();
          types.add(value);
        }
        if (action.scopes != null) {
          if (!Array.isArray(action.scopes) || action.scopes.length > 8) invalid();
          const scopes = new Set<string>();
          for (const value of action.scopes) {
            if (!validScope(value) || scopes.has(value)) invalid();
            scopes.add(value);
          }
        }
        const target = requireRecord(action.target);
        onlyKeys(target, ['type', 'page']);
        if (target.type === 'window') {
          if (target.page != null || m.window == null) invalid();
        } else if (target.type === 'page') {
          if (typeof target.page !== 'string' || !(m.permissions as string[]).includes('ui.pages') || !pageIDs.has(target.page)) invalid();
        } else {
          invalid();
        }
      }
    }
    if (c.pages != null || c.navigation != null) {
      const permissions = m.permissions as string[];
      const pages = c.pages ?? [];
      const navigation = c.navigation ?? [];
      // Empty arrays declare nothing, so they must not require the permission the
      // host also only enforces for a non-empty declaration. A window target only
      // opens the plugin's own window and needs no page permission.
      const pageNavigation = Array.isArray(navigation)
        && navigation.some((entry) => requireRecord(entry).target !== 'window');
      const declares = (Array.isArray(pages) && pages.length > 0) || pageNavigation;
      if (declares && !permissions.includes('ui.pages')) invalid();
      const pageIDs = validatePages(pages, permissions);
      validateNavigation(navigation, pageIDs, m.window != null);
    }
    if (c.skills != null) {
      if (!Array.isArray(c.skills) || c.skills.length > 16 || !(m.permissions as string[]).includes('ai.skills')) return invalid();
      const seen = new Set<string>();
      for (const item of c.skills) {
        const skill = requireRecord(item);
        onlyKeys(skill, ['id', 'name', 'description', 'entry', 'resources']);
        if (!validSkill(skill)) invalid();
        const skillId = skill.id;
        if (typeof skillId !== 'string' || seen.has(skillId)) invalid();
        seen.add(skillId);
      }
    }
  }
  if (m.backend != null) {
    const backend = requireRecord(m.backend);
    onlyKeys(backend, ['default', 'platforms']);
    const entryKeys = ['executable', 'args', 'runtime'];
    if (backend.default != null) onlyKeys(requireRecord(backend.default), entryKeys);
    if (backend.platforms != null) {
      for (const entry of Object.values(requireRecord(backend.platforms))) onlyKeys(requireRecord(entry), entryKeys);
    }
  }
  if (Object.prototype.hasOwnProperty.call(m, 'configSchema') && !validSchema(m.configSchema)) invalid();
  if (m.window != null) {
    const view = requireRecord(m.window);
    onlyKeys(view, ['entry', 'title', 'width', 'height']);
    if (!validWindowEntry(view.entry)) invalid();
    if (view.title != null && (typeof view.title !== 'string' || !utf8Within(view.title, 256))) invalid();
    for (const key of ['width', 'height']) {
      const size = view[key];
      if (size != null && (typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > 8192)) invalid();
    }
  }
  return m as unknown as PluginManifest;
}
export function decodeStatus(data: unknown): PluginStatus {
  const s = requireRecord(data);
  if (s.lastError != null && (typeof s.lastError !== 'string' || s.lastError.length > 8192)) invalid();
  const manifest = decodeManifest(s.manifest);
  if (!['disabled', 'starting', 'running', 'stopping', 'faulted', 'blocked'].includes(String(s.state))
    || typeof s.desiredEnabled !== 'boolean' || typeof s.digest !== 'string'
    || typeof s.generation !== 'number' || !Number.isSafeInteger(s.generation) || typeof s.installedAt !== 'string') invalid();
  return { ...s, manifest } as unknown as PluginStatus;
}
export function decodeStatuses(data: unknown): PluginStatus[] {
  if (!Array.isArray(data) || data.length > 500) return invalid();
  return data.map(decodeStatus);
}
export function decodeInspection(data: unknown): PluginInspection {
  const i = requireRecord(data);
  const manifest = decodeManifest(i.manifest);
  if (typeof i.digest !== 'string' || !/^[a-f0-9]{64}$/i.test(i.digest)
    || typeof i.sourcePath !== 'string' || typeof i.sizeBytes !== 'number' || i.sizeBytes < 0) invalid();
  return { ...i, manifest } as unknown as PluginInspection;
}
export function decodeRuntime(data: unknown): PluginRuntimeInfo {
  const r = requireRecord(data);
  if (typeof r.safeMode !== 'boolean' || typeof r.managementAllowed !== 'boolean'
    || (r.webRuntime !== undefined && typeof r.webRuntime !== 'boolean')) invalid();
  return r as unknown as PluginRuntimeInfo;
}
export function decodeRemoteInspection(data: unknown): PluginRemoteInspection {
  const r = requireRecord(data);
  const source = requireRecord(r.source);
  if ((source.kind !== 'github' && source.kind !== 'npm')
    || typeof source.spec !== 'string' || typeof source.url !== 'string'
    || typeof source.name !== 'string' || typeof source.version !== 'string'
    || typeof r.artifactDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(r.artifactDigest)
    || typeof r.approvalToken !== 'string' || r.approvalToken === ''
    || typeof r.expiresAt !== 'string' || r.expiresAt === '') invalid();
  return {
    inspection: decodeInspection(r.inspection),
    source: source as unknown as PluginRemoteSource,
    artifactDigest: r.artifactDigest,
    approvalToken: r.approvalToken,
    expiresAt: r.expiresAt,
  };
}
