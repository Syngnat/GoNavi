import type { Manifest, Navigation, Page, UINode } from './types.js';

const PAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PAGES = 32;
const MAX_NAVIGATION = 32;
const MIN_ORDER = -1000;
const MAX_ORDER = 1000;
const MAX_HTML_BYTES = 256 * 1024;
const MAX_NODES = 512;
const MAX_DEPTH = 16;

const encoder = new TextEncoder();

function boundedText(value: unknown, limit: number): boolean {
  return typeof value === 'string' && value.trim().length > 0 && encoder.encode(value).length <= limit && !value.includes('\u0000');
}

function granted(permissions: readonly string[], want: string): boolean {
  return permissions.includes(want);
}

function validateHTML(page: Page, permissions: readonly string[]): void {
  const html = page.html;
  if (html === null || typeof html !== 'object') throw new Error('custom html page is empty');
  if (!granted(permissions, 'ui.html-panel')) throw new Error('custom html page requires the ui.html-panel permission');
  const source = html.source;
  if (typeof source !== 'string' || source.trim().length === 0) throw new Error('custom html page is empty');
  if (encoder.encode(source).length > MAX_HTML_BYTES) throw new Error('custom html page exceeds size limit');
  if (source.includes('\u0000')) throw new Error('custom html page is not valid text');
}

function validateNode(value: UINode, commands: ReadonlySet<string>, depth: number, budget: { count: number }): void {
  budget.count += 1;
  if (depth > MAX_DEPTH || budget.count > MAX_NODES) throw new Error('page tree exceeds limit');
  const node = value as unknown as Record<string, unknown>;
  if (!['text', 'alert', 'column', 'row', 'button', 'table'].includes(String(node.type))) throw new Error('unsupported page element');
  if (typeof node.text === 'string' && encoder.encode(node.text).length > 16384) throw new Error('page text or arguments exceed limit');
  if (typeof node.title === 'string' && encoder.encode(node.title).length > 1024) throw new Error('page text exceeds limit');
  if (node.arguments !== undefined && encoder.encode(JSON.stringify(node.arguments)).length > 64 * 1024) throw new Error('page arguments exceed limit');
  if (node.type === 'button') {
    if (typeof node.command !== 'string' || !commands.has(node.command)) throw new Error('page button references undeclared command');
  } else if (node.command !== undefined && node.command !== '') {
    throw new Error('non-button command is unsupported');
  }
  const children = Array.isArray(node.children) ? node.children : [];
  const columns = Array.isArray(node.columns) ? node.columns : [];
  const rows = Array.isArray(node.rows) ? node.rows : [];
  if (children.length > 128 || columns.length > 32 || rows.length > 500) throw new Error('page data exceeds limit');
  const keys = new Set<string>();
  for (const column of columns) {
    const item = column as unknown as Record<string, unknown>;
    const key = item.key;
    if (!boundedText(key, 128) || !boundedText(item.title, 256) || keys.has(String(key))) throw new Error('invalid page column');
    keys.add(String(key));
  }
  let dataBytes = 0;
  for (const row of rows) {
    const cells = (row ?? {}) as Record<string, unknown>;
    if (Object.keys(cells).length > 32) throw new Error('page row exceeds limit');
    for (const [key, cell] of Object.entries(cells)) {
      dataBytes += encoder.encode(key + JSON.stringify(cell)).length;
      if (!keys.has(key)) throw new Error('invalid page cell');
    }
  }
  if (dataBytes > 256 * 1024) throw new Error('page data exceeds byte limit');
  for (const child of children) validateNode(child as UINode, commands, depth + 1, budget);
}

function validatePageEntries(pages: readonly Page[], permissions: readonly string[], commands: ReadonlySet<string>): Set<string> {
  const declared = new Set<string>();
  const budget = { count: 0 };
  for (const page of pages) {
    if (!PAGE_ID.test(page.id ?? '') || declared.has(page.id) || !boundedText(page.title, 256)) throw new Error('invalid or duplicate page');
    declared.add(page.id);
    const hasBody = page.body !== undefined && page.body !== null;
    const hasHTML = page.html !== undefined && page.html !== null;
    if (hasBody && hasHTML) throw new Error('page declares both a declarative body and custom html');
    if (hasHTML) validateHTML(page, permissions);
    else if (hasBody) validateNode(page.body as UINode, commands, 0, budget);
    else throw new Error('page declares no body');
  }
  return declared;
}

function validateNavigationEntries(navigation: readonly Navigation[], pages: ReadonlySet<string>): void {
  const declared = new Set<string>();
  for (const entry of navigation) {
    if (!PAGE_ID.test(entry.id ?? '') || declared.has(entry.id) || !boundedText(entry.title, 256)) throw new Error('invalid or duplicate navigation entry');
    declared.add(entry.id);
    if (!pages.has(entry.page)) throw new Error('navigation references an undeclared page');
    if (entry.location !== 'tools') throw new Error('unsupported navigation location');
    const order = entry.order ?? 0;
    if (!Number.isInteger(order) || order < MIN_ORDER || order > MAX_ORDER) throw new Error('navigation order exceeds limit');
  }
}

/** Checks contributes.pages and contributes.navigation with the host rules. It renders nothing and grants no capability. */
export function validatePages(manifest: Manifest): void {
  const contributes = manifest.contributes;
  const pages = contributes?.pages ?? [];
  const navigation = contributes?.navigation ?? [];
  if (pages.length === 0 && navigation.length === 0) return;
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  if (!granted(permissions, 'ui.pages')) throw new Error('pages or navigation require the ui.pages permission');
  if (pages.length > MAX_PAGES || navigation.length > MAX_NAVIGATION) throw new Error('too many pages or navigation entries');
  const commands = new Set<string>();
  for (const command of contributes?.commands ?? []) commands.add(command.id);
  const declared = validatePageEntries(pages, permissions, commands);
  validateNavigationEntries(navigation, declared);
}
