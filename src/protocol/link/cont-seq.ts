import { PduType } from './constants';

/**
 * Cont/Seq header: 1 byte normally (high nibble = PduType, low nibble =
 * seq 0-7), or 2 bytes for EPOC's extended sequencing (seq 0-2047, used by
 * Ack_Pdu/Data_Pdu once the mod-2048 window exceeds 7). Bit 3 of the low
 * nibble flags the extension; when set, a second byte carries `seq >> 3`
 * and the low nibble carries `seq & 0x7`.
 *
 * This exact bit layout isn't spelled out in BRIEF.md/the PLP spec prose —
 * confirmed against plptools' `Link::transmit`/`Link::sendAck` (encode) and
 * `Link::receive` (decode) in lib/link.cc, per CLAUDE.md's instruction to
 * treat plptools as ground truth over ambiguous spec prose.
 */
export interface ContSeqHeader {
  pduType: PduType;
  seq: number;
}

const MAX_EXTENDED_SEQ = 0x7ff; // mod-2048, EPOC variant only

export function encodeContSeq({ pduType, seq }: ContSeqHeader): Uint8Array {
  if (!Number.isInteger(seq) || seq < 0 || seq > MAX_EXTENDED_SEQ) {
    throw new RangeError(`seq out of range (0-${MAX_EXTENDED_SEQ}): ${seq}`);
  }
  const contBits = (pduType & 0xf) << 4;
  if (seq <= 7) {
    return Uint8Array.of(contBits | seq);
  }
  const low = contBits | ((seq & 0x7) | 0x8);
  const high = seq >> 3;
  return Uint8Array.of(low, high);
}

export interface DecodedContSeq extends ContSeqHeader {
  /** Number of header bytes consumed from the input (1 or 2). */
  byteLength: number;
}

export function decodeContSeq(bytes: Uint8Array): DecodedContSeq {
  if (bytes.length < 1) {
    throw new RangeError('need at least 1 byte to decode a Cont/Seq header');
  }
  const first = bytes[0]!;
  const pduType = (first >> 4) as PduType;
  const low = first & 0x0f;
  if ((low & 0x8) === 0) {
    return { pduType, seq: low, byteLength: 1 };
  }
  if (bytes.length < 2) {
    throw new RangeError('truncated extended Cont/Seq header: missing high byte');
  }
  const high = bytes[1]!;
  const seq = (high << 3) | (low & 0x7);
  return { pduType, seq, byteLength: 2 };
}
