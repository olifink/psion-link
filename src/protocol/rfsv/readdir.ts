import { FileAttribute } from './constants';
import { epocTimeToDate } from './time';

export interface RfsvDirEntry {
  name: string;
  /** SIBO-compatible 8.3 name, when it differs from `name`; absent otherwise. */
  shortName?: string;
  isDirectory: boolean;
  sizeBytes: number;
  modified: Date;
  attributes: number;
  /** Only populated when the request set ATTR_GET_UID (PLP spec bit 28). */
  uid?: [number, number, number];
}

const ENTRY_FIXED_FIELDS_SIZE = 36; // 9 x u32 fields, offsets 0..32 (see below)

function alignTo4(offset: number): number {
  return (offset + 3) & ~3;
}

/**
 * Parses as many complete `RFSV32_READ_DIR` entries as fit in `buffer`,
 * returning any trailing unconsumed bytes as `remainder` (normally empty
 * — devices batch whole entries per reply, per plptools' own assumption).
 *
 * Field layout (offsets relative to the start of each entry) confirmed
 * against plptools' `RFSV32::readdir` (lib/rfsv32.cc), not reconstructed
 * from the spec table alone — this is exactly the "easy to transpose"
 * alignment padding BRIEF.md §4.4 warns about. Per entry:
 *
 *   0  ShortNameLength (u32)      20  UID1 (u32)
 *   4  Attributes (u32)           24  UID2 (u32)
 *   8  Size (u32)                 28  UID3 (u32)
 *  12  ModifiedLow (u32)          32  LongNameLength (u32)
 *  16  ModifiedHigh (u32)         36  LongName (LongNameLength bytes)
 *                                 ... pad to 4-byte align ...
 *                                     ShortName (ShortNameLength bytes)
 *                                 ... pad to 4-byte align ...  <- next entry
 *
 * LongName/ShortName are decoded as Windows-1252 (the PLP spec's general
 * "EPOC character set" rule for RFSV32 strings) — plptools itself just
 * appends raw bytes as chars, which would mis-render anything outside
 * ASCII; decoding properly here is a deliberate improvement, not a
 * wire-format difference.
 */
export function parseReadDirEntries(buffer: Uint8Array): { entries: RfsvDirEntry[]; remainder: Uint8Array } {
  const entries: RfsvDirEntry[] = [];
  let offset = 0;

  while (buffer.length - offset >= ENTRY_FIXED_FIELDS_SIZE) {
    const base = offset;
    const shortNameLength = u32le(buffer, base + 0);
    const attributes = u32le(buffer, base + 4);
    const size = u32le(buffer, base + 8);
    const modifiedLow = u32le(buffer, base + 12);
    const modifiedHigh = u32le(buffer, base + 16);
    const uid1 = u32le(buffer, base + 20);
    const uid2 = u32le(buffer, base + 24);
    const uid3 = u32le(buffer, base + 28);
    const longNameLength = u32le(buffer, base + 32);

    let cursor = base + ENTRY_FIXED_FIELDS_SIZE;
    if (buffer.length - cursor < longNameLength) {
      break; // Incomplete entry; leave it in the remainder.
    }
    const longName = decodeWindows1252(buffer.subarray(cursor, cursor + longNameLength));
    cursor = alignTo4(cursor + longNameLength);

    if (buffer.length - cursor < shortNameLength) {
      break;
    }
    const shortName = shortNameLength > 0 ? decodeWindows1252(buffer.subarray(cursor, cursor + shortNameLength)) : undefined;
    cursor = alignTo4(cursor + shortNameLength);

    entries.push({
      name: longName,
      shortName,
      isDirectory: (attributes & FileAttribute.Directory) !== 0,
      sizeBytes: size,
      modified: epocTimeToDate(modifiedLow, modifiedHigh),
      attributes,
      uid: uid1 !== 0 || uid2 !== 0 || uid3 !== 0 ? [uid1, uid2, uid3] : undefined,
    });
    offset = cursor;
  }

  return { entries, remainder: buffer.subarray(offset) };
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

const decoder = new TextDecoder('windows-1252');
function decodeWindows1252(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
