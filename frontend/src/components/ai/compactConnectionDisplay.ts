/** Display-only compression for connection fields. Saved values stay full. */

export const compactMiddle = (value: string, head = 6, tail = 6): string => {
  const text = String(value || '');
  if (text.length <= head + tail + 3) return text;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
};

export const compactUrl = (value: string): string => {
  const stripped = String(value || '').replace(/^https?:\/\//i, '');
  return compactMiddle(stripped, 18, 12);
};

export const compactSecret = (value: string): string => {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 11) return text;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
};
