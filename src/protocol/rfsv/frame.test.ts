import { describe, expect, test } from 'bun:test';
import { EpocStatus, RfsvReason } from './constants';
import { decodeRfsvReply, encodeRfsvCommand } from './frame';

describe('encodeRfsvCommand', () => {
  test('encodes [reason:u16][opId:u16][data] little-endian', () => {
    const frame = encodeRfsvCommand(RfsvReason.CloseHandle, 0x0102, Uint8Array.of(0xaa));
    expect(Array.from(frame)).toEqual([0x01, 0x00, 0x02, 0x01, 0xaa]);
  });

  test('defaults to an empty data payload', () => {
    const frame = encodeRfsvCommand(RfsvReason.GetDriveList, 5);
    expect(Array.from(frame)).toEqual([0x13, 0x00, 0x05, 0x00]);
  });
});

describe('decodeRfsvReply', () => {
  test('decodes the 8-byte header plus trailing data', () => {
    const bytes = Uint8Array.of(0x11, 0x00, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0xaa, 0xbb);
    expect(decodeRfsvReply(bytes)).toEqual({ opId: 7, status: EpocStatus.None, data: Uint8Array.of(0xaa, 0xbb) });
  });

  test('decodes a negative (error) status as a signed 32-bit value', () => {
    // status = -25 (E_EPOC_EOF) as little-endian two's complement.
    const bytes = Uint8Array.of(0x11, 0x00, 0x00, 0x00, 0xe7, 0xff, 0xff, 0xff);
    expect(decodeRfsvReply(bytes).status).toBe(EpocStatus.Eof);
  });

  test('throws on a frame shorter than the 8-byte header', () => {
    expect(() => decodeRfsvReply(Uint8Array.of(0x11, 0x00, 0x00))).toThrow(RangeError);
  });

  test('throws when the reply marker is not the 2-byte word 0x0011', () => {
    const bytes = Uint8Array.of(0x99, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
    expect(() => decodeRfsvReply(bytes)).toThrow(RangeError);
  });
});
