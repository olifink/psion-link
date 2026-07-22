import { describe, expect, test } from 'bun:test';
import { decodeSketchFile } from './sketch';

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

const SKETCH_SECTION_ID = 0x1000007d;

/** Builds a byte-correct Sketch file: header + Section Table + Sketch Section (fixed fields + embedded Paint Data Section + pixel data). */
function buildSketchFile(options: { width: number; height: number; encoding: number; pixelData: number[]; colorMode?: number; bitsPerDot?: number }): Uint8Array {
  const { width, height, encoding, pixelData } = options;
  const colorMode = options.colorMode ?? 0;
  const bitsPerDot = options.bitsPerDot ?? 2;

  const header = [
    ...u32le(0x10000037), // UID1
    ...u32le(0x1000006d), // UID2
    ...u32le(0x1000007d), // UID3: Sketch
    ...u32le(0), // UID4 checksum, unvalidated
    ...u32le(0x14), // Section Table Section offset
  ];
  const sketchSectionOffset = 0x14 + 1 + 8; // header end + count byte + one (id, offset) pair
  const table = [2 /* one entry = 2 Longs */, ...u32le(SKETCH_SECTION_ID), ...u32le(sketchSectionOffset)];

  const fixedFields = new Array(9).fill(0).flatMap(() => [0, 0]); // 9 W fields, values unused by the decoder

  const paintDataHeader = [
    ...u32le(0), // size of Paint Data Section (unused by the decoder)
    ...u32le(40), // pixel data offset: right after these 10 L fields
    ...u32le(width),
    ...u32le(height),
    ...u32le(0), // X twips
    ...u32le(0), // Y twips
    ...u32le(bitsPerDot),
    ...u32le(colorMode),
    ...u32le(0), // reserved
    ...u32le(encoding),
  ];

  return Uint8Array.from([...header, ...table, ...fixedFields, ...paintDataHeader, ...pixelData]);
}

describe('decodeSketchFile', () => {
  test('decodes a plain-encoded 2-bit greyscale row', () => {
    // One row, 4 pixels: black, dark grey, light grey, invisible.
    // Packed LSB-first: 0b11_10_01_00 = 0xE4. Row stride rounds up to a
    // multiple of 4, so 3 padding bytes follow.
    const file = buildSketchFile({ width: 4, height: 1, encoding: 0, pixelData: [0xe4, 0, 0, 0] });

    const sketch = decodeSketchFile(file);

    expect(sketch.width).toBe(4);
    expect(sketch.height).toBe(1);
    expect(Array.from(sketch.rgba)).toEqual([
      0, 0, 0, 255, // black
      85, 85, 85, 255, // dark grey
      170, 170, 170, 255, // light grey
      0, 0, 0, 0, // invisible -> transparent
    ]);
  });

  test('decodes an 8-bit-RLE-encoded row to the same pixels', () => {
    // Marker 0x00 = repeat next byte 1 time -> [0xE4]; marker 0x02 =
    // repeat next byte 3 times -> [0x00, 0x00, 0x00]. Decodes to the same
    // [0xE4, 0, 0, 0] as the plain-encoding test above.
    const file = buildSketchFile({ width: 4, height: 1, encoding: 1, pixelData: [0x00, 0xe4, 0x02, 0x00] });

    const sketch = decodeSketchFile(file);

    expect(Array.from(sketch.rgba)).toEqual([0, 0, 0, 255, 85, 85, 85, 255, 170, 170, 170, 255, 0, 0, 0, 0]);
  });

  test('an RLE literal run copies bytes verbatim', () => {
    // Marker 0xFC = 0x100 - 0xFC = 4 literal bytes follow.
    const file = buildSketchFile({ width: 4, height: 1, encoding: 1, pixelData: [0xfc, 0xe4, 0x00, 0x00, 0x00] });

    const sketch = decodeSketchFile(file);

    expect(Array.from(sketch.rgba)).toEqual([0, 0, 0, 255, 85, 85, 85, 255, 170, 170, 170, 255, 0, 0, 0, 0]);
  });

  test('rejects a colour Sketch file (only greyscale is supported)', () => {
    const file = buildSketchFile({ width: 4, height: 1, encoding: 0, pixelData: [0, 0, 0, 0], colorMode: 1 });
    expect(() => decodeSketchFile(file)).toThrow(/colour/);
  });

  test('rejects an unsupported bit depth', () => {
    const file = buildSketchFile({ width: 4, height: 1, encoding: 0, pixelData: [0, 0, 0, 0], bitsPerDot: 4 });
    expect(() => decodeSketchFile(file)).toThrow(/bit depth/);
  });

  test('rejects an unsupported encoding', () => {
    const file = buildSketchFile({ width: 4, height: 1, encoding: 3, pixelData: [0, 0, 0, 0] });
    expect(() => decodeSketchFile(file)).toThrow(/encoding/);
  });

  test('rejects a file whose UID3 is not Sketch', () => {
    const file = buildSketchFile({ width: 4, height: 1, encoding: 0, pixelData: [0, 0, 0, 0] });
    file[8] = 0x7f; // corrupt UID3 to Word's (0x1000007F)
    expect(() => decodeSketchFile(file)).toThrow(/not a Sketch file/);
  });
});
