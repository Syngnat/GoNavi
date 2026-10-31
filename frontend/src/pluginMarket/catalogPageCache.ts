import { PluginAPIError } from '../plugins/apiResult';
import type { CatalogPage } from './types';

export const CATALOG_TTL_MS = 120_000;
export const CATALOG_RETRY_MS = 15_000;
export const CATALOG_MAX_PAGES = 32;
export const CATALOG_MAX_BYTES = 8 * 1024 * 1024;
export const CATALOG_MAX_REQUESTS = 4;
const MAX_PENDING = 64;
interface Entry { page?: CatalogPage; failure?: unknown; validUntil: number; bytes: number }
interface Task { bucket: string; key: string; epoch: number; started: boolean; users: number; load: () => Promise<CatalogPage>; promise: Promise<CatalogPage>;
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

export function peekCatalogPage(key: string): Entry | undefined {
  const entry = pages.get(key);
  if (entry) { pages.delete(key); pages.set(key, entry); }
  return entry;
}
function store(key: string, entry: Entry) {
  const previous = pages.get(key);
  if (previous) { bytes -= previous.bytes; pages.delete(key); }
  if (entry.bytes > CATALOG_MAX_BYTES) return;
  pages.set(key, entry); bytes += entry.bytes;
  while (pages.size > CATALOG_MAX_PAGES || bytes > CATALOG_MAX_BYTES) {
    const oldest = pages.keys().next().value as string;
    bytes -= pages.get(oldest)!.bytes; pages.delete(oldest);
  }
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
      store(task.key, { page, bytes: size, validUntil: Date.now() + (page.stale ? CATALOG_RETRY_MS : CATALOG_TTL_MS) });
    }
    task.resolve(page);
  } catch (failure) {
    if (task.epoch === epoch) {
      const old = peekCatalogPage(task.key);
      store(task.key, { page: old?.page, bytes: old?.bytes ?? 512, failure, validUntil: Date.now() + CATALOG_RETRY_MS });
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
export function requestCatalogPage(key: string, load: () => Promise<CatalogPage>, options: { force?: boolean; signal?: AbortSignal; sourceId?: string } = {}): Promise<CatalogPage> {
  if (options.signal?.aborted) return Promise.reject(aborted());
  const cached = peekCatalogPage(key);
  if (!options.force && cached && cached.validUntil > Date.now()) return 'failure' in cached ? Promise.reject(cached.failure) : Promise.resolve(cached.page!);
  let task = requests.get(key);
  if (!task) {
    if (requests.size >= MAX_PENDING) return Promise.reject(new PluginAPIError('plugin.backend.error.plugin_busy'));
    let resolve!: Task['resolve']; let reject!: Task['reject'];
    const promise = new Promise<CatalogPage>((yes, no) => { resolve = yes; reject = no; });
    task = { bucket: options.sourceId ?? key, key, load, epoch, promise, resolve, reject, started: false, users: 0 };
    requests.set(key, task); queue.push(task);
  }
  const result = subscribe(task, options.signal); pump(); return result;
}
export function clearCatalogPages() {
  epoch++; pages.clear(); bytes = 0;
  for (const task of queue.splice(0)) task.reject(aborted());
  requests.clear();
}
export function syncCatalogSources(signature: string) {
  if (sourceSignature && sourceSignature !== signature) clearCatalogPages();
  sourceSignature = signature;
}
export function catalogCacheStats() { return { pages: pages.size, bytes, running, queued: queue.length }; }
