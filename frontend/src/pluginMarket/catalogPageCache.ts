import { PluginAPIError } from '../plugins/apiResult';
import { decodeCatalog } from './decode';
import type { CatalogPage } from './types';

export const CATALOG_TTL_MS = 120_000;
export const CATALOG_RETRY_MS = 15_000;
export const CATALOG_MAX_PAGES = 32;
export const CATALOG_MAX_BYTES = 8 * 1024 * 1024;
export const CATALOG_MAX_REQUESTS = 4;
const MAX_PENDING = 64;
// 成功页写入 WebView 的 localStorage，重启后先同步恢复卡片，再后台拉取最新目录。
export const CATALOG_STORAGE_PREFIX = 'gonavi.plugin-market.catalog.v1:';
const STORAGE_MAX_PAGES = 6;
const STORAGE_MAX_BYTES = 1024 * 1024;
interface Entry { page?: CatalogPage; failure?: unknown; validUntil: number; bytes: number }
interface PersistedPage { savedAt: number; page: CatalogPage }
interface Task { bucket: string; key: string; epoch: number; started: boolean; users: number; persist: boolean; load: () => Promise<CatalogPage>; promise: Promise<CatalogPage>;
  resolve: (page: CatalogPage) => void; reject: (cause: unknown) => void }
const pages = new Map<string, Entry>();
const requests = new Map<string, Task>();
const queue: Task[] = [];
let bytes = 0;
let running = 0;
const runningSources = new Set<string>();
let epoch = 0;
let sourceSignature = '';
const aborted = () => new DOMException('Catalog subscription canceled', 'AbortError');

function catalogStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
function storageName(key: string): string { return CATALOG_STORAGE_PREFIX + key; }
function storedNames(store: Storage): string[] {
  const names: string[] = [];
  for (let index = 0; index < store.length; index++) {
    const name = store.key(index);
    if (name?.startsWith(CATALOG_STORAGE_PREFIX)) names.push(name);
  }
  return names;
}
function clearStoredPages(store: Storage): void {
  for (const name of storedNames(store)) {
    try { store.removeItem(name); } catch { /* ignore */ }
  }
}
function pruneStoredPages(store: Storage): void {
  const names = storedNames(store);
  if (names.length <= STORAGE_MAX_PAGES) return;
  const rows = names.map((name) => {
    let savedAt = 0;
    try {
      const value = JSON.parse(store.getItem(name) ?? '') as Partial<PersistedPage>;
      if (typeof value.savedAt === 'number' && Number.isFinite(value.savedAt)) savedAt = value.savedAt;
    } catch { /* treat as oldest */ }
    return { name, savedAt };
  }).sort((left, right) => left.savedAt - right.savedAt);
  for (const row of rows.slice(0, rows.length - STORAGE_MAX_PAGES)) {
    try { store.removeItem(row.name); } catch { /* ignore */ }
  }
}
function compactPage(page: CatalogPage): CatalogPage {
  return {
    ...page,
    stale: false,
    error: '',
    items: page.items.map((item) => {
      const copy = { ...item };
      delete copy.manifest;
      return copy;
    }),
  };
}
function persistPage(key: string, page: CatalogPage): void {
  const store = catalogStorage();
  if (!store) return;
  const value = JSON.stringify({ savedAt: Date.now(), page: compactPage(page) } satisfies PersistedPage);
  if (value.length * 2 > STORAGE_MAX_BYTES) return;
  const name = storageName(key);
  try {
    store.setItem(name, value);
    pruneStoredPages(store);
  } catch {
    // localStorage 配额不足时，先清掉其他目录页再重试一次。
    for (const other of storedNames(store)) {
      if (other === name) continue;
      try { store.removeItem(other); } catch { /* ignore */ }
    }
    try {
      store.setItem(name, value);
    } catch {
      try { store.removeItem(name); } catch { /* ignore */ }
    }
  }
}
function readPersistedPage(key: string): Entry | undefined {
  const store = catalogStorage();
  if (!store) return undefined;
  const name = storageName(key);
  let value: string | null = null;
  try { value = store.getItem(name); } catch { return undefined; }
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<PersistedPage>;
    if (!parsed || typeof parsed.savedAt !== 'number' || !parsed.page) throw new Error('invalid cached catalog page');
    const page = decodeCatalog(parsed.page);
    const size = value.length * 2 + 512 + page.items.length * 128;
    if (size > CATALOG_MAX_BYTES || value.length * 2 > STORAGE_MAX_BYTES) throw new Error('oversized cached catalog page');
    return { page, bytes: size, validUntil: 0 };
  } catch {
    try { store.removeItem(name); } catch { /* ignore */ }
    return undefined;
  }
}
export function peekCatalogPage(key: string): Entry | undefined {
  const entry = pages.get(key);
  if (entry) { pages.delete(key); pages.set(key, entry); return entry; }
  const restored = readPersistedPage(key);
  if (!restored) return undefined;
  pages.set(key, restored); bytes += restored.bytes;
  return restored;
}
function store(key: string, entry: Entry, persist = true) {
  const previous = pages.get(key);
  if (previous) { bytes -= previous.bytes; pages.delete(key); }
  if (entry.bytes > CATALOG_MAX_BYTES) return;
  pages.set(key, entry); bytes += entry.bytes;
  while (pages.size > CATALOG_MAX_PAGES || bytes > CATALOG_MAX_BYTES) {
    const oldest = pages.keys().next().value as string;
    bytes -= pages.get(oldest)!.bytes; pages.delete(oldest);
  }
  if (entry.page && persist) persistPage(key, entry.page);
}
function cancelQueued(task: Task) {
  const index = queue.indexOf(task);
  if (index >= 0) queue.splice(index, 1);
  if (requests.get(task.key) === task) requests.delete(task.key);
  task.reject(aborted());
}
function subscribe(task: Task, signal?: AbortSignal): Promise<CatalogPage> {
  return new Promise((resolve, reject) => {
    let done = false;
    task.users++;
    const finish = (ok: boolean, value: unknown) => {
      if (done) return;
      done = true; task.users--; signal?.removeEventListener('abort', onAbort);
      if (!task.started && task.users === 0) cancelQueued(task);
      if (ok) resolve(value as CatalogPage); else reject(value);
    };
    const onAbort = () => finish(false, aborted());
    task.promise.then((page) => finish(true, page), (cause: unknown) => finish(false, cause));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
async function execute(task: Task) {
  try {
    const page = await task.load();
    if (task.epoch === epoch) {
      const size = JSON.stringify(page).length * 2 + 512 + page.items.length * 128;
      store(task.key, { page, bytes: size, validUntil: Date.now() + (page.stale ? CATALOG_RETRY_MS : CATALOG_TTL_MS) }, task.persist);
    }
    task.resolve(page);
  } catch (failure) {
    if (task.epoch === epoch) {
      const old = peekCatalogPage(task.key);
      store(task.key, { page: old?.page, bytes: old?.bytes ?? 512, failure, validUntil: Date.now() + CATALOG_RETRY_MS }, task.persist);
    }
    task.reject(failure);
  } finally {
    if (requests.get(task.key) === task) requests.delete(task.key);
    running--; runningSources.delete(task.bucket); pump();
  }
}
function pump() {
  while (running < CATALOG_MAX_REQUESTS && queue.length) {
    const index = queue.findIndex((task) => !runningSources.has(task.bucket));
    if (index < 0) break;
    const task = queue.splice(index, 1)[0];
    if (!task.users) { cancelQueued(task); continue; }
    task.started = true; running++; runningSources.add(task.bucket); void execute(task);
  }
}
export function requestCatalogPage(key: string, load: () => Promise<CatalogPage>, options: { force?: boolean; signal?: AbortSignal; sourceId?: string; persist?: boolean } = {}): Promise<CatalogPage> {
  if (options.signal?.aborted) return Promise.reject(aborted());
  const cached = peekCatalogPage(key);
  if (!options.force && cached && cached.validUntil > Date.now()) return 'failure' in cached ? Promise.reject(cached.failure) : Promise.resolve(cached.page!);
  let task = requests.get(key);
  if (!task) {
    if (requests.size >= MAX_PENDING) return Promise.reject(new PluginAPIError('plugin.backend.error.plugin_busy'));
    let resolve!: Task['resolve']; let reject!: Task['reject'];
    const promise = new Promise<CatalogPage>((yes, no) => { resolve = yes; reject = no; });
    task = { bucket: options.sourceId ?? key, key, load, epoch, promise, resolve, reject, started: false, users: 0, persist: options.persist ?? true };
    requests.set(key, task); queue.push(task);
  }
  const result = subscribe(task, options.signal); pump(); return result;
}
export function clearCatalogPages() {
  epoch++; pages.clear(); bytes = 0;
  const store = catalogStorage();
  if (store) clearStoredPages(store);
  for (const task of queue.splice(0)) task.reject(aborted());
  requests.clear();
}
export function syncCatalogSources(signature: string) {
  if (sourceSignature && sourceSignature !== signature) clearCatalogPages();
  sourceSignature = signature;
}
export function catalogCacheStats() { return { pages: pages.size, bytes, running, queued: queue.length }; }
