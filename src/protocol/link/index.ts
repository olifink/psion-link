/**
 * Data link layer: SYN/DLE/STX framing, byte-stuffing, CRC-16/XMODEM
 * (see `crc16.ts`), ARQ, and the EPOC connection state machine
 * (Idle -> Idle_Req -> Idle_Ack -> Data -> Data_Ack). EPOC variant only
 * (multi-windowed, mod-2048 sequencing) — no SIBO single-window/mod-8 path.
 *
 * Framework-free: no `@angular/*` imports. See CLAUDE.md "Architecture".
 */
export { crc16Xmodem } from './crc16';
export { PduType, SYN, DLE, STX, ETX, EOT } from './constants';
export { encodeContSeq, decodeContSeq } from './cont-seq';
export type { ContSeqHeader, DecodedContSeq } from './cont-seq';
export { encodeFrame, FrameDecoder } from './framing';
export type { FrameEncodeOptions, DecodedFrame } from './framing';
