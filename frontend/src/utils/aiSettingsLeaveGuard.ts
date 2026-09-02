export type AISettingsLeaveGuard = () => boolean | Promise<boolean>;

// Keep the normal, clean navigation path synchronous. A pending confirmation
// delays only the action that would discard an AI provider draft.
export const withAISettingsLeaveGuard = <T,>(
  guard: AISettingsLeaveGuard | null | undefined,
  action: () => T,
): T | Promise<T | undefined> | undefined => {
  const allowed = guard?.() ?? true;
  if (typeof allowed === 'boolean') return allowed ? action() : undefined;
  return allowed.then((confirmed) => confirmed ? action() : undefined);
};
