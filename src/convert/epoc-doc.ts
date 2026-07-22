/**
 * The generic "structured document" container shared by Word, Sketch,
 * Record, and other built-in EPOC file formats: a 16-byte header (three
 * type UIDs + a UID4 checksum, not validated here) followed by a Section
 * Table that maps section IDs to byte offsets within the file.
 *
 * Byte layout confirmed against `examples/Willkommen zum Serie 5` (a real
 * Word file pulled off a Series 5) as well as psiconv's documentation
 * (https://frodo.looijaard.name/psifiles/Header_Section,
 * .../Section_Table_Section, .../Basic_Elements) — not reconstructed from
 * memory. In particular: the 4-byte pointer at offset 0x10 really does
 * point at a `BListL` (psiconv's notation: a 1-byte length indicator,
 * counted in 4-byte "Longs") of (sectionId, offset) pairs, verified by
 * walking the real Word file's table and confirming every section ID
 * against psiconv's known-identifier list and every offset against where
 * that section's recognizable content actually starts in the file.
 */

const HEADER_SIZE = 0x14;

export interface EpocDocHeader {
  uid1: number;
  uid2: number;
  uid3: number;
  /** Section ID -> byte offset of that section's data within the file. */
  sections: Map<number, number>;
}

function u32le(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new RangeError(`truncated EPOC document: expected 4 bytes at offset ${offset}`);
  }
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

/** Parses the header + Section Table shared by every EPOC structured-document format. */
export function parseEpocDocHeader(data: Uint8Array): EpocDocHeader {
  if (data.length < HEADER_SIZE) {
    throw new Error('too short to be an EPOC structured document');
  }
  const uid1 = u32le(data, 0x00);
  const uid2 = u32le(data, 0x04);
  const uid3 = u32le(data, 0x08);
  // UID4 (checksum of UID1-3) at 0x0c is not validated — see readdir.ts's
  // precedent of not validating the equivalent SIS/RFSV32 checksums either.
  const sectionTableOffset = u32le(data, 0x10);
  return { uid1, uid2, uid3, sections: parseSectionTable(data, sectionTableOffset) };
}

function parseSectionTable(data: Uint8Array, offset: number): Map<number, number> {
  if (offset < 0 || offset >= data.length) {
    throw new RangeError(`section table offset ${offset} is outside the file`);
  }
  const countLongs = data[offset]!;
  if (countLongs % 2 !== 0) {
    throw new Error(`section table has an odd Long count (${countLongs}); expected (id, offset) pairs`);
  }
  const sections = new Map<number, number>();
  let cursor = offset + 1;
  for (let i = 0; i < countLongs; i += 2) {
    const id = u32le(data, cursor);
    const sectionOffset = u32le(data, cursor + 4);
    sections.set(id, sectionOffset);
    cursor += 8;
  }
  return sections;
}

export function hex32(value: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}
