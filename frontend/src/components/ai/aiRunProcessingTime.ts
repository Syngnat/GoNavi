const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'canceled', 'exhausted']);

/**
 * Active model + tool time per finished run, keyed by run ID. A run that is
 * still going has no final figure yet, so it is left out instead of showing a
 * number that keeps changing; approval waits are not part of it.
 */
export const collectRunProcessingTimes = (runs: unknown): Map<string, number> => {
  const result = new Map<string, number>();
  if (!Array.isArray(runs)) return result;
  for (const raw of runs) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const run = raw as Record<string, unknown>;
    const runId = String(run.runId || run.id || '').trim();
    const durationMs = Number(run.activeDurationMs);
    if (!runId || !TERMINAL_RUN_STATES.has(String(run.state || '').trim())) continue;
    if (Number.isFinite(durationMs) && durationMs > 0) result.set(runId, Math.round(durationMs));
  }
  return result;
};
