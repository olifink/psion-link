import { describe, expect, test } from 'bun:test';
import { FileAttribute } from './constants';
import { epocTimeToDate } from './time';
import { parseReadDirEntries } from './readdir';

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

const windows1252Decoder = new TextDecoder('windows-1252');
const windows1252EncodeMap: Map<string, number> = (() => {
  const map = new Map<string, number>();
  for (let byte = 0; byte < 256; byte++) {
    map.set(windows1252Decoder.decode(Uint8Array.of(byte)), byte);
  }
  return map;
})();

function encodeWindows1252(value: string): number[] {
  return Array.from(value, (ch) => {
    const byte = windows1252EncodeMap.get(ch);
    if (byte === undefined) {
      throw new Error(`test fixture used a non-cp1252 character: ${JSON.stringify(ch)}`);
    }
    return byte;
  });
}

function alignTo4(bytes: number[]): number[] {
  while (bytes.length % 4 !== 0) {
    bytes.push(0);
  }
  return bytes;
}

interface EntryFixture {
  shortName?: string;
  attributes: number;
  size: number;
  modifiedLow: number;
  modifiedHigh: number;
  uid1?: number;
  uid2?: number;
  uid3?: number;
  longName: string;
}

/** Builds one raw RFSV32_READ_DIR entry per the field layout parseReadDirEntries expects. */
function buildEntry(fixture: EntryFixture): number[] {
  const longNameBytes = encodeWindows1252(fixture.longName);
  const shortNameBytes = fixture.shortName ? encodeWindows1252(fixture.shortName) : [];

  let bytes: number[] = [
    ...u32le(shortNameBytes.length),
    ...u32le(fixture.attributes),
    ...u32le(fixture.size),
    ...u32le(fixture.modifiedLow),
    ...u32le(fixture.modifiedHigh),
    ...u32le(fixture.uid1 ?? 0),
    ...u32le(fixture.uid2 ?? 0),
    ...u32le(fixture.uid3 ?? 0),
    ...u32le(longNameBytes.length),
    ...longNameBytes,
  ];
  bytes = alignTo4(bytes);
  bytes = [...bytes, ...shortNameBytes];
  bytes = alignTo4(bytes);
  return bytes;
}

describe('parseReadDirEntries', () => {
  test('parses a single entry with no short name (name lengths align exactly to 4)', () => {
    const buffer = Uint8Array.from(
      buildEntry({
        attributes: FileAttribute.Normal,
        size: 1234,
        modifiedLow: 0,
        modifiedHigh: 0,
        longName: 'ABCD', // 4 bytes: no padding needed after LongName
      }),
    );

    const { entries, remainder } = parseReadDirEntries(buffer);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'ABCD', shortName: undefined, sizeBytes: 1234, isDirectory: false });
    expect(remainder).toHaveLength(0);
  });

  test('applies alignment padding after an odd-length long name before the short name', () => {
    const buffer = Uint8Array.from(
      buildEntry({
        attributes: FileAttribute.Archive,
        size: 42,
        modifiedLow: 0,
        modifiedHigh: 0,
        longName: 'ODD', // 3 bytes -> 1 byte of padding before ShortName
        shortName: 'ODD~1',
      }),
    );

    const { entries, remainder } = parseReadDirEntries(buffer);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('ODD');
    expect(entries[0]!.shortName).toBe('ODD~1');
    expect(remainder).toHaveLength(0);
  });

  test('marks directory entries via the Directory attribute bit', () => {
    const buffer = Uint8Array.from(
      buildEntry({
        attributes: FileAttribute.Directory,
        size: 0,
        modifiedLow: 0,
        modifiedHigh: 0,
        longName: 'DOCS',
      }),
    );

    expect(parseReadDirEntries(buffer).entries[0]!.isDirectory).toBe(true);
  });

  test('decodes the 64-bit modified timestamp via epocTimeToDate', () => {
    const date = new Date('2020-01-01T00:00:00.000Z');
    const micros = 0x00dcddb30f2f8000n + BigInt(date.getTime()) * 1000n;
    const modifiedLow = Number(micros & 0xffffffffn);
    const modifiedHigh = Number((micros >> 32n) & 0xffffffffn);

    const buffer = Uint8Array.from(
      buildEntry({ attributes: 0, size: 0, modifiedLow, modifiedHigh, longName: 'F' }),
    );

    const entry = parseReadDirEntries(buffer).entries[0]!;
    expect(entry.modified.getTime()).toBe(epocTimeToDate(modifiedLow, modifiedHigh).getTime());
    expect(entry.modified.getTime()).toBe(date.getTime());
  });

  test('includes uid only when at least one UID field is nonzero', () => {
    const withUid = Uint8Array.from(
      buildEntry({ attributes: 0, size: 0, modifiedLow: 0, modifiedHigh: 0, longName: 'A', uid1: 0x10000037, uid2: 0x1000006d, uid3: 0x1000007f }),
    );
    const withoutUid = Uint8Array.from(buildEntry({ attributes: 0, size: 0, modifiedLow: 0, modifiedHigh: 0, longName: 'A' }));

    expect(parseReadDirEntries(withUid).entries[0]!.uid).toEqual([0x10000037, 0x1000006d, 0x1000007f]);
    expect(parseReadDirEntries(withoutUid).entries[0]!.uid).toBeUndefined();
  });

  test('parses multiple batched entries from a single reply', () => {
    const first = buildEntry({ attributes: FileAttribute.Normal, size: 10, modifiedLow: 0, modifiedHigh: 0, longName: 'ONE.TXT' });
    const second = buildEntry({ attributes: FileAttribute.Directory, size: 0, modifiedLow: 0, modifiedHigh: 0, longName: 'TWODIR' });
    const buffer = Uint8Array.from([...first, ...second]);

    const { entries, remainder } = parseReadDirEntries(buffer);

    expect(entries).toHaveLength(2);
    expect(entries[0]!.name).toBe('ONE.TXT');
    expect(entries[1]!.name).toBe('TWODIR');
    expect(entries[1]!.isDirectory).toBe(true);
    expect(remainder).toHaveLength(0);
  });

  test('decodes long/short names as Windows-1252', () => {
    const buffer = Uint8Array.from(
      buildEntry({ attributes: 0, size: 0, modifiedLow: 0, modifiedHigh: 0, longName: 'café' }),
    );
    expect(parseReadDirEntries(buffer).entries[0]!.name).toBe('café');
  });

  test('leaves an incomplete trailing entry in the remainder rather than throwing', () => {
    const whole = buildEntry({ attributes: 0, size: 0, modifiedLow: 0, modifiedHigh: 0, longName: 'X' });
    const truncated = whole.slice(0, whole.length - 2); // chop off part of the last field
    const buffer = Uint8Array.from(truncated);

    const { entries, remainder } = parseReadDirEntries(buffer);

    expect(entries).toHaveLength(0);
    expect(remainder.length).toBe(buffer.length);
  });

  test('an empty buffer yields no entries and an empty remainder', () => {
    const { entries, remainder } = parseReadDirEntries(new Uint8Array(0));
    expect(entries).toHaveLength(0);
    expect(remainder).toHaveLength(0);
  });
});
