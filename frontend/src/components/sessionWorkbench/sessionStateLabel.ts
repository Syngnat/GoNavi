import type { SessionTranslate } from './sessionWorkbenchModel';

const STATE_KEY_PREFIX = 'session_workbench.state.';

/** State slugs that have a translation in shared/i18n. */
const KNOWN_STATES: ReadonlySet<string> = new Set([
  // MySQL family (PROCESSLIST COMMAND)
  'sleep', 'query', 'daemon', 'connect', 'binlog_dump', 'execute', 'prepare', 'killed',
  // PostgreSQL family / Oracle / Dameng
  'active', 'idle', 'idle_in_transaction', 'idle_in_transaction_aborted',
  'inactive', 'cached', 'sniped',
  // SQL Server
  'running', 'runnable', 'suspended', 'background', 'pending', 'rollback',
  // Trino
  'queued', 'planning', 'waiting_for_resources',
]);

/** Engine spellings that share one translated label. */
const STATE_ALIASES: Readonly<Record<string, string>> = {
  sleeping: 'sleep',
  binlog_dump_gtid: 'binlog_dump',
};

const stateSlug = (state: string | undefined): string => (
  String(state ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
);

/** i18n key for an engine-reported state, or null when it has no translation. */
export const sessionStateLabelKey = (state: string | undefined): string | null => {
  const slug = stateSlug(state);
  const resolved = STATE_ALIASES[slug] ?? slug;
  return KNOWN_STATES.has(resolved) ? `${STATE_KEY_PREFIX}${resolved}` : null;
};

/**
 * Localized state text. Unknown engine-specific states fall back to the raw
 * server value so nothing is ever hidden or mistranslated.
 */
export const displaySessionState = (
  state: string | undefined,
  translate: SessionTranslate,
): string => {
  const key = sessionStateLabelKey(state);
  return key ? translate(key) : String(state ?? '').trim();
};
