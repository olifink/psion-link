import { describe, expect, test } from 'bun:test';
import { NcpControlFrameType, NcpDataFrameType } from './constants';
import {
  decodeNcpFrame,
  encodeConnectFrame,
  encodeConnectionTerminationFrame,
  encodeDataFrame,
  encodeNcpHeader,
  encodeNcpInfoFrame,
  encodeNcpTerminationFrame,
} from './frame';

describe('encodeNcpHeader', () => {
  test('produces the 3-byte [dest][src][type] header', () => {
    expect(Array.from(encodeNcpHeader({ dest: 1, src: 2, frameType: 3 }))).toEqual([1, 2, 3]);
  });
});

describe('encodeConnectFrame / decodeNcpFrame(connect)', () => {
  test('encodes dest=0, src=clientChannel, type=Connect, NUL-terminated ASCII name', () => {
    const frame = encodeConnectFrame(2, 'SYS$RFSV.*');
    // 'SYS$RFSV.*' is 10 chars + NUL = 11 bytes.
    expect(Array.from(frame.subarray(0, 3))).toEqual([0x00, 2, NcpControlFrameType.Connect]);
    expect(frame.length).toBe(3 + 11);
    expect(frame[frame.length - 1]).toBe(0x00);
  });

  test('round-trips through decodeNcpFrame', () => {
    const frame = encodeConnectFrame(5, 'LINK.*');
    const decoded = decodeNcpFrame(frame);
    expect(decoded).toEqual({ kind: 'connect', clientChannel: 5, serverName: 'LINK.*' });
  });

  test('rejects server names that would exceed 16 bytes including the NUL terminator', () => {
    expect(() => encodeConnectFrame(1, 'A'.repeat(16))).toThrow(RangeError);
    expect(() => encodeConnectFrame(1, 'A'.repeat(15))).not.toThrow(); // 15 + NUL = 16, exactly at the limit
  });
});

describe('encodeNcpInfoFrame / decodeNcpFrame(ncpInfo)', () => {
  test('encodes version + little-endian 32-bit id', () => {
    const frame = encodeNcpInfoFrame(0x10, 0x01020304);
    expect(Array.from(frame)).toEqual([0x00, 0x00, NcpControlFrameType.NcpInformation, 0x10, 0x04, 0x03, 0x02, 0x01]);
  });

  test('round-trips through decodeNcpFrame', () => {
    const frame = encodeNcpInfoFrame(0x10, 0xdeadbeef);
    expect(decodeNcpFrame(frame)).toEqual({ kind: 'ncpInfo', version: 0x10, id: 0xdeadbeef });
  });
});

describe('decodeNcpFrame(connectResponse)', () => {
  test('parses serverChannel from the header src slot and clientChannel/status from the body', () => {
    const frame = Uint8Array.of(0x00, 7, NcpControlFrameType.ConnectResponse, 3, 0);
    expect(decodeNcpFrame(frame)).toEqual({ kind: 'connectResponse', serverChannel: 7, clientChannel: 3, status: 0 });
  });

  test('carries a non-zero status through for a rejected connect', () => {
    const frame = Uint8Array.of(0x00, 0, NcpControlFrameType.ConnectResponse, 3, 5);
    expect(decodeNcpFrame(frame)).toEqual({ kind: 'connectResponse', serverChannel: 0, clientChannel: 3, status: 5 });
  });
});

describe('encodeConnectionTerminationFrame / decodeNcpFrame', () => {
  test('round-trips', () => {
    const frame = encodeConnectionTerminationFrame(9);
    expect(Array.from(frame)).toEqual([0x00, 9, NcpControlFrameType.ConnectionTermination]);
    expect(decodeNcpFrame(frame)).toEqual({ kind: 'connectionTermination', serverChannel: 9 });
  });
});

describe('decodeNcpFrame(disconnection)', () => {
  test('parses serverChannel from src and clientChannel from body', () => {
    const frame = Uint8Array.of(0x00, 4, NcpControlFrameType.Disconnection, 2);
    expect(decodeNcpFrame(frame)).toEqual({ kind: 'disconnection', serverChannel: 4, clientChannel: 2 });
  });
});

describe('decodeNcpFrame(xoff/xon)', () => {
  test('parses the channel argument from the header src slot', () => {
    expect(decodeNcpFrame(Uint8Array.of(0x00, 6, NcpControlFrameType.Xoff))).toEqual({ kind: 'xoff', channel: 6 });
    expect(decodeNcpFrame(Uint8Array.of(0x00, 6, NcpControlFrameType.Xon))).toEqual({ kind: 'xon', channel: 6 });
  });
});

describe('encodeNcpTerminationFrame / decodeNcpFrame', () => {
  test('round-trips with channel arg 0', () => {
    const frame = encodeNcpTerminationFrame();
    expect(Array.from(frame)).toEqual([0x00, 0, NcpControlFrameType.NcpTermination]);
    expect(decodeNcpFrame(frame)).toEqual({ kind: 'ncpTermination', channel: 0 });
  });
});

describe('encodeDataFrame / decodeNcpFrame(data)', () => {
  test('encodes dest/src as literal channel numbers, not the control-channel convention', () => {
    const frame = encodeDataFrame(3, 2, NcpDataFrameType.Complete, Uint8Array.of(0xaa, 0xbb));
    expect(Array.from(frame)).toEqual([3, 2, NcpDataFrameType.Complete, 0xaa, 0xbb]);
  });

  test('round-trips a Partial frame', () => {
    const frame = encodeDataFrame(3, 2, NcpDataFrameType.Partial, Uint8Array.of(0x01));
    expect(decodeNcpFrame(frame)).toEqual({
      kind: 'data',
      dest: 3,
      src: 2,
      frameType: NcpDataFrameType.Partial,
      data: Uint8Array.of(0x01),
    });
  });

  test('an empty data payload still decodes cleanly', () => {
    const frame = encodeDataFrame(3, 2, NcpDataFrameType.Complete, Uint8Array.of());
    const decoded = decodeNcpFrame(frame);
    expect(decoded.kind).toBe('data');
    expect((decoded as { data: Uint8Array }).data).toHaveLength(0);
  });
});

describe('decodeNcpFrame error handling', () => {
  test('throws on a frame shorter than the 3-byte header', () => {
    expect(() => decodeNcpFrame(Uint8Array.of(0x00, 0x01))).toThrow(RangeError);
  });

  test('throws on an unknown control frame type', () => {
    expect(() => decodeNcpFrame(Uint8Array.of(0x00, 0x00, 0xff))).toThrow(RangeError);
  });

  test('throws on an unknown data frame type', () => {
    expect(() => decodeNcpFrame(Uint8Array.of(5, 3, 0xff))).toThrow(RangeError);
  });

  test('throws on a Connect frame missing its NUL terminator', () => {
    const malformed = Uint8Array.of(0x00, 1, NcpControlFrameType.Connect, 0x41, 0x42); // "AB" with no NUL
    expect(() => decodeNcpFrame(malformed)).toThrow(RangeError);
  });
});
