import { describe, expect, test } from 'bun:test';
import { inflateSync } from 'node:zlib';
import { encodePng } from './png';

function readU32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

describe('encodePng', () => {
  test('starts with the PNG signature', async () => {
    const png = await encodePng(1, 1, Uint8Array.of(255, 0, 0, 255));
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test('IHDR declares the right width/height/bit-depth/color-type', async () => {
    const png = await encodePng(3, 2, new Uint8Array(3 * 2 * 4));
    // IHDR chunk starts right after the 8-byte signature + 4-byte length.
    const ihdrType = new TextDecoder().decode(png.subarray(12, 16));
    expect(ihdrType).toBe('IHDR');
    expect(readU32be(png, 16)).toBe(3); // width
    expect(readU32be(png, 20)).toBe(2); // height
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // color type: truecolor + alpha
  });

  test('the IDAT payload inflates back to filter-tagged scanlines matching the input pixels', async () => {
    const width = 2;
    const height = 2;
    // Row-major RGBA: red, green / blue, white.
    const rgba = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    const png = await encodePng(width, height, rgba);

    // Locate IDAT: signature(8) + IHDR chunk(4+4+13+4=25) = offset 33.
    const idatLength = readU32be(png, 33);
    const idatData = png.subarray(33 + 8, 33 + 8 + idatLength);
    const raw = inflateSync(idatData);

    const stride = width * 4;
    expect(raw.length).toBe((stride + 1) * height);
    // Filter-type byte (0 = None) precedes each scanline.
    expect(raw[0]).toBe(0);
    expect(Array.from(raw.subarray(1, 1 + stride))).toEqual(Array.from(rgba.subarray(0, stride)));
    expect(raw[1 + stride]).toBe(0);
    expect(Array.from(raw.subarray(1 + stride + 1))).toEqual(Array.from(rgba.subarray(stride)));
  });

  test('rejects a pixel buffer of the wrong length', async () => {
    await expect(encodePng(2, 2, new Uint8Array(3))).rejects.toThrow();
  });
});
