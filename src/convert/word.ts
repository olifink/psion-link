import { EpocDocHeader, hex32, parseEpocDocHeader } from './epoc-doc';

/** Psion's built-in "Word" app's UID3 — matches `KNOWN_APP_UIDS['Word']` in file-browser.ts, sourced from real hardware. */
const WORD_APP_UID3 = 0x1000007f;

/** The Text Section's identifier within the Section Table (psiconv: `06 01 00 10`), confirmed against a real Word file. */
const TEXT_SECTION_ID = 0x10000106;

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
