import { describe, expect, test } from 'bun:test';
import { decodeRecordFile, encodeWav, recordToWav } from './record';

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

/** Builds a byte-correct Record file: header + Section Table (Record Section only) + Record Section body. */
function buildRecordFile(options: { codec?: number; volume?: number; repeatCountMinusOne?: number; repeatDelayUs?: number; soundData: number[] }): Uint8Array {
  const codec = options.codec ?? 0x00000000;
  const volume = options.volume ?? 3;
  const repeatCountMinusOne = options.repeatCountMinusOne ?? 0;
  const repeatDelayUs = options.repeatDelayUs ?? 1_000_000;
  const soundData = options.soundData;

  const header = [
    ...u32le(0x10000037), // UID1
    ...u32le(0x1000006d), // UID2
    ...u32le(0x1000007e), // UID3: Record
    ...u32le(0), // UID4 checksum, unvalidated
    ...u32le(0x14), // Section Table Section offset (right after this 20-byte header)
  ];
  const RECORD_SECTION_ID = 0x10000052;
  const sectionOffset = 0x14 + 1 + 8; // header end + count byte + one (id, offset) pair
  const table = [2 /* one entry = 2 Longs */, ...u32le(RECORD_SECTION_ID), ...u32le(sectionOffset)];
  const recordSection = [
    ...u32le(soundData.length), // uncompressed data length
    ...u32le(codec),
    ...u16le(repeatCountMinusOne),
    volume,
    0, // padding
    ...u32le(repeatDelayUs),
    ...u32le(soundData.length), // LListB length prefix
    ...soundData,
  ];

  return Uint8Array.from([...header, ...table, ...recordSection]);
}

describe('decodeRecordFile', () => {
  test('A-law-decodes the sound data (standard/G.711 codec, not linear PCM)', () => {
    // Known G.711 A-law decode pairs (the standard's own segment-encoded
    // table, not Psion-specific): 0xD5/0x55 are the near-zero codewords,
    // 0x2A decodes to the most negative representable value.
    const soundData = [0xd5, 0x55, 0x2a];
    const file = buildRecordFile({ soundData, volume: 4, repeatCountMinusOne: 2, repeatDelayUs: 500_000 });

    const audio = decodeRecordFile(file);

    expect(Array.from(audio.samples)).toEqual([8, -8, -32256]);
    expect(audio.volume).toBe(4);
    expect(audio.repeatCount).toBe(3);
    expect(audio.repeatDelayMs).toBe(500);
    expect(audio.sampleRate).toBeGreaterThan(0);
  });

  test('rejects ADPCM-coded files with a clear error rather than mis-decoding them', () => {
    const file = buildRecordFile({ codec: 0x100001a1, soundData: [1, 2, 3] });
    expect(() => decodeRecordFile(file)).toThrow('ADPCM');
  });

  test('rejects a file whose UID3 is not Record', () => {
    const file = buildRecordFile({ soundData: [1] });
    file[8] = 0x7f; // corrupt UID3 to Word's (0x1000007F)
    expect(() => decodeRecordFile(file)).toThrow(/not a Record file/);
  });
});

describe('encodeWav', () => {
  test('produces a well-formed 16-bit mono PCM WAV header', () => {
    const samples = Int16Array.of(100, -200, 32000);
    const wav = encodeWav(samples, 8000);
    const view = new DataView(wav.buffer);

    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe('WAVE');
    expect(new TextDecoder().decode(wav.subarray(12, 16))).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(8000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(new TextDecoder().decode(wav.subarray(36, 40))).toBe('data');
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(view.getInt16(44, true)).toBe(100);
    expect(view.getInt16(46, true)).toBe(-200);
    expect(view.getInt16(48, true)).toBe(32000);
  });
});

describe('recordToWav', () => {
  test('round-trips a Record file straight to WAV bytes', () => {
    const file = buildRecordFile({ soundData: [0xd5, 0x2a] });

    const wav = recordToWav(file);
    const view = new DataView(wav.buffer);

    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(view.getInt16(44, true)).toBe(8);
    expect(view.getInt16(46, true)).toBe(-32256);
  });
});
