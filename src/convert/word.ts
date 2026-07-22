import { EpocDocHeader, hex32, parseEpocDocHeader, sectionBytes } from './epoc-doc';

/** Psion's built-in "Word" app's UID3 — matches `KNOWN_APP_UIDS['Word']` in file-browser.ts, sourced from real hardware. */
const WORD_APP_UID3 = 0x1000007f;

/** Section IDs within the Section Table (psiconv's Section_Table_Section doc), confirmed against a real Word file. */
const TEXT_SECTION_ID = 0x10000106;
const WORD_STATUS_SECTION_ID = 0x10000243;
const WORD_STYLES_SECTION_ID = 0x10000104;
const PAGE_LAYOUT_SECTION_ID = 0x10000105;
const APPLICATION_ID_SECTION_ID = 0x10000089;

function findTextSection(header: EpocDocHeader): number {
  if (header.uid3 !== WORD_APP_UID3) {
    throw new Error(`not a Word file (UID3 is ${hex32(header.uid3)}, expected ${hex32(WORD_APP_UID3)})`);
  }
  const offset = header.sections.get(TEXT_SECTION_ID);
  if (offset === undefined) {
    throw new Error('Word file has no Text Section');
  }
  return offset;
}

/**
 * The Text Section is an `XListB` (psiconv's Basic_Elements doc): a
 * variable-length "Extra"-encoded byte count, followed by that many
 * content bytes. Confirmed against `examples/Willkommen zum Serie 5`: the
 * computed content window starts with two Object Placeholder bytes (the
 * document's header images) and ends on a clean sentence boundary exactly
 * at the computed length, well short of the next section.
 */
function readExtraEncodedLength(data: Uint8Array, offset: number): { length: number; headerBytes: number } {
  const first = data[offset];
  if (first === undefined) {
    throw new RangeError(`truncated Word file: expected an Extra-encoded length at offset ${offset}`);
  }
  if ((first & 0x01) === 0x00) {
    return { length: first >> 1, headerBytes: 1 };
  }
  if ((first & 0x03) === 0x01) {
    if (offset + 2 > data.length) {
      throw new RangeError('truncated Word file: 2-byte Extra-encoded length runs past the end');
    }
    const value = data[offset]! | (data[offset + 1]! << 8);
    return { length: (value - 1) / 4, headerBytes: 2 };
  }
  if ((first & 0x07) === 0x03) {
    if (offset + 4 > data.length) {
      throw new RangeError('truncated Word file: 4-byte Extra-encoded length runs past the end');
    }
    const value = (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0;
    return { length: (value - 3) / 8, headerBytes: 4 };
  }
  throw new Error(`unrecognized Extra-encoded length indicator: ${hex32(first)}`);
}

const windows1252Decoder = new TextDecoder('windows-1252');

/**
 * Psion's control-code table for Word's Text Section (psiconv's ASCII_Codes
 * doc — "IBM code page 1252" with some codes below 0x20 given special
 * meaning). `0x0E` (Object Placeholder) is where an embedded picture/object
 * would be referenced; dropped here rather than represented, per this
 * conversion being text-only (no images/embedded content). `0x0D` is
 * documented as "Unknown... Not displayed" — dropped rather than guessed at.
 */
function decodeParagraph(bytes: Uint8Array): string {
  let out = '';
  let runStart = -1;
  const flushRun = (end: number): void => {
    if (runStart !== -1) {
      out += windows1252Decoder.decode(bytes.subarray(runStart, end));
      runStart = -1;
    }
  };

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    switch (b) {
      case 0x07: // New Line
        flushRun(i);
        out += '\n';
        break;
      case 0x08: // Hard Page
        flushRun(i);
        out += '\n\n---\n\n';
        break;
      case 0x09: // Tab
      case 0x0a: // Unbreakable tab
        flushRun(i);
        out += '\t';
        break;
      case 0x0b: // Hard hyphen
      case 0x0c: // Potential hyphen
        flushRun(i);
        out += '-';
        break;
      case 0x0d: // "Unknown... Not displayed"
      case 0x0e: // Object Placeholder — dropped: text-only conversion
        flushRun(i);
        break;
      case 0x0f: // Visible space
      case 0x10: // Hard space
        flushRun(i);
        out += ' ';
        break;
      default:
        if (b < 0x20) {
          // Unrecognized control byte: drop rather than emit a stray raw byte.
          flushRun(i);
        } else if (runStart === -1) {
          runStart = i;
        }
    }
  }
  flushRun(bytes.length);
  return out;
}

/** Decodes a Psion Word file's text into paragraphs (New Paragraph, `0x06`, is the separator). Text only — no formatting/style-layer parsing yet, see SPECSv3.md §4. */
export function decodeWordParagraphs(data: Uint8Array): string[] {
  const header = parseEpocDocHeader(data);
  const section = findTextSection(header);
  const { length, headerBytes } = readExtraEncodedLength(data, section);
  const contentStart = section + headerBytes;
  if (contentStart + length > data.length) {
    throw new RangeError('truncated Word file: Text Section content runs past the end');
  }
  const content = data.subarray(contentStart, contentStart + length);

  const paragraphs: string[] = [];
  let paragraphStart = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === 0x06) {
      paragraphs.push(decodeParagraph(content.subarray(paragraphStart, i)));
      paragraphStart = i + 1;
    }
  }
  if (paragraphStart < content.length) {
    paragraphs.push(decodeParagraph(content.subarray(paragraphStart)));
  }
  return paragraphs;
}

/** Converts a Psion Word file's bytes to Markdown text. Empty paragraphs (typically what's left of a dropped Object Placeholder) are omitted. */
export function wordToMarkdown(data: Uint8Array): string {
  return decodeWordParagraphs(data)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join('\n\n');
}

/**
 * Windows-1252 has no built-in JS encoder (only `TextDecoder` supports
 * legacy single-byte encodings; `TextEncoder` is UTF-8 only). Built by
 * decoding every possible byte once and inverting the result, rather than
 * transcribing the code page by hand — correct by construction, using the
 * exact same platform decoder `decodeParagraph` above already relies on.
 */
const windows1252EncodeMap = buildWindows1252EncodeMap();

function buildWindows1252EncodeMap(): Map<string, number> {
  const decoder = new TextDecoder('windows-1252');
  const map = new Map<string, number>();
  for (let byte = 0; byte < 256; byte++) {
    const char = decoder.decode(Uint8Array.of(byte));
    if (!map.has(char)) {
      map.set(char, byte);
    }
  }
  return map;
}

/**
 * Stands in for any character with no Windows-1252 representation (e.g.
 * "→", smart quotes/dashes the source didn't already use the CP1252 form
 * of, emoji). `~` (0x7E) rather than, say, `?`: valid, printable, and
 * rare enough in ordinary prose that it reads as "something got
 * substituted here" rather than blending in.
 */
const FALLBACK_CHAR = '~';

/**
 * Inverse of `decodeParagraph`'s printable-character handling: `\n` ->
 * New Line (0x07), `\t` -> Tab (0x09), everything else via Windows-1252.
 * Unmappable characters are substituted with `FALLBACK_CHAR` rather than
 * rejected outright — the goal here is getting most of a document onto
 * the device with minimal friction, not a lossless/perfect
 * transcription; every substitution is recorded into `substituted` so
 * the caller can still tell the user it happened.
 */
function encodeParagraph(text: string, substituted: Set<string>): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    if (char === '\n') {
      bytes.push(0x07);
      continue;
    }
    if (char === '\t') {
      bytes.push(0x09);
      continue;
    }
    let byte = windows1252EncodeMap.get(char);
    if (byte === undefined) {
      substituted.add(char);
      byte = windows1252EncodeMap.get(FALLBACK_CHAR)!;
    }
    bytes.push(byte);
  }
  return Uint8Array.from(bytes);
}

/** Inverse of `readExtraEncodedLength` — psiconv's Basic_Elements "Extra" length-indicator scheme. */
function encodeExtraLength(length: number): Uint8Array {
  if (length <= 0x7f) {
    return Uint8Array.of(length * 2);
  }
  if (length <= 0x3fff) {
    const value = 4 * length + 1;
    return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
  }
  const value = 8 * length + 3;
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

/**
 * The Word Status Section's one field that can't just be copied verbatim
 * from a template: offset 0x06 (4 bytes, LE) is the saved cursor
 * position, "counted from the start of the Text Section" (psiconv's
 * Word_Status_Section doc — fetched directly, not inferred: this project
 * first shipped a version that copied this field unpatched, which opened
 * far enough to hit a *different*, more specific crash — a "FORM" panic —
 * than the wrong-Word-Styles-Section version above, consistent with a
 * cursor offset that pointed at a valid byte count but an invalid
 * position once the Text Section's actual content changed underneath
 * it). Resetting it to 0 (start of document) is always in-bounds
 * regardless of what text follows, at the minor cost of the document not
 * opening with the cursor wherever the template's author last left it.
 */
function patchWordStatusCursorOffset(wordStatus: Uint8Array): Uint8Array {
  const patched = new Uint8Array(wordStatus);
  const view = new DataView(patched.buffer);
  view.setUint32(0x06, 0, true);
  return patched;
}

function buildTextSectionBytes(paragraphs: readonly string[], substituted: Set<string>): Uint8Array {
  const encodedParagraphs = paragraphs.map((p) => encodeParagraph(p, substituted));
  const contentLength = encodedParagraphs.reduce((sum, p) => sum + p.length + 1, 0); // +1 per paragraph for its trailing New Paragraph byte
  const lengthPrefix = encodeExtraLength(contentLength);

  const out = new Uint8Array(lengthPrefix.length + contentLength);
  out.set(lengthPrefix, 0);
  let cursor = lengthPrefix.length;
  for (const paragraph of encodedParagraphs) {
    out.set(paragraph, cursor);
    cursor += paragraph.length;
    out[cursor++] = 0x06; // New Paragraph
  }
  return out;
}

/**
 * Builds a new Word file containing `paragraphs` as plain text — no
 * formatting yet (no styles/headings/bold; see SPECSv3.md §4's deferred
 * "phase two"). Rather than reverse-engineering the Word Styles and Page
 * Layout sections' internal fields (real work, not yet done — see
 * `epoc-doc.ts`'s `sectionBytes` doc comment), this copies them verbatim
 * from `template` — a real, valid Word file — and only replaces the Text
 * Section. The Word Status Section is *mostly* copied verbatim too, with
 * one exception (see `patchWordStatusCursorOffset` below). The Text
 * Layout Section is deliberately dropped rather than copied: it's
 * optional (psiconv: absent means "Normal" style throughout), which is
 * exactly what a no-formatting document wants anyway. UID1-3 (and
 * therefore UID4, their checksum) are also copied verbatim from
 * `template` since they never change.
 *
 * `template` matters more than it might look: an early version of this
 * tried reusing Psion's own pre-installed "Willkommen" document and
 * produced a file the on-device Word app couldn't open (KERN-EXEC
 * crash). Comparing it against a document created fresh directly on a
 * Series 5 showed why — the pre-installed doc's Word Styles Section was
 * a mere 65 bytes, versus 354 bytes (real font/heading-style tables) in
 * the freshly-created one. Use a template Word file that was actually
 * created by the on-device Word app, not an old pre-installed document.
 *
 * `substituted`, if passed, collects every distinct character that had
 * no Windows-1252 representation and got replaced with `~` (see
 * `encodeParagraph`) — pass a `Set` to find out afterwards whether that
 * happened, or omit it if you don't care.
 */
export function textToWord(paragraphs: readonly string[], template: Uint8Array, substituted: Set<string> = new Set()): Uint8Array {
  const header = parseEpocDocHeader(template);
  if (header.uid3 !== WORD_APP_UID3) {
    throw new Error(`template is not a Word file (UID3 is ${hex32(header.uid3)}, expected ${hex32(WORD_APP_UID3)})`);
  }

  const sections = [
    { id: WORD_STATUS_SECTION_ID, data: patchWordStatusCursorOffset(sectionBytes(header, template, WORD_STATUS_SECTION_ID)) },
    { id: WORD_STYLES_SECTION_ID, data: sectionBytes(header, template, WORD_STYLES_SECTION_ID) },
    { id: PAGE_LAYOUT_SECTION_ID, data: sectionBytes(header, template, PAGE_LAYOUT_SECTION_ID) },
    { id: TEXT_SECTION_ID, data: buildTextSectionBytes(paragraphs, substituted) },
    { id: APPLICATION_ID_SECTION_ID, data: sectionBytes(header, template, APPLICATION_ID_SECTION_ID) },
  ];

  // Section bodies come right after the 20-byte header; the Section Table
  // Section itself goes *after* all of them, at the very end of the file.
  // Both real files this was checked against (a Series 5 Word file and one
  // freshly created directly on-device) lay it out this way — not "right
  // after the header," which is what an earlier version of this function
  // assumed. That assumption round-tripped fine through this project's own
  // reader (which just follows the offset 0x10 pointer wherever it points)
  // but deviated from what real EPOC Word files actually look like.
  const HEADER_SIZE = 0x14;
  const offsets: number[] = [];
  let cursor = HEADER_SIZE;
  for (const section of sections) {
    offsets.push(cursor);
    cursor += section.data.length;
  }
  const sectionTableOffset = cursor;
  const sectionTableSize = 1 + sections.length * 8; // 1-byte count + (id, offset) Long pairs
  const totalSize = sectionTableOffset + sectionTableSize;

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  out.set(template.subarray(0, 0x10), 0); // UID1, UID2, UID3, UID4 — verbatim, unchanged
  view.setUint32(0x10, sectionTableOffset, true);

  for (let i = 0; i < sections.length; i++) {
    out.set(sections[i]!.data, offsets[i]!);
  }

  out[sectionTableOffset] = sections.length * 2; // BListL: count is in 4-byte Longs, 2 per (id, offset) pair
  let tableCursor = sectionTableOffset + 1;
  for (let i = 0; i < sections.length; i++) {
    view.setUint32(tableCursor, sections[i]!.id, true);
    view.setUint32(tableCursor + 4, offsets[i]!, true);
    tableCursor += 8;
  }

  return out;
}

/**
 * Splits plain text into paragraphs the way this project's generated
 * documents do: one paragraph per line, including blank lines (the
 * on-device Word app represents a blank line as a literal empty
 * paragraph — confirmed by decoding a real device-authored file), with
 * trailing blank lines dropped.
 */
function splitPlainTextParagraphs(text: string): string[] {
  const lines = text.split('\n').map((line) => line.trim());
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/**
 * Converts plain text straight to a new Word file's bytes, using
 * `template`'s Word Status/Styles/Page Layout/Application ID sections
 * (see `textToWord`). `substituted` behaves the same as `textToWord`'s.
 */
export function plainTextToWord(text: string, template: Uint8Array, substituted: Set<string> = new Set()): Uint8Array {
  return textToWord(splitPlainTextParagraphs(text), template, substituted);
}
