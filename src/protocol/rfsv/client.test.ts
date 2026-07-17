import { describe, expect, test } from 'bun:test';
import { NcpChannel } from '../ncp';
import { BatteryStatus, EpocStatus, FileAttribute, MediaType, OpenShareMode, OpenStreamType, RfsvReason } from './constants';
import { RfsvClient, RfsvError } from './client';

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function encodeReply(opId: number, status: EpocStatus, data: number[] = []): Uint8Array {
  return Uint8Array.from([0x11, 0x00, ...u32le(opId).slice(0, 2), ...u32le(status), ...data]);
}

function encodeString(value: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(value));
  return [bytes.length & 0xff, (bytes.length >> 8) & 0xff, ...bytes];
}

class FakeNcpChannel implements NcpChannel {
  readonly localChannel = 1;
  readonly remoteChannel = 7;
  readonly sent: Uint8Array[] = [];
  private listeners = new Set<(payload: Uint8Array) => void>();
  closed = false;

  send(payload: Uint8Array): void {
    this.sent.push(payload);
  }

  onData(listener: (payload: Uint8Array) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  /** Test helper: deliver a reply as if it arrived from the device. */
  deliver(payload: Uint8Array): void {
    for (const listener of this.listeners) {
      listener(payload);
    }
  }

  /** Decodes the last sent command's opId, for building a matching reply. */
  lastOpId(): number {
    const last = this.sent[this.sent.length - 1]!;
    return last[2]! | (last[3]! << 8);
  }
}

function createHarness() {
  const channel = new FakeNcpChannel();
  const client = new RfsvClient(channel);
  return { channel, client };
}

describe('RfsvClient.getDriveList', () => {
  test('sends GET_DRIVE_LIST and parses the 26-byte presence bitmap', async () => {
    const { channel, client } = createHarness();
    const pending = client.getDriveList();

    const opId = channel.lastOpId();
    const driveBytes = new Array(26).fill(0);
    driveBytes[2] = 1; // C:
    driveBytes[25] = 1; // Z:
    channel.deliver(encodeReply(opId, EpocStatus.None, driveBytes));

    const drives = await pending;
    expect(drives).toHaveLength(26);
    expect(drives[0]).toEqual({ letter: 'A:', present: false });
    expect(drives[2]).toEqual({ letter: 'C:', present: true });
    expect(drives[25]).toEqual({ letter: 'Z:', present: true });

    const sentCommand = decodeRfsvCommandHeader(channel.sent[0]!);
    expect(sentCommand.reason).toBe(RfsvReason.GetDriveList);
  });
});

function decodeRfsvCommandHeader(bytes: Uint8Array): { reason: number; opId: number } {
  return { reason: bytes[0]! | (bytes[1]! << 8), opId: bytes[2]! | (bytes[3]! << 8) };
}

describe('RfsvClient.volume', () => {
  test('sends the drive number and parses the reply', async () => {
    const { channel, client } = createHarness();
    const pending = client.volume(2); // C:

    expect(decodeRfsvCommandHeader(channel.sent[0]!).reason).toBe(RfsvReason.Volume);
    expect(Array.from(channel.sent[0]!.subarray(4))).toEqual(u32le(2));

    const opId = channel.lastOpId();
    channel.deliver(
      encodeReply(opId, EpocStatus.None, [
        ...u32le(MediaType.Ram),
        ...u32le(BatteryStatus.Good),
        ...u32le(0),
        ...u32le(0),
        ...u32le(0),
        ...u32le(1000),
        ...u32le(0),
        ...u32le(500),
        ...u32le(0),
        ...u32le(0), // empty label
      ]),
    );

    const info = await pending;
    expect(info.mediaType).toBe(MediaType.Ram);
    expect(info.sizeBytes).toBe(1000n);
    expect(info.freeBytes).toBe(500n);
  });
});

describe('RfsvClient error handling', () => {
  test('throws RfsvError with the status code on a non-zero reply', async () => {
    const { channel, client } = createHarness();
    const pending = client.deleteFile('C:\\FOO.TXT');
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.AccessDenied));

    await expect(pending).rejects.toThrow(RfsvError);
  });

  test('the thrown RfsvError carries the status code', async () => {
    const { channel, client } = createHarness();
    const pending = client.deleteFile('C:\\BAR.TXT').catch((err) => (err as RfsvError).status);
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.AccessDenied));

    expect(await pending).toBe(EpocStatus.AccessDenied);
  });
});

describe('RfsvClient concurrent requests', () => {
  test('matches out-of-order replies to the correct pending request via opId', async () => {
    const { channel, client } = createHarness();
    const first = client.mkDirAll('C:\\A');
    const second = client.mkDirAll('C:\\B');

    const opIdFirst = channel.sent[0]![2]! | (channel.sent[0]![3]! << 8);
    const opIdSecond = channel.sent[1]![2]! | (channel.sent[1]![3]! << 8);

    // Reply to the second request first.
    channel.deliver(encodeReply(opIdSecond, EpocStatus.None));
    channel.deliver(encodeReply(opIdFirst, EpocStatus.None));

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  test('ignores an unmatched or malformed reply without throwing', () => {
    const { channel } = createHarness();
    expect(() => channel.deliver(encodeReply(9999, EpocStatus.None))).not.toThrow();
    expect(() => channel.deliver(Uint8Array.of(0x01, 0x02))).not.toThrow();
  });
});

describe('RfsvClient.pathTest', () => {
  test('resolves true on success', async () => {
    const { channel, client } = createHarness();
    const pending = client.pathTest('C:\\EXISTS.TXT');
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None));
    expect(await pending).toBe(true);
  });

  test('resolves false when the path is not found', async () => {
    const { channel, client } = createHarness();
    const pending = client.pathTest('C:\\MISSING.TXT');
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.NotFound));
    expect(await pending).toBe(false);
  });

  test('resolves false when an intermediate path component is missing', async () => {
    const { channel, client } = createHarness();
    const pending = client.pathTest('C:\\NOPE\\FILE.TXT');
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.PathNotFound));
    expect(await pending).toBe(false);
  });

  test('rethrows other errors rather than treating them as "not found"', async () => {
    const { channel, client } = createHarness();
    const pending = client.pathTest('C:\\FILE.TXT');
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.CommsLineFail));
    await expect(pending).rejects.toThrow(RfsvError);
  });
});

describe('RfsvClient file operations', () => {
  test('openFile sends Mode + name and returns the handle', async () => {
    const { channel, client } = createHarness();
    const pending = client.openFile('C:\\DATA.TXT', OpenShareMode.ShareRead | OpenStreamType.Binary);

    expect(decodeRfsvCommandHeader(channel.sent[0]!).reason).toBe(RfsvReason.OpenFile);
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None, u32le(0x2a)));

    expect(await pending).toBe(0x2a);
  });

  test('readFile sends handle+length and returns the raw bytes', async () => {
    const { channel, client } = createHarness();
    const pending = client.readFile(5, 3);

    expect(Array.from(channel.sent[0]!.subarray(4))).toEqual([...u32le(5), ...u32le(3)]);
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None, [0x01, 0x02, 0x03]));

    expect(Array.from(await pending)).toEqual([0x01, 0x02, 0x03]);
  });

  test('writeFile sends handle+data with no explicit length field', async () => {
    const { channel, client } = createHarness();
    const pending = client.writeFile(5, Uint8Array.of(0xaa, 0xbb));

    expect(Array.from(channel.sent[0]!.subarray(4))).toEqual([...u32le(5), 0xaa, 0xbb]);
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None));

    await expect(pending).resolves.toBeUndefined();
  });

  test('closeHandle sends the handle', async () => {
    const { channel, client } = createHarness();
    const pending = client.closeHandle(9);
    expect(Array.from(channel.sent[0]!.subarray(4))).toEqual(u32le(9));
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None));
    await expect(pending).resolves.toBeUndefined();
  });

  test('rename sends both names', async () => {
    const { channel, client } = createHarness();
    const pending = client.rename('C:\\OLD.TXT', 'C:\\NEW.TXT');
    const expectedData = [...encodeString('C:\\OLD.TXT'), ...encodeString('C:\\NEW.TXT')];
    expect(Array.from(channel.sent[0]!.subarray(4))).toEqual(expectedData);
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None));
    await expect(pending).resolves.toBeUndefined();
  });
});

describe('RfsvClient directory listing', () => {
  test('openDir requests UID info by default and returns a handle wrapper', async () => {
    const { channel, client } = createHarness();
    const pending = client.openDir('C:\\*.*');

    expect(decodeRfsvCommandHeader(channel.sent[0]!).reason).toBe(RfsvReason.OpenDir);
    const attrBytes = channel.sent[0]!.subarray(4, 8);
    const attr = attrBytes[0]! | (attrBytes[1]! << 8) | (attrBytes[2]! << 16) | (attrBytes[3]! << 24);
    expect(attr & 0x10000000).not.toBe(0); // ATTR_GET_UID

    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None, u32le(0x77)));
    const handle = await pending;
    expect(handle.handle).toBe(0x77);
  });

  test('listDir opens, drains all batched entries across multiple READ_DIR calls, then closes', async () => {
    const { channel, client } = createHarness();
    const pending = client.listDir('C:\\*.*');

    // OPEN_DIR
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None, u32le(1)));

    // First READ_DIR: one batched entry.
    await Bun.sleep(0);
    expect(decodeRfsvCommandHeader(channel.sent[1]!).reason).toBe(RfsvReason.ReadDir);
    const entryOne = buildDirEntryBytes('ONE.TXT', FileAttribute.Normal);
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None, entryOne));

    // Second READ_DIR: EOF.
    await Bun.sleep(0);
    expect(decodeRfsvCommandHeader(channel.sent[2]!).reason).toBe(RfsvReason.ReadDir);
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.Eof));

    // CLOSE_HANDLE.
    await Bun.sleep(0);
    expect(decodeRfsvCommandHeader(channel.sent[3]!).reason).toBe(RfsvReason.CloseHandle);
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None));

    const entries = await pending;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('ONE.TXT');
  });

  test('a non-EOF error status from READ_DIR propagates as RfsvError', async () => {
    const { channel, client } = createHarness();
    const openPending = client.openDir('C:\\*.*');
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None, u32le(1)));
    const dir = await openPending;

    const nextPending = dir.next();
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.AccessDenied));
    await expect(nextPending).rejects.toThrow(RfsvError);
  });
});

function buildDirEntryBytes(name: string, attributes: number): number[] {
  const nameBytes = Array.from(new TextEncoder().encode(name));
  let bytes = [
    ...u32le(0), // short name length
    ...u32le(attributes),
    ...u32le(0), // size
    ...u32le(0), // modified low
    ...u32le(0), // modified high
    ...u32le(0), // uid1
    ...u32le(0), // uid2
    ...u32le(0), // uid3
    ...u32le(nameBytes.length),
    ...nameBytes,
  ];
  while (bytes.length % 4 !== 0) bytes.push(0);
  return bytes;
}
