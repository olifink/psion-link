import { describe, expect, test } from 'bun:test';
import { parseEpocDocHeader, sectionBytes } from './epoc-doc';
import { decodeWordParagraphs, textToWord, wordToMarkdown } from './word';

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

const WORD_STATUS_SECTION_ID = 0x10000243;
const WORD_STYLES_SECTION_ID = 0x10000104;
const PAGE_LAYOUT_SECTION_ID = 0x10000105;
const APPLICATION_ID_SECTION_ID = 0x10000089;
const TEXT_LAYOUT_SECTION_ID = 0x10000143;

/** Builds a template Word file with all five mandatory sections (plus an optional Text Layout Section), so `textToWord` has something realistic to copy from. */
function buildFullWordFile(options: { textContentBytes: number[]; includeTextLayout?: boolean }): Uint8Array {
  const header = [
    ...u32le(0x10000037),
    ...u32le(0x1000006d),
    ...u32le(0x1000007f),
    ...u32le(0),
    ...u32le(0x14),
  ];
  // Real Word Status Sections are 14 bytes (psiconv's Word_Status_Section
  // doc): bytes 6-9 are a saved cursor offset that textToWord patches to
  // 0, so this fixture uses a distinctive, non-zero value there
  // ([0x99, 0x99, 0x99, 0x99]) specifically to make sure the patch is
  // exercised rather than coincidentally already being 0.
  const wordStatus = [0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0x99, 0x99, 0x99, 0x99, 0xa7, 0xa8, 0xa9, 0xaa];
  const sections = [
    { id: WORD_STATUS_SECTION_ID, data: wordStatus },
    { id: WORD_STYLES_SECTION_ID, data: [0xb1, 0xb2, 0xb3, 0xb4] },
    { id: PAGE_LAYOUT_SECTION_ID, data: [0xc1] },
    { id: TEXT_SECTION_ID, data: [...encodeExtraLength(options.textContentBytes.length), ...options.textContentBytes] },
    { id: APPLICATION_ID_SECTION_ID, data: [0xd1, 0xd2] },
    ...(options.includeTextLayout ? [{ id: TEXT_LAYOUT_SECTION_ID, data: [0xe1, 0xe2, 0xe3] }] : []),
  ];

  const tableOffset = 0x14;
  const tableSize = 1 + sections.length * 8;
  let cursor = tableOffset + tableSize;
  const offsets: number[] = [];
  for (const s of sections) {
    offsets.push(cursor);
    cursor += s.data.length;
  }

  const table = [sections.length * 2, ...sections.flatMap((s, i) => [...u32le(s.id), ...u32le(offsets[i]!)])];
  const bodies = sections.flatMap((s) => s.data);

  return Uint8Array.from([...header, ...table, ...bodies]);
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

describe('textToWord', () => {
  test('round-trips plain paragraphs through decodeWordParagraphs', () => {
    const template = buildFullWordFile({ textContentBytes: ascii('placeholder') });
    const written = textToWord(['First paragraph.', 'Second paragraph with ümlaut.'], template);
    expect(decodeWordParagraphs(written)).toEqual(['First paragraph.', 'Second paragraph with ümlaut.']);
  });

  test('copies Word Styles/Page Layout/Application ID sections verbatim from the template', () => {
    const template = buildFullWordFile({ textContentBytes: ascii('old text') });
    const written = textToWord(['new text'], template);
    const writtenHeader = parseEpocDocHeader(written);

    expect(Array.from(sectionBytes(writtenHeader, written, WORD_STYLES_SECTION_ID))).toEqual([0xb1, 0xb2, 0xb3, 0xb4]);
    expect(Array.from(sectionBytes(writtenHeader, written, PAGE_LAYOUT_SECTION_ID))).toEqual([0xc1]);
    expect(Array.from(sectionBytes(writtenHeader, written, APPLICATION_ID_SECTION_ID))).toEqual([0xd1, 0xd2]);
  });

  test('copies the Word Status Section verbatim except for zeroing the saved cursor offset', () => {
    const template = buildFullWordFile({ textContentBytes: ascii('old text') });
    const written = textToWord(['new text'], template);
    const writtenHeader = parseEpocDocHeader(written);

    // [0x99, 0x99, 0x99, 0x99] at offset 6 (the cursor offset) -> zeroed; everything else unchanged.
    expect(Array.from(sectionBytes(writtenHeader, written, WORD_STATUS_SECTION_ID))).toEqual([
      0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0, 0, 0, 0, 0xa7, 0xa8, 0xa9, 0xaa,
    ]);
  });

  test('drops the Text Layout Section even when the template has one', () => {
    const template = buildFullWordFile({ textContentBytes: ascii('x'), includeTextLayout: true });
    const written = textToWord(['y'], template);
    const writtenHeader = parseEpocDocHeader(written);
    expect(writtenHeader.sections.has(TEXT_LAYOUT_SECTION_ID)).toBe(false);
  });

  test('encodes tabs and newlines back to their control bytes', () => {
    const template = buildFullWordFile({ textContentBytes: ascii('placeholder') });
    const written = textToWord(['a\tb\nc'], template);
    expect(decodeWordParagraphs(written)).toEqual(['a\tb\nc']);
  });

  test('rejects a template whose UID3 is not Word', () => {
    const template = buildFullWordFile({ textContentBytes: ascii('x') });
    template[8] = 0x7d; // corrupt UID3 to Sketch's (0x1000007D)
    expect(() => textToWord(['hi'], template)).toThrow(/not a Word file/);
  });
});
