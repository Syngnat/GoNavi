/**
 * The desktop Wails runtime and browser bridge both reject oversized invoke
 * bodies before the export service runs. Treat either transport failure as a
 * known size limit so the UI can point at the re-query export path instead of
 * showing a bare status code or Wails' internal error text.
 */
export const isWebRequestTooLargeError = (error: unknown, message: string): boolean => {
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : NaN;
  return status === 413
    || /(?:status|HTTP)\s*413\b/i.test(message)
    || /assembled body too large/i.test(message)
    || /runtime request body exceeds/i.test(message);
};
