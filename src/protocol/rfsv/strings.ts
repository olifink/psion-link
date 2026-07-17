/**
 * RFSV32 strings: 2-byte little-endian length prefix + raw character
 * bytes, not NUL-terminated. The top bit of the length field flags
 * Unicode (UTF-16LE); otherwise the EPOC character set is used, which the
 * PLP spec's "Character Sets" section identifies as exactly Windows-1252
 * ("the EPOC variant uses the Windows ANSI (Windows code page 1252)
 * character set").
 */
const UNICODE_LENGTH_FLAG = 0x8000;
const LENGTH_MASK = 0x7fff;

const windows1252Decoder = new TextDecoder('windows-1252');
const utf16leDecoder = new TextDecoder('utf-16le');

/**
 * There's no built-in `TextEncoder` for legacy encodings (only UTF-8), so
 * the byte -> character map is derived from the trusted native decoder
 * (decode every possible byte, invert the result) rather than
 * hand-transcribing the cp1252 table — this guarantees the encode and
 * decode paths agree by construction.
 */
const windows1252EncodeMap: Map<string, number> = (() => {
  const map = new Map<string, number>();
  for (let byte = 0; byte < 256; byte++) {
    map.set(windows1252Decoder.decode(Uint8Array.of(byte)), byte);
  }
  return map;
})();

function encodeWindows1252(value: string): Uint8Array {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    const byte = windows1252EncodeMap.get(ch);
    if (byte === undefined) {
      throw new RangeError(`character outside the Windows-1252 repertoire: ${JSON.stringify(ch)}`);
    }
    out[i] = byte;
  }
  return out;
}

function encodeUtf16Le(value: string): Uint8Array {
  const out = new Uint8Array(value.length * 2);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    out[i * 2] = code & 0xff;
    out[i * 2 + 1] = (code >> 8) & 0xff;
  }
  return out;
}

export function encodeEpocString(value: string, options: { unicode?: boolean } = {}): Uint8Array {
  const bytes = options.unicode ? encodeUtf16Le(value) : encodeWindows1252(value);
  if (bytes.length > LENGTH_MASK) {
    throw new RangeError(`string exceeds the 15-bit length field: ${bytes.length} bytes`);
  }
  const length = bytes.length | (options.unicode ? UNICODE_LENGTH_FLAG : 0);
  const out = new Uint8Array(2 + bytes.length);
  out[0] = length & 0xff;
  out[1] = (length >> 8) & 0xff;
  out.set(bytes, 2);
  return out;
}

export interface DecodedEpocString {
  value: string;
  /** Total bytes consumed, including the 2-byte length prefix. */
  byteLength: number;
}

export function decodeEpocString(bytes: Uint8Array): DecodedEpocString {
  if (bytes.length < 2) {
    throw new RangeError('need at least 2 bytes to decode an EPOC string length prefix');
  }
  const rawLength = bytes[0]! | (bytes[1]! << 8);
  const unicode = (rawLength & UNICODE_LENGTH_FLAG) !== 0;
  const length = rawLength & LENGTH_MASK;
  if (bytes.length < 2 + length) {
    throw new RangeError(`truncated EPOC string: need ${length} bytes, have ${bytes.length - 2}`);
  }
  const data = bytes.subarray(2, 2 + length);
  const value = unicode ? utf16leDecoder.decode(data) : windows1252Decoder.decode(data);
  return { value, byteLength: 2 + length };
}
