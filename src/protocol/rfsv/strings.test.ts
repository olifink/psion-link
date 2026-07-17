import { describe, expect, test } from 'bun:test';
import { decodeEpocString, encodeEpocString } from './strings';

describe('encodeEpocString / decodeEpocString', () => {
  test('round-trips a plain ASCII string with a 2-byte little-endian length prefix', () => {
    const encoded = encodeEpocString('AUTOEXEC.BAT');
    expect(Array.from(encoded.subarray(0, 2))).toEqual([12, 0]);
    expect(decodeEpocString(encoded)).toEqual({ value: 'AUTOEXEC.BAT', byteLength: 14 });
  });

  test('encodes Windows-1252 extended characters as single bytes', () => {
    const encoded = encodeEpocString('café');
    expect(encoded.length).toBe(2 + 4); // 4 chars, all single-byte in cp1252
    expect(decodeEpocString(encoded).value).toBe('café');
  });

  test('an empty string round-trips', () => {
    const encoded = encodeEpocString('');
    expect(Array.from(encoded)).toEqual([0, 0]);
    expect(decodeEpocString(encoded)).toEqual({ value: '', byteLength: 2 });
  });

  test('rejects characters outside the Windows-1252 repertoire', () => {
    expect(() => encodeEpocString('日本語')).toThrow(RangeError);
  });

  test('encodes with the Unicode flag set (top bit of the length field)', () => {
    const encoded = encodeEpocString('日本語', { unicode: true });
    const rawLength = encoded[0]! | (encoded[1]! << 8);
    expect(rawLength & 0x8000).not.toBe(0);
    expect(decodeEpocString(encoded)).toEqual({ value: '日本語', byteLength: 2 + 6 });
  });

  test('decodes a Unicode string flagged with the top length bit', () => {
    const unicodeEncoded = encodeEpocString('Ω', { unicode: true });
    const decoded = decodeEpocString(unicodeEncoded);
    expect(decoded.value).toBe('Ω');
  });

  test('reports byteLength including the prefix so callers can advance a cursor', () => {
    const encoded = encodeEpocString('hi');
    const trailing = Uint8Array.of(...encoded, 0xaa, 0xbb);
    const decoded = decodeEpocString(trailing);
    expect(decoded.byteLength).toBe(4);
    expect(Array.from(trailing.subarray(decoded.byteLength))).toEqual([0xaa, 0xbb]);
  });

  test('throws on a truncated length prefix', () => {
    expect(() => decodeEpocString(Uint8Array.of(0x05))).toThrow(RangeError);
  });

  test('throws when the declared length exceeds available bytes', () => {
    expect(() => decodeEpocString(Uint8Array.of(0x05, 0x00, 0x41))).toThrow(RangeError);
  });

  test('rejects a string too long for the 15-bit length field', () => {
    expect(() => encodeEpocString('a'.repeat(0x8000))).toThrow(RangeError);
  });
});
