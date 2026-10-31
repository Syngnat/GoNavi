import { describe, expect, it } from 'vitest';
import { sandboxedPageDocument } from './pageDocument';

describe('plugin page launch injection', () => {
  it('injects a frozen-shape JSON value and escapes script-closing markup', () => {
    const document = sandboxedPageDocument('<p>page</p>', 'token', {
      kind: 'connectionAction',
      connectionId: 'c1',
      connectionName: '</script><script>alert(1)</script>',
      database: 'app',
    });
    expect(document).toContain('window.__gonaviLaunch=');
    expect(document).toContain('c1');
    expect(document).not.toContain('</script><script>alert(1)</script>');
    expect(document).toContain('\\u003c/script');
  });

  it('leaves plain navigation pages unchanged', () => {
    expect(sandboxedPageDocument('<p>page</p>', 'token')).not.toContain('__gonaviLaunch');
  });
});
