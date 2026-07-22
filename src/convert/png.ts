/**
 * A minimal but standards-correct PNG encoder: 8-bit RGBA, no interlacing,
 * filter type 0 (None) on every scanline. PNG's compression step (the
 * IDAT chunk) is genuinely zlib/deflate — not optional, not a format
 * choice — so this needs a real deflate implementation.
 *
 * Uses the Web Compression Streams API (`CompressionStream('deflate')`)
 * rather than `node:zlib`: this module ships inside the actual browser
 * app (Chrome has no `node:zlib`), and the Compression Streams API is a
 * genuine browser-native API — Chrome has supported it since version 80 —
 * that Bun also implements identically, so the same code path is exactly
 * what runs under `bun test` and in the shipped PWA. `'deflate'` (not
 * `'deflate-raw'`) produces zlib-wrapped output (RFC 1950 — a 2-byte
 * header + deflate stream + Adler-32 trailer), which is exactly what
 * PNG's IDAT chunk requires; confirmed round-tripping through Node's
 * `zlib.inflateSync` while developing this.
 */

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

/** Standard PNG/zlib CRC-32 (poly 0xEDB88320, reflected) — unrelated to the CRC-16/XMODEM used by the PLP link layer. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from(Array.from(type, (c) => c.charCodeAt(0)));
  const typeAndData = new Uint8Array(typeBytes.length + data.length);
  typeAndData.set(typeBytes, 0);
  typeAndData.set(data, typeBytes.length);

  const out = new Uint8Array(4 + typeAndData.length + 4);
  out.set(u32be(data.length), 0);
  out.set(typeAndData, 4);
  out.set(u32be(crc32(typeAndData)), 4 + typeAndData.length);
  return out;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  // `data` may be typed `Uint8Array<ArrayBufferLike>`; the stream wants a concrete `ArrayBuffer`-backed view.
  void writer.write(new Uint8Array(data));
  void writer.close();

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.length;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Encodes an 8-bit RGBA pixel buffer (`width * height * 4` bytes, row-major) as a PNG file. */
export async function encodePng(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  if (rgba.length !== width * height * 4) {
    throw new RangeError(`rgba buffer length ${rgba.length} doesn't match ${width}x${height}x4`);
  }

  const ihdr = Uint8Array.from([...u32be(width), ...u32be(height), 8 /* bit depth */, 6 /* color type: RGBA */, 0, 0, 0]);

  // Each scanline gets a leading filter-type byte (0 = None).
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const idatData = await deflate(raw);

  const chunks = [chunk('IHDR', ihdr), chunk('IDAT', idatData), chunk('IEND', new Uint8Array(0))];
  const totalLength = PNG_SIGNATURE.length + chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(totalLength);
  out.set(PNG_SIGNATURE, 0);
  let offset = PNG_SIGNATURE.length;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
