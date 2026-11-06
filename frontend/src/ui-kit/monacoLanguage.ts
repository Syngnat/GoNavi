export type GonaviMonacoLanguage = 'sql' | 'json' | 'javascript' | 'text';

/** Maps the UI Kit language names onto Monaco language ids. */
export function gonaviMonacoLanguage(language: GonaviMonacoLanguage | undefined): string {
  switch (language) {
    case 'json': return 'json';
    case 'javascript': return 'javascript';
    case 'sql': return 'sql';
    default: return 'plaintext';
  }
}
