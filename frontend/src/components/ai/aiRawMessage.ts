/**
 * Decode values produced by Wails for Go's json.RawMessage fields.
 *
 * Depending on where a value crosses the WebView boundary, the same field can
 * arrive as a JSON string, a Uint8Array/other typed view, a plain byte array,
 * or the numeric-key object produced by JSON.stringify(Uint8Array).  Keeping
 * this normalization in one module prevents live events and Ledger replay
 * from applying different validation rules.
 */

export interface RawJSONDecodeResult {
  /** Whether the value has a shape that is expected to contain encoded JSON. */
  matched: boolean;
  /** Whether the encoded value parsed successfully. */
  valid: boolean;
  value?: unknown;
}

const isByte = (value: unknown): value is number => (
  typeof value === 'number'
  && Number.isInteger(value)
  && value >= 0
  && value <= 255
);

const bytesFromNumericObject = (
  value: unknown,
): { matched: boolean; bytes?: Uint8Array } => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { matched: false };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || !entries.every(([key]) => /^\d+$/.test(key))) {
    return { matched: false };
  }

  const sorted = entries.slice().sort(([left], [right]) => Number(left) - Number(right));
  const contiguous = sorted.every(([key], index) => Number(key) === index);
  if (!contiguous || !sorted.every(([, item]) => isByte(item))) {
    // An all-numeric object is almost certainly a serialized byte view. Mark
    // it as matched even when malformed so callers do not render the object as
    // a legitimate tool argument or event payload.
    return { matched: true };
  }
  return {
    matched: true,
    bytes: new Uint8Array(sorted.map(([, item]) => item as number)),
  };
};

const bytesFromValue = (
  value: unknown,
): { matched: boolean; bytes?: Uint8Array } => {
  if (value instanceof Uint8Array) {
    return { matched: true, bytes: value };
  }

  // ArrayBuffer.isView works for typed arrays created in another WebView
  // realm, where instanceof Uint8Array would be false.
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    try {
      return {
        matched: true,
        bytes: new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      };
    } catch {
      return { matched: true };
    }
  }

  if (Array.isArray(value)) {
    // A plain numeric array is the shape used by Wails for []byte. Arrays with
    // non-byte values remain ordinary JSON arrays (for example ["public"]).
    if (value.length > 0 && value.every(isByte)) {
      return { matched: true, bytes: new Uint8Array(value) };
    }
    return { matched: false };
  }

  return bytesFromNumericObject(value);
};

/**
 * Decode a possible RawMessage while retaining whether malformed byte-shaped
 * input was encountered. `decodeRawJSON` alone cannot distinguish malformed
 * bytes from a normal object, which is unsafe for tool-call projections.
 */
export const decodeRawJSONWithStatus = (value: unknown): RawJSONDecodeResult => {
  const binary = bytesFromValue(value);
  if (binary.matched) {
    if (!binary.bytes) return { matched: true, valid: false };
    try {
      return {
        matched: true,
        valid: true,
        value: JSON.parse(new TextDecoder().decode(binary.bytes)),
      };
    } catch {
      return { matched: true, valid: false };
    }
  }

  if (typeof value === 'string') {
    try {
      return { matched: true, valid: true, value: JSON.parse(value) };
    } catch {
      return { matched: true, valid: false };
    }
  }

  return { matched: false, valid: true, value };
};

/** Decode a RawMessage, returning null for malformed encoded JSON. */
export const decodeRawJSON = (value: unknown): unknown | null => {
  const decoded = decodeRawJSONWithStatus(value);
  return decoded.valid ? decoded.value : null;
};
