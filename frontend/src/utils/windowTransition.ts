export type WindowConditionPollOptions = {
  read: () => boolean | Promise<boolean>;
  wait: (delayMs: number) => Promise<void>;
  isCancelled?: () => boolean;
  maxChecks?: number;
  intervalMs?: number;
};

/** Poll a fire-and-forget native window transition until its observable state settles. */
export const waitForWindowCondition = async ({
  read,
  wait,
  isCancelled = () => false,
  maxChecks = 16,
  intervalMs = 40,
}: WindowConditionPollOptions): Promise<boolean> => {
  const checks = Math.max(1, Math.trunc(Number(maxChecks) || 0));
  const delayMs = Math.max(0, Math.trunc(Number(intervalMs) || 0));

  for (let check = 0; check < checks; check += 1) {
    if (isCancelled()) {
      return false;
    }
    try {
      if (await read()) {
        return true;
      }
    } catch (_) {
      // A transient runtime read must not turn a fire-and-forget command into success.
    }
    if (check + 1 < checks) {
      await wait(delayMs);
    }
  }
  return false;
};
