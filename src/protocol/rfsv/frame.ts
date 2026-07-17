import { EpocStatus, RFSV_REPLY_MARKER, RfsvReason } from './constants';

/**
 * RFSV32 command/reply general framing (BRIEF.md §4.4 / PLP spec
 * §"EPOC Command Frames"). All multi-byte integers are little-endian,
 * confirmed against plptools' `BufferStore::addWord`/`addDWord` and
 * `RFSV32::sendCommand`/`getResponse` (lib/rfsv32.cc).
 *
 * Command: [reason:u16][opId:u16][data...]
 * Reply:   [0x0011:u16][opId:u16][status:i32][data...]
 *
 * Note the reply marker is a 2-byte word (0x0011), not the single byte
 * `0x11` a quick read of the spec table might suggest — its "Bytes" column
 * lists a width of 2 for that field.
 */
export function encodeRfsvCommand(reason: RfsvReason, opId: number, data: Uint8Array = new Uint8Array()): Uint8Array {
  const out = new Uint8Array(4 + data.length);
  out[0] = reason & 0xff;
  out[1] = (reason >> 8) & 0xff;
  out[2] = opId & 0xff;
  out[3] = (opId >> 8) & 0xff;
  out.set(data, 4);
  return out;
}

export interface DecodedRfsvReply {
  opId: number;
  status: EpocStatus;
  data: Uint8Array;
}

export function decodeRfsvReply(bytes: Uint8Array): DecodedRfsvReply {
  if (bytes.length < 8) {
    throw new RangeError('RFSV reply shorter than the 8-byte header');
  }
  const marker = bytes[0]! | (bytes[1]! << 8);
  if (marker !== RFSV_REPLY_MARKER) {
    throw new RangeError(`unexpected RFSV reply marker: 0x${marker.toString(16)}`);
  }
  const opId = bytes[2]! | (bytes[3]! << 8);
  const status = (bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) | (bytes[7]! << 24)) as EpocStatus;
  return { opId, status, data: bytes.subarray(8) };
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function encodeU32le(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function encodeU16le(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export const rfsvBytes = { u32le, encodeU32le, encodeU16le, concatBytes };
