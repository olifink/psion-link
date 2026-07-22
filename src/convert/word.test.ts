import { describe, expect, test } from 'bun:test';
import { decodeWordParagraphs, wordToMarkdown } from './word';

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/** Encodes a byte count using the "Extra" (X) length-indicator scheme (Basic_Elements doc) — the inverse of `readExtraEncodedLength`. */
function encodeExtraLength(length: number): number[] {
  if (length <= 0x7f) {
    return [length * 2];
  }
  if (length <= 0x3fff) {
    const value = 4 * length + 1;
    return [value & 0xff, (value >>> 8) & 0xff];
  }
  const value = 8 * length + 3;
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

const TEXT_SECTION_ID = 0x10000106;

/** Builds a byte-correct Word file: header + Section Table (Text Section only) + Text Section (Extra-encoded length + content bytes). */
function buildWordFile(contentBytes: number[]): Uint8Array {
  const header = [
    ...u32le(0x10000037), // UID1
    ...u32le(0x1000006d), // UID2
    ...u32le(0x1000007f), // UID3: Word
    ...u32le(0), // UID4 checksum, unvalidated
    ...u32le(0x14), // Section Table Section offset
  ];
  const textSectionOffset = 0x14 + 1 + 8; // header end + count byte + one (id, offset) pair
  const table = [2 /* one entry = 2 Longs */, ...u32le(TEXT_SECTION_ID), ...u32le(textSectionOffset)];
  const textSection = [...encodeExtraLength(contentBytes.length), ...contentBytes];

  return Uint8Array.from([...header, ...table, ...textSection]);
}

function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

describe('decodeWordParagraphs', () => {
  test('splits on New Paragraph (0x06)', () => {
    const file = buildWordFile([...ascii('Hello'), 0x06, ...ascii('World')]);
    expect(decodeWordParagraphs(file)).toEqual(['Hello', 'World']);
  });

  test('decodes special characters via Windows-1252, matching how RFSV32 strings are decoded elsewhere', () => {
    // 0xE4 = ä in Windows-1252.
    const file = buildWordFile([...ascii('sch'), 0xe4, ...ascii('ftig')]);
    expect(decodeWordParagraphs(file)).toEqual(['schäftig']);
  });

  test('maps control codes per the ASCII_Codes doc: tab, hyphen, new line, and dropped bytes', () => {
    const file = buildWordFile([
      ...ascii('a'),
      0x09, // Tab
      ...ascii('b'),
      0x0b, // Hard hyphen
      ...ascii('c'),
      0x07, // New Line
      ...ascii('d'),
      0x0d, // "Unknown... Not displayed"
      0x0e, // Object Placeholder
      ...ascii('e'),
    ]);
    expect(decodeWordParagraphs(file)).toEqual(['a\tb-c\nde']);
  });

  test('handles a 2-byte Extra-encoded length (content over 127 bytes)', () => {
    const content = ascii('x'.repeat(200));
    const file = buildWordFile(content);
    const [paragraph] = decodeWordParagraphs(file);
    expect(paragraph).toHaveLength(200);
  });

  test('rejects a file whose UID3 is not Word', () => {
    const file = buildWordFile(ascii('hi'));
    file[8] = 0x7d; // corrupt UID3 to Sketch's (0x1000007D)
    expect(() => decodeWordParagraphs(file)).toThrow(/not a Word file/);
  });
});

describe('wordToMarkdown', () => {
  test('joins paragraphs with a blank line and drops empty ones (e.g. dropped Object Placeholders)', () => {
    const file = buildWordFile([
      0x0e, // a lone Object Placeholder paragraph -> empty after decoding -> dropped
      0x06,
      ...ascii('First paragraph.'),
      0x06,
      ...ascii('Second paragraph.'),
    ]);
    expect(wordToMarkdown(file)).toBe('First paragraph.\n\nSecond paragraph.');
  });
});
