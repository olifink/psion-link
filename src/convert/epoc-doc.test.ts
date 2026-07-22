import { describe, expect, test } from 'bun:test';
import { parseEpocDocHeader, sectionBytes } from './epoc-doc';

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/** Builds a minimal but format-correct EPOC structured document: header + Section Table + one dummy section. */
function buildDoc(uid3: number, sections: Array<{ id: number; data: number[] }>): Uint8Array {
  const headerAndTable: number[] = [
    ...u32le(0x10000037), // UID1
    ...u32le(0x1000006d), // UID2
    ...u32le(uid3), // UID3
    ...u32le(0), // UID4 (checksum, unvalidated)
    ...u32le(0x14), // pointer to Section Table Section, right after the header
    countLongsByte(sections.length),
  ];

  let cursor = headerAndTable.length + sections.length * 8; // table pairs come right after the count byte
  const tableEntries: number[] = [];
  const sectionBodies: number[] = [];
  for (const section of sections) {
    tableEntries.push(...u32le(section.id), ...u32le(cursor));
    sectionBodies.push(...section.data);
    cursor += section.data.length;
  }

  return Uint8Array.from([...headerAndTable, ...tableEntries, ...sectionBodies]);
}

function countLongsByte(entryCount: number): number {
  return entryCount * 2; // BListL: count is in units of 4-byte Longs, 2 Longs (id + offset) per entry
}

describe('parseEpocDocHeader', () => {
  test('reads the three type UIDs', () => {
    const doc = buildDoc(0x1000007e, [{ id: 0x10000052, data: [1, 2, 3] }]);
    const header = parseEpocDocHeader(doc);
    expect(header.uid1).toBe(0x10000037);
    expect(header.uid2).toBe(0x1000006d);
    expect(header.uid3).toBe(0x1000007e);
  });

  test('maps section IDs to their byte offsets', () => {
    const doc = buildDoc(0x1000007e, [
      { id: 0x10000052, data: [0xaa, 0xbb] },
      { id: 0x10000089, data: [0xcc] },
    ]);
    const header = parseEpocDocHeader(doc);
    expect(header.sections.size).toBe(2);

    const recordOffset = header.sections.get(0x10000052)!;
    expect(Array.from(doc.subarray(recordOffset, recordOffset + 2))).toEqual([0xaa, 0xbb]);

    const appIdOffset = header.sections.get(0x10000089)!;
    expect(Array.from(doc.subarray(appIdOffset, appIdOffset + 1))).toEqual([0xcc]);
  });

  test('throws on a truncated header', () => {
    expect(() => parseEpocDocHeader(Uint8Array.of(1, 2, 3))).toThrow();
  });

  test('throws when the section table offset points outside the file', () => {
    const doc = Uint8Array.from([...u32le(0x10000037), ...u32le(0x1000006d), ...u32le(0x1000007e), ...u32le(0), ...u32le(9999)]);
    expect(() => parseEpocDocHeader(doc)).toThrow();
  });
});

describe('sectionBytes', () => {
  test('bounds a middle section by the following section\'s offset', () => {
    const doc = buildDoc(0x1000007e, [
      { id: 0x10000243, data: [0x11, 0x11] },
      { id: 0x10000052, data: [0xaa, 0xbb, 0xbb] },
      { id: 0x10000089, data: [0xcc, 0xcc, 0xcc, 0xcc] },
    ]);
    const header = parseEpocDocHeader(doc);
    expect(Array.from(sectionBytes(header, doc, 0x10000052))).toEqual([0xaa, 0xbb, 0xbb]);
  });

  test('bounds the last section by EOF', () => {
    const doc = buildDoc(0x1000007e, [{ id: 0x10000052, data: [1, 2, 3, 4] }]);
    const header = parseEpocDocHeader(doc);
    expect(Array.from(sectionBytes(header, doc, 0x10000052))).toEqual([1, 2, 3, 4]);
  });

  test('throws for an unknown section ID', () => {
    const doc = buildDoc(0x1000007e, [{ id: 0x10000052, data: [1] }]);
    const header = parseEpocDocHeader(doc);
    expect(() => sectionBytes(header, doc, 0x99999999)).toThrow();
  });
});
