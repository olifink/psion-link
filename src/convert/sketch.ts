import { EpocDocHeader, hex32, parseEpocDocHeader } from './epoc-doc';
import { encodePng } from './png';

/** Psion's built-in "Sketch" app's UID3 — matches `KNOWN_APP_UIDS['Sketch']` in file-browser.ts, sourced from real hardware. */
const SKETCH_APP_UID3 = 0x1000007d;

/** The Sketch Section's identifier within the Section Table (psiconv: `7D 00 00 10` — same value as the app UID3, confirmed against real hardware too). */
const SKETCH_SECTION_ID = 0x1000007d;

const ENCODING_PLAIN = 0;
const ENCODING_8BIT_RLE = 1;

export interface DecodedSketch {
  width: number;
  height: number;
  /** 8-bit RGBA, row-major, `width * height * 4` bytes — ready for `encodePng`. */
  rgba: Uint8Array;
}

function u32le(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new RangeError(`truncated Sketch file: expected 4 bytes at offset ${offset}`);
  }
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function findSketchSection(header: EpocDocHeader): number {
  if (header.uid3 !== SKETCH_APP_UID3) {
    throw new Error(`not a Sketch file (UID3 is ${hex32(header.uid3)}, expected ${hex32(SKETCH_APP_UID3)})`);
  }
  const offset = header.sections.get(SKETCH_SECTION_ID);
  if (offset === undefined) {
    throw new Error('Sketch file has no Sketch Section');
  }
  return offset;
}

/**
 * "8-bit RLE" packbits-style decoding (psiconv's Paint_Data_Section doc):
 * a marker byte 0x00-0x7F means "repeat the next byte (marker+1) times";
 * 0x80-0xFF means "(0x100-marker) literal bytes follow". Runs aren't reset
 * at scanline boundaries — decode the whole buffer, then slice into rows.
 */
function decode8BitRle(data: Uint8Array, decodedLength: number): Uint8Array {
  const out = new Uint8Array(decodedLength);
  let inPos = 0;
  let outPos = 0;
  while (outPos < decodedLength) {
    const marker = data[inPos++];
    if (marker === undefined) {
      throw new RangeError('truncated Sketch pixel data: ran out of bytes mid-RLE-stream');
    }
    if (marker <= 0x7f) {
      const runLength = marker + 1;
      const value = data[inPos++];
      if (value === undefined) {
        throw new RangeError('truncated Sketch pixel data: RLE run marker with no value byte');
      }
      out.fill(value, outPos, outPos + runLength);
      outPos += runLength;
    } else {
      const literalLength = 0x100 - marker;
      if (inPos + literalLength > data.length) {
        throw new RangeError('truncated Sketch pixel data: RLE literal run runs past the end');
      }
      out.set(data.subarray(inPos, inPos + literalLength), outPos);
      inPos += literalLength;
      outPos += literalLength;
    }
  }
  return out;
}

/**
 * 2-bit-per-pixel greyscale palette (psiconv's Paint_Data_Section doc names
 * these but — unlike the 4-bit palette — doesn't give RGB triples for the
 * grey levels, only the black/white endpoints and "invisible"). Filled in
 * with an even grey ramp and "invisible" mapped to fully transparent
 * (alpha 0), the natural PNG equivalent — not verified against real
 * hardware output beyond the black/white endpoints and overall image shape
 * matching what a real Series 5 Sketch file should look like.
 */
const GREYSCALE_2BIT_PALETTE: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0, 0, 255], // 0: black
  [85, 85, 85, 255], // 1: dark grey
  [170, 170, 170, 255], // 2: light grey
  [0, 0, 0, 0], // 3: invisible -> transparent
];

function unpack2BitGreyscale(decoded: Uint8Array, width: number, height: number, rowStride: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowStride;
    for (let x = 0; x < width; x++) {
      const byteIndex = rowStart + (x >> 2);
      const bitOffset = (x & 3) * 2; // least-significant bits are leftmost pixels
      const value = (decoded[byteIndex]! >> bitOffset) & 0b11;
      const [r, g, b, a] = GREYSCALE_2BIT_PALETTE[value]!;
      const pixelOffset = (y * width + x) * 4;
      rgba[pixelOffset] = r;
      rgba[pixelOffset + 1] = g;
      rgba[pixelOffset + 2] = b;
      rgba[pixelOffset + 3] = a;
    }
  }
  return rgba;
}

/**
 * Decodes a Psion Sketch file to RGBA pixels. Byte layout confirmed
 * against `examples/My Sketch` (a real black-and-white Series 5 drawing) —
 * psiconv's own doc page for the Sketch Section lists the Paint Data
 * Section as embedded *between* the 9 fixed size/offset fields and the
 * trailing magnification/cut fields (an inline hyperlink marker in the
 * source HTML table, not a plain row, which is easy to misread as "comes
 * after" instead of "embedded here" — confirmed by locating the
 * documented "pixel data offset, always 0x28" signature at the position
 * this ordering predicts, and finding every other field
 * (width/height/bits-per-dot/color-mode/encoding) sane and self-consistent
 * only under this reading).
 */
export function decodeSketchFile(data: Uint8Array): DecodedSketch {
  const header = parseEpocDocHeader(data);
  const section = findSketchSection(header);

  // Sketch Section's 9 fixed fields (all W, offsets relative to `section`):
  // displayed size (2), picture offset within displayed area (2), offset
  // within form (2), form size (2), and one reserved/always-zero field —
  // 18 bytes total. Not otherwise used for PNG conversion; only the
  // embedded Paint Data Section (right after, at +0x12) matters here.
  const paintData = section + 0x12;

  // Paint Data Section (psiconv's Paint_Data_Section doc), offsets
  // relative to `paintData`:
  //   0x00 L  size of this section, including this field
  //   0x04 L  pixel data offset (relative to `paintData`)
  //   0x08 L  X size of picture, in dots
  //   0x0C L  Y size of picture, in dots
  //   0x10 L  X size in twips (0 = unspecified)
  //   0x14 L  Y size in twips (0 = unspecified)
  //   0x18 L  bits per dot
  //   0x1C L  color mode (0 = greyscale, 1 = colour)
  //   0x20 L  reserved
  //   0x24 L  encoding (0 = plain, 1 = 8-bit RLE, 2/3/4 = 12/16/24-bit RLE)
  const pixelDataOffset = u32le(data, paintData + 0x04);
  const width = u32le(data, paintData + 0x08);
  const height = u32le(data, paintData + 0x0c);
  const bitsPerDot = u32le(data, paintData + 0x18);
  const colorMode = u32le(data, paintData + 0x1c);
  const encoding = u32le(data, paintData + 0x24);

  if (colorMode !== 0) {
    throw new Error('colour Sketch files are not yet supported (only greyscale)');
  }
  if (bitsPerDot !== 2) {
    throw new Error(`unsupported Sketch bit depth: ${bitsPerDot} bits/dot (only 2-bit greyscale is supported)`);
  }
  if (encoding !== ENCODING_PLAIN && encoding !== ENCODING_8BIT_RLE) {
    throw new Error(`unsupported Sketch pixel encoding: ${encoding} (only plain and 8-bit RLE are supported)`);
  }

  // "Though all lines have the same length, this length can be a little
  // larger than the picture X size... always a whole number of longs."
  const rowStride = Math.ceil((width * bitsPerDot) / 8 / 4) * 4;
  const decodedLength = rowStride * height;

  const pixelDataStart = paintData + pixelDataOffset;
  const rawPixelData = data.subarray(pixelDataStart);
  const decoded = encoding === ENCODING_8BIT_RLE ? decode8BitRle(rawPixelData, decodedLength) : rawPixelData.subarray(0, decodedLength);

  return { width, height, rgba: unpack2BitGreyscale(decoded, width, height, rowStride) };
}

/** Converts a Psion Sketch file's bytes straight to a playable PNG file's bytes. */
export function sketchToPng(data: Uint8Array): Promise<Uint8Array> {
  const sketch = decodeSketchFile(data);
  return encodePng(sketch.width, sketch.height, sketch.rgba);
}
