import { CONTROL_CHANNEL, MAX_SERVER_NAME_BYTES, NcpControlFrameType, NcpDataFrameType } from './constants';

/**
 * General NCP frame: [Destination channel][Source channel][Frame type][Data].
 * For control frames (Destination = 0), the "Source channel" slot is
 * repurposed by each command as a channel argument (see PLP spec
 * §"Command Frames"), not an actual sender channel — this matches
 * plptools' `NCP::receive`/`decodeControlMessage` (lib/ncp.cc), which
 * reads that byte as `remoteChan` regardless of frame type.
 */
export interface NcpHeader {
  dest: number;
  src: number;
  frameType: number;
}

export function encodeNcpHeader(header: NcpHeader): Uint8Array {
  return Uint8Array.of(header.dest, header.src, header.frameType);
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

/**
 * Server/connect names are ASCII, NUL-terminated (not length-prefixed —
 * unlike RFSV32's own string fields per BRIEF.md §4.4). Confirmed against
 * plptools' `BufferStore::addString` + explicit `addByte(0)` in
 * `NCP::connect` (lib/ncp.cc).
 */
function encodeAsciiNulString(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length + 1);
  for (let i = 0; i < value.length; i++) {
    bytes[i] = value.charCodeAt(i) & 0x7f;
  }
  bytes[value.length] = 0;
  return bytes;
}

function decodeAsciiNulString(bytes: Uint8Array): { value: string; byteLength: number } {
  const end = bytes.indexOf(0);
  if (end === -1) {
    throw new RangeError('missing NUL terminator in ASCII string field');
  }
  let value = '';
  for (let i = 0; i < end; i++) {
    value += String.fromCharCode(bytes[i]!);
  }
  return { value, byteLength: end + 1 };
}

export function encodeConnectFrame(clientChannel: number, serverName: string): Uint8Array {
  const nameBytes = encodeAsciiNulString(serverName);
  if (nameBytes.length > MAX_SERVER_NAME_BYTES) {
    throw new RangeError(`server name exceeds ${MAX_SERVER_NAME_BYTES} bytes incl. NUL terminator: "${serverName}"`);
  }
  const header = encodeNcpHeader({ dest: CONTROL_CHANNEL, src: clientChannel, frameType: NcpControlFrameType.Connect });
  return concatBytes(header, nameBytes);
}

/** BRIEF.md §4.3 / PLP spec §"NCP Information Frame": Version (1 byte) + ID (4 bytes, little-endian per `BufferStore::addDWord`). */
export function encodeNcpInfoFrame(version: number, id: number): Uint8Array {
  const header = encodeNcpHeader({
    dest: CONTROL_CHANNEL,
    src: CONTROL_CHANNEL,
    frameType: NcpControlFrameType.NcpInformation,
  });
  const body = Uint8Array.of(version & 0xff, id & 0xff, (id >>> 8) & 0xff, (id >>> 16) & 0xff, (id >>> 24) & 0xff);
  return concatBytes(header, body);
}

/** PLP spec §"Connection Termination Frame": sent by a client to indicate it has disconnected from `serverChannel`. */
export function encodeConnectionTerminationFrame(serverChannel: number): Uint8Array {
  return encodeNcpHeader({
    dest: CONTROL_CHANNEL,
    src: serverChannel,
    frameType: NcpControlFrameType.ConnectionTermination,
  });
}

/** PLP spec §"NCP Termination Frame": "The NCP has shut down." plptools always sends this with channel arg 0. */
export function encodeNcpTerminationFrame(): Uint8Array {
  return encodeNcpHeader({ dest: CONTROL_CHANNEL, src: 0, frameType: NcpControlFrameType.NcpTermination });
}

export function encodeDataFrame(dest: number, src: number, frameType: NcpDataFrameType, data: Uint8Array): Uint8Array {
  return concatBytes(encodeNcpHeader({ dest, src, frameType }), data);
}

export type DecodedNcpFrame =
  | { kind: 'xoff'; channel: number }
  | { kind: 'xon'; channel: number }
  | { kind: 'connect'; clientChannel: number; serverName: string }
  | { kind: 'connectResponse'; clientChannel: number; serverChannel: number; status: number }
  | { kind: 'connectionTermination'; serverChannel: number }
  | { kind: 'ncpInfo'; version: number; id: number }
  | { kind: 'disconnection'; serverChannel: number; clientChannel: number }
  | { kind: 'ncpTermination'; channel: number }
  | { kind: 'data'; dest: number; src: number; frameType: NcpDataFrameType; data: Uint8Array };

/**
 * Decodes a de-fragmented NCP-layer payload (as delivered by the data
 * link, Cont/Seq header already stripped) into its header plus a typed
 * body. Byte layout cross-checked against plptools' `NCP::receive` /
 * `NCP::decodeControlMessage` (lib/ncp.cc).
 */
export function decodeNcpFrame(payload: Uint8Array): DecodedNcpFrame {
  if (payload.length < 3) {
    throw new RangeError('NCP frame shorter than the 3-byte header');
  }
  const dest = payload[0]!;
  const src = payload[1]!;
  const frameType = payload[2]!;
  const body = payload.subarray(3);

  if (dest !== CONTROL_CHANNEL) {
    if (frameType !== NcpDataFrameType.Complete && frameType !== NcpDataFrameType.Partial) {
      throw new RangeError(`unknown NCP data frame type: ${frameType}`);
    }
    return { kind: 'data', dest, src, frameType, data: body };
  }

  switch (frameType) {
    case NcpControlFrameType.Xoff:
      return { kind: 'xoff', channel: src };
    case NcpControlFrameType.Xon:
      return { kind: 'xon', channel: src };
    case NcpControlFrameType.Connect: {
      const { value } = decodeAsciiNulString(body);
      return { kind: 'connect', clientChannel: src, serverName: value };
    }
    case NcpControlFrameType.ConnectResponse:
      return { kind: 'connectResponse', serverChannel: src, clientChannel: body[0]!, status: body[1]! };
    case NcpControlFrameType.ConnectionTermination:
      return { kind: 'connectionTermination', serverChannel: src };
    case NcpControlFrameType.NcpInformation:
      return {
        kind: 'ncpInfo',
        version: body[0]!,
        id: (body[1]! | (body[2]! << 8) | (body[3]! << 16) | (body[4]! << 24)) >>> 0,
      };
    case NcpControlFrameType.Disconnection:
      return { kind: 'disconnection', serverChannel: src, clientChannel: body[0]! };
    case NcpControlFrameType.NcpTermination:
      return { kind: 'ncpTermination', channel: src };
    default:
      throw new RangeError(`unknown NCP control frame type: ${frameType}`);
  }
}
