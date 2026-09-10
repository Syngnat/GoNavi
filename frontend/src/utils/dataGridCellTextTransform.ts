export const formatJsonCellText = (value: string): string => (
  JSON.stringify(JSON.parse(value), null, 2)
);

export const compactJsonCellText = (value: string): string => (
  JSON.stringify(JSON.parse(value))
);

export const escapeCellText = (value: string): string => {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
};

export const unescapeCellText = (value: string): string => {
  const text = String(value ?? '');
  let result = '';

  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    if (current !== '\\') {
      result += current;
      continue;
    }

    if (index + 1 >= text.length) {
      throw new SyntaxError('Trailing backslash');
    }

    const escapeCode = text[index + 1];
    switch (escapeCode) {
      case '"':
      case '\\':
      case '/':
        result += escapeCode;
        index += 1;
        break;
      case 'b':
        result += '\b';
        index += 1;
        break;
      case 'f':
        result += '\f';
        index += 1;
        break;
      case 'n':
        result += '\n';
        index += 1;
        break;
      case 'r':
        result += '\r';
        index += 1;
        break;
      case 't':
        result += '\t';
        index += 1;
        break;
      case 'u': {
        const hex = text.slice(index + 2, index + 6);
        if (hex.length !== 4 || !/^[0-9a-f]{4}$/i.test(hex)) {
          throw new SyntaxError(`Invalid Unicode escape: \\u${hex}`);
        }
        result += String.fromCharCode(Number.parseInt(hex, 16));
        index += 5;
        break;
      }
      default:
        throw new SyntaxError(`Invalid escape sequence: \\${escapeCode}`);
    }
  }

  return result;
};
