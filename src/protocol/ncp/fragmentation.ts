import { NCP_FRAGMENT_SIZE, NcpDataFrameType } from './constants';
import { encodeDataFrame } from './frame';

/**
 * Splits an application payload into wire-encoded NCP Data frames, ready
 * for the data link: zero or more Partial frames followed by one Complete
 * frame, chunked at `chunkSize` bytes (PLP spec §"Data Frames"). An empty
 * payload still produces a single (empty) Complete frame.
 */
export function fragmentDataPayload(
  dest: number,
  src: number,
  payload: Uint8Array,
  chunkSize: number = NCP_FRAGMENT_SIZE,
): Uint8Array[] {
  const chunkCount = Math.max(1, Math.ceil(payload.length / chunkSize));
  const frames: Uint8Array[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize;
    const chunk = payload.subarray(start, start + chunkSize);
    const isLast = i === chunkCount - 1;
    frames.push(encodeDataFrame(dest, src, isLast ? NcpDataFrameType.Complete : NcpDataFrameType.Partial, chunk));
  }
  return frames;
}

/**
 * Reassembles a sequence of Partial frames terminated by a Complete frame
 * (PLP spec §"Data Frames") back into the original payload. One instance
 * per channel — plptools keeps equivalent per-channel state in
 * `NCP::receive`'s `messageList[channel]` (lib/ncp.cc).
 */
export class FrameReassembler {
  private chunks: Uint8Array[] = [];

  /** Returns the reassembled payload once a Complete frame arrives, else null. */
  push(frameType: NcpDataFrameType, data: Uint8Array): Uint8Array | null {
    this.chunks.push(data);
    if (frameType !== NcpDataFrameType.Complete) {
      return null;
    }
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    return out;
  }
}
