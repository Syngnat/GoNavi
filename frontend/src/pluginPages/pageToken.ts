const TOKEN_BYTES = 16;

/**
 * One unguessable token per iframe instance. It is embedded in that frame's runtime closure
 * and repeated on every page-call, so a message from any other window - or from a page that
 * was replaced by navigation - cannot pass the host's first check.
 */
export function createPageToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  const cryptoApi = typeof globalThis.crypto === 'undefined' ? undefined : globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }
  let fallback = '';
  for (let index = 0; index < bytes.length; index += 1) {
    fallback += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  }
  return fallback + Date.now().toString(16);
}
