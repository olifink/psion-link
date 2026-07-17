import { describe, expect, test } from 'bun:test';
import { PduType } from './constants';
import { ContSeqHeader, decodeContSeq, encodeContSeq } from './cont-seq';

describe('encodeContSeq', () => {
  // Fixtures cross-checked against plptools' lib/link.cc literal byte
  // constants (sendReqReq 0x21, sendReqCon 0x24, sendReq 0x20, Data seq=0
  // is 0x30 + seq, Ack seq=0 is the bare seq byte).
  const fixtures: Array<[ContSeqHeader, number[]]> = [
    [{ pduType: PduType.Ack, seq: 0 }, [0x00]],
    [{ pduType: PduType.Disc, seq: 0 }, [0x10]],
    [{ pduType: PduType.Req, seq: 0 }, [0x20]],
    [{ pduType: PduType.Req, seq: 1 }, [0x21]],
    [{ pduType: PduType.Req, seq: 4 }, [0x24]],
    [{ pduType: PduType.Data, seq: 0 }, [0x30]],
    [{ pduType: PduType.Data, seq: 7 }, [0x37]],
  ];

  test.each(fixtures)('encodes %j as %j', (header, expected) => {
    expect(Array.from(encodeContSeq(header))).toEqual(expected);
  });

  test('extends the header to 2 bytes once seq exceeds 7', () => {
    // seq=9: low = 0x30 | ((9 & 7) | 8) = 0x30 | 9 = 0x39; high = 9 >> 3 = 1.
    expect(Array.from(encodeContSeq({ pduType: PduType.Data, seq: 9 }))).toEqual([0x39, 0x01]);
  });

  test('handles the top of the mod-2048 EPOC window', () => {
    // seq=2047 (0x7ff): low = 0x00 | ((0x7ff & 7) | 8) = 0x0f; high = 0x7ff >> 3 = 0xff.
    const encoded = encodeContSeq({ pduType: PduType.Ack, seq: 2047 });
    expect(Array.from(encoded)).toEqual([0x0f, 0xff]);
  });

  test('rejects out-of-range sequence numbers', () => {
    expect(() => encodeContSeq({ pduType: PduType.Data, seq: -1 })).toThrow(RangeError);
    expect(() => encodeContSeq({ pduType: PduType.Data, seq: 2048 })).toThrow(RangeError);
  });
});

describe('decodeContSeq', () => {
  test('round-trips every seq in the unextended range for each PduType', () => {
    for (const pduType of [PduType.Ack, PduType.Disc, PduType.Req, PduType.Data]) {
      for (let seq = 0; seq <= 7; seq++) {
        const encoded = encodeContSeq({ pduType, seq });
        expect(decodeContSeq(encoded)).toEqual({ pduType, seq, byteLength: 1 });
      }
    }
  });

  test('round-trips extended sequence numbers across the mod-2048 window', () => {
    for (const seq of [8, 9, 100, 1000, 2047]) {
      const encoded = encodeContSeq({ pduType: PduType.Data, seq });
      expect(decodeContSeq(encoded)).toEqual({ pduType: PduType.Data, seq, byteLength: 2 });
    }
  });

  test('reports how many bytes it consumed, ignoring trailing bytes', () => {
    const decoded = decodeContSeq(Uint8Array.of(0x39, 0x01, 0xaa, 0xbb));
    expect(decoded).toEqual({ pduType: PduType.Data, seq: 9, byteLength: 2 });
  });

  test('throws on an empty buffer', () => {
    expect(() => decodeContSeq(Uint8Array.of())).toThrow(RangeError);
  });

  test('throws when an extended header is truncated', () => {
    expect(() => decodeContSeq(Uint8Array.of(0x39))).toThrow(RangeError);
  });
});
