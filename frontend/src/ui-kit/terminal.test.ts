import { describe, expect, it } from 'vitest';
import { parseGonaviAnsi } from './terminal';

describe('terminal ANSI parser', () => {
  it('keeps plain text as one segment', () => {
    expect(parseGonaviAnsi('hello')).toEqual([{ text: 'hello' }]);
  });

  it('applies and resets SGR colours', () => {
    const segments = parseGonaviAnsi('\u001b[31mred\u001b[0m plain');
    expect(segments[0]).toMatchObject({ text: 'red', foreground: '#ff7b72' });
    expect(segments[1]).toEqual({ text: ' plain' });
  });

  it('handles bright colours, backgrounds and bold', () => {
    const segments = parseGonaviAnsi('\u001b[1;92;44mbright\u001b[22;39;49m');
    expect(segments[0]).toMatchObject({ text: 'bright', bold: true, foreground: '#56d364' });
    expect(segments[0].background).toBeTruthy();
  });

  it('drops non-SGR escapes', () => {
    expect(parseGonaviAnsi('a\u001b[2Jb')).toEqual([{ text: 'ab' }]);
  });

  it('treats an empty SGR as reset', () => {
    expect(parseGonaviAnsi('\u001b[31mred\u001b[mtail')).toEqual([
      { text: 'red', foreground: '#ff7b72' },
      { text: 'tail' },
    ]);
  });
});
