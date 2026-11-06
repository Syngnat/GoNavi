/**
 * The browser build rejects an oversized invoke body before the export service
 * runs and the bridge surfaces only "invoke failed with status 413". Treat that
 * transport failure as a known size limit so the UI can point at the re-query
 * export path instead of showing a bare status code.
 */
export const isWebRequestTooLargeError = (error: unknown, message: string): boolean => {
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : NaN;
  return status === 413 || /(?:status|HTTP)\s*413\b/i.test(message);
};
