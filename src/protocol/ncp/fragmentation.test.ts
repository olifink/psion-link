import { describe, expect, test } from 'bun:test';
import { NcpDataFrameType } from './constants';
import { decodeNcpFrame } from './frame';
import { FrameReassembler, fragmentDataPayload } from './fragmentation';

describe('fragmentDataPayload', () => {
  test('a payload under the chunk size produces a single Complete frame', () => {
    const frames = fragmentDataPayload(3, 2, Uint8Array.of(1, 2, 3), 10);
    expect(frames).toHaveLength(1);
    const decoded = decodeNcpFrame(frames[0]!);
    expect(decoded).toMatchObject({ kind: 'data', dest: 3, src: 2, frameType: NcpDataFrameType.Complete });
  });

  test('an empty payload still produces one (empty) Complete frame', () => {
    const frames = fragmentDataPayload(3, 2, Uint8Array.of(), 10);
    expect(frames).toHaveLength(1);
    const decoded = decodeNcpFrame(frames[0]!);
    expect(decoded).toMatchObject({ kind: 'data', frameType: NcpDataFrameType.Complete });
    expect((decoded as { data: Uint8Array }).data).toHaveLength(0);
  });

  test('a payload over the chunk size splits into Partial frames + a trailing Complete', () => {
    const payload = Uint8Array.from({ length: 25 }, (_, i) => i);
    const frames = fragmentDataPayload(3, 2, payload, 10);

    expect(frames).toHaveLength(3); // 10 + 10 + 5
    const decoded = frames.map((f) => decodeNcpFrame(f));
    expect(decoded[0]).toMatchObject({ frameType: NcpDataFrameType.Partial });
    expect(decoded[1]).toMatchObject({ frameType: NcpDataFrameType.Partial });
    expect(decoded[2]).toMatchObject({ frameType: NcpDataFrameType.Complete });

    const reassembled = Uint8Array.from([
      ...(decoded[0] as { data: Uint8Array }).data,
      ...(decoded[1] as { data: Uint8Array }).data,
      ...(decoded[2] as { data: Uint8Array }).data,
    ]);
    expect(Array.from(reassembled)).toEqual(Array.from(payload));
  });

  test('an exact multiple of the chunk size ends on a Complete frame, not an extra empty one', () => {
    const payload = new Uint8Array(20);
    const frames = fragmentDataPayload(3, 2, payload, 10);
    expect(frames).toHaveLength(2);
    expect(decodeNcpFrame(frames[1]!)).toMatchObject({ frameType: NcpDataFrameType.Complete });
  });
});

describe('FrameReassembler', () => {
  test('returns null until a Complete frame arrives, then the concatenated payload', () => {
    const reassembler = new FrameReassembler();
    expect(reassembler.push(NcpDataFrameType.Partial, Uint8Array.of(1, 2))).toBeNull();
    expect(reassembler.push(NcpDataFrameType.Partial, Uint8Array.of(3, 4))).toBeNull();
    const result = reassembler.push(NcpDataFrameType.Complete, Uint8Array.of(5, 6));
    expect(Array.from(result!)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('a single Complete frame with no preceding Partials works standalone', () => {
    const reassembler = new FrameReassembler();
    const result = reassembler.push(NcpDataFrameType.Complete, Uint8Array.of(9));
    expect(Array.from(result!)).toEqual([9]);
  });

  test('resets after completion, ready for the next message', () => {
    const reassembler = new FrameReassembler();
    reassembler.push(NcpDataFrameType.Complete, Uint8Array.of(1));
    const second = reassembler.push(NcpDataFrameType.Complete, Uint8Array.of(2));
    expect(Array.from(second!)).toEqual([2]);
  });

  test('fragmentDataPayload output round-trips through FrameReassembler', () => {
    const payload = Uint8Array.from({ length: 777 }, (_, i) => i & 0xff);
    const frames = fragmentDataPayload(3, 2, payload, 250);

    const reassembler = new FrameReassembler();
    let result: Uint8Array | null = null;
    for (const frame of frames) {
      const decoded = decodeNcpFrame(frame);
      if (decoded.kind !== 'data') throw new Error('expected a data frame');
      result = reassembler.push(decoded.frameType, decoded.data);
    }
    expect(Array.from(result!)).toEqual(Array.from(payload));
  });
});
