/**
 * Cleaning up what the recognizer returns. It is built for printed text, and for
 * Chinese it puts a space between every two characters ("查 询 订 单"), which the
 * model would read as separate tokens; blank-line runs and trailing blanks are
 * noise too. Nothing is rewritten beyond that: recognized text is shown to the model
 * as it was read.
 */

// Han, CJK punctuation, full-width forms, Hiragana and Katakana.
const CJK = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef';
const SPACE_BETWEEN_CJK = new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, 'g');

/** Longest text kept from one image: a screenshot of a wall of text is not a question. */
export const MAX_RECOGNIZED_CHARS = 8000;

export const normalizeRecognizedText = (raw: string): string => {
  const lines = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(SPACE_BETWEEN_CJK, '$1').replace(/[ \t]+$/g, ''));
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > MAX_RECOGNIZED_CHARS ? `${text.slice(0, MAX_RECOGNIZED_CHARS).trimEnd()}\n…` : text;
};

/** A line of text of no substance (stray punctuation from a texture or icon) is not "text". */
export const hasMeaningfulText = (text: string): boolean => /[\p{L}\p{N}]/u.test(text);
