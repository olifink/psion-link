import { describe, expect, test } from 'bun:test';
import { crc16Xmodem } from './crc16';
import { DecodedFrame, FrameDecoder, encodeFrame } from './framing';

function crcBytes(payload: Uint8Array): [number, number] {
  const crc = crc16Xmodem(payload);
  return [(crc >> 8) & 0xff, crc & 0xff];
}

describe('encodeFrame', () => {
  test('wraps an empty payload in SYN DLE STX ... DLE ETX CRC', () => {
    const frame = encodeFrame(Uint8Array.of(), { epoc: true });
    const [crcHi, crcLo] = crcBytes(Uint8Array.of());
    expect(Array.from(frame)).toEqual([0x16, 0x10, 0x02, 0x10, 0x03, crcHi, crcLo]);
  });

  test('stuffs a literal DLE byte as DLE DLE', () => {
    const payload = Uint8Array.of(0x10);
    const frame = encodeFrame(payload, { epoc: true });
    const [crcHi, crcLo] = crcBytes(payload);
    expect(Array.from(frame)).toEqual([0x16, 0x10, 0x02, 0x10, 0x10, 0x10, 0x03, crcHi, crcLo]);
  });

  test('stuffs a literal ETX byte as DLE EOT in EPOC mode', () => {
    const payload = Uint8Array.of(0x03);
    const frame = encodeFrame(payload, { epoc: true });
    const [crcHi, crcLo] = crcBytes(payload);
    expect(Array.from(frame)).toEqual([0x16, 0x10, 0x02, 0x10, 0x04, 0x10, 0x03, crcHi, crcLo]);
  });

  test('sends a literal ETX byte unstuffed outside EPOC mode', () => {
    const payload = Uint8Array.of(0x03);
    const frame = encodeFrame(payload, { epoc: false });
    const [crcHi, crcLo] = crcBytes(payload);
    expect(Array.from(frame)).toEqual([0x16, 0x10, 0x02, 0x03, 0x10, 0x03, crcHi, crcLo]);
  });

  test('leaves ordinary bytes untouched', () => {
    const payload = Uint8Array.of(0x30, 0x41, 0x42);
    const frame = encodeFrame(payload, { epoc: true });
    const [crcHi, crcLo] = crcBytes(payload);
    expect(Array.from(frame)).toEqual([0x16, 0x10, 0x02, 0x30, 0x41, 0x42, 0x10, 0x03, crcHi, crcLo]);
  });
});

describe('FrameDecoder', () => {
  test('round-trips a payload containing every special byte', () => {
    const payload = Uint8Array.of(0x30, 0x10, 0x03, 0x16, 0x99);
    const frame = encodeFrame(payload, { epoc: true });

    const decoder = new FrameDecoder();
    const frames = decoder.push(frame);

    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0]!.payload)).toEqual(Array.from(payload));
    expect(frames[0]!.crcValid).toBe(true);
  });

  test('decodes correctly when fed one byte at a time', () => {
    const payload = Uint8Array.of(0x39, 0x01, 0x10, 0x03, 0xaa);
    const frame = encodeFrame(payload, { epoc: true });

    const decoder = new FrameDecoder();
    const found: DecodedFrame[] = [];
    for (const byte of frame) {
      found.push(...decoder.push(Uint8Array.of(byte)));
    }

    expect(found).toHaveLength(1);
    expect(Array.from(found[0]!.payload)).toEqual(Array.from(payload));
    expect(found[0]!.crcValid).toBe(true);
  });

  test('resyncs past garbage bytes, including a stray SYN, before a valid frame', () => {
    const payload = Uint8Array.of(0x00);
    const frame = encodeFrame(payload, { epoc: true });
    const garbage = Uint8Array.of(0xff, 0x16, 0xee, 0x16, 0x10, 0xdd);
    const input = Uint8Array.from([...garbage, ...frame]);

    const decoder = new FrameDecoder();
    const frames = decoder.push(input);

    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0]!.payload)).toEqual([0x00]);
    expect(frames[0]!.crcValid).toBe(true);
  });

  test('flags a corrupted CRC without throwing', () => {
    const payload = Uint8Array.of(0x30, 0x41);
    const frame = encodeFrame(payload, { epoc: true });
    frame[frame.length - 1] ^= 0xff; // corrupt the CRC low byte

    const decoder = new FrameDecoder();
    const frames = decoder.push(frame);

    expect(frames).toHaveLength(1);
    expect(frames[0]!.crcValid).toBe(false);
  });

  test('finds two back-to-back frames in a single chunk', () => {
    const first = encodeFrame(Uint8Array.of(0x00), { epoc: true });
    const second = encodeFrame(Uint8Array.of(0x30, 0x41), { epoc: true });

    const decoder = new FrameDecoder();
    const frames = decoder.push(Uint8Array.from([...first, ...second]));

    expect(frames).toHaveLength(2);
    expect(Array.from(frames[0]!.payload)).toEqual([0x00]);
    expect(Array.from(frames[1]!.payload)).toEqual([0x30, 0x41]);
  });

  test('destuffs DLE EOT back into a literal ETX byte', () => {
    const payload = Uint8Array.of(0x03, 0x03);
    const frame = encodeFrame(payload, { epoc: true });

    const decoder = new FrameDecoder();
    const frames = decoder.push(frame);

    expect(Array.from(frames[0]!.payload)).toEqual([0x03, 0x03]);
  });
});
