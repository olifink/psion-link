import { NcpChannel } from '../ncp';
import { ATTR_GET_UID, EpocStatus, FileAttribute, RfsvReason } from './constants';
import { decodeRfsvReply, encodeRfsvCommand, rfsvBytes } from './frame';
import { RfsvDirEntry, parseReadDirEntries } from './readdir';
import { encodeEpocString } from './strings';
import { VolumeInfo, parseVolumeReply } from './volume';

export class RfsvError extends Error {
  constructor(readonly status: EpocStatus) {
    super(`RFSV error: status ${status} (${EpocStatus[status] ?? 'unknown'})`);
    this.name = 'RfsvError';
  }
}

interface RawReply {
  status: EpocStatus;
  data: Uint8Array;
}

interface PendingRequest {
  resolve: (reply: RawReply) => void;
  reject: (err: Error) => void;
}

export interface DriveListEntry {
  letter: string;
  present: boolean;
}

/**
 * RFSV32 file-service client: generates per-request operation IDs, matches
 * replies delivered via the channel's `onData`, and implements BRIEF.md
 * §4.4's MVP command set. Wraps an `NcpChannel` already connected to
 * SYS$RFSV (see `PlpConnection`) — has no transport/link/session concerns
 * of its own.
 */
export class RfsvClient {
  private opId = 0;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly channel: NcpChannel) {
    channel.onData((payload) => this.handleReply(payload));
  }

  async getDriveList(): Promise<DriveListEntry[]> {
    const data = await this.call(RfsvReason.GetDriveList);
    const drives: DriveListEntry[] = [];
    for (let i = 0; i < 26; i++) {
      drives.push({ letter: `${String.fromCharCode(65 + i)}:`, present: data[i] !== 0 });
    }
    return drives;
  }

  async volume(drive: number): Promise<VolumeInfo> {
    const data = await this.call(RfsvReason.Volume, rfsvBytes.encodeU32le(drive));
    return parseVolumeReply(data);
  }

  /**
   * `RFSV32_OPEN_DIR`'s attribute DWORD is a filter mask, not merely a
   * "fetch UIDs too" flag: an entry is only returned if it matches one of
   * the requested `FileAttribute` categories. plptools' own `dir()`
   * (`RFSV32::dir`, lib/rfsv32.cc) always requests
   * `PSI_A_HIDDEN | PSI_A_SYSTEM | PSI_A_DIR` — without the `Directory`
   * bit, the device silently omits every subdirectory from the listing.
   */
  private static readonly DEFAULT_LIST_ATTRIBUTES = FileAttribute.Hidden | FileAttribute.System | FileAttribute.Directory;

  async openDir(pattern: string, options: { attributes?: number } = {}): Promise<RfsvDirHandle> {
    const attr = (options.attributes ?? RfsvClient.DEFAULT_LIST_ATTRIBUTES) | ATTR_GET_UID;
    const data = rfsvBytes.concatBytes(rfsvBytes.encodeU32le(attr), encodeEpocString(pattern));
    const reply = await this.call(RfsvReason.OpenDir, data);
    return new RfsvDirHandle(this, rfsvBytes.u32le(reply, 0));
  }

  /** Convenience: open, read every entry, close. */
  async listDir(pattern: string, options: { attributes?: number } = {}): Promise<RfsvDirEntry[]> {
    const dir = await this.openDir(pattern, options);
    try {
      return await dir.readAll();
    } finally {
      await dir.close();
    }
  }

  async openFile(name: string, mode: number): Promise<number> {
    const data = rfsvBytes.concatBytes(rfsvBytes.encodeU32le(mode), encodeEpocString(name));
    const reply = await this.call(RfsvReason.OpenFile, data);
    return rfsvBytes.u32le(reply, 0);
  }

  async createFile(name: string, mode: number): Promise<number> {
    const data = rfsvBytes.concatBytes(rfsvBytes.encodeU32le(mode), encodeEpocString(name));
    const reply = await this.call(RfsvReason.CreateFile, data);
    return rfsvBytes.u32le(reply, 0);
  }

  async readFile(handle: number, length: number): Promise<Uint8Array> {
    const data = rfsvBytes.concatBytes(rfsvBytes.encodeU32le(handle), rfsvBytes.encodeU32le(length));
    return this.call(RfsvReason.ReadFile, data);
  }

  async writeFile(handle: number, bytes: Uint8Array): Promise<void> {
    await this.call(RfsvReason.WriteFile, rfsvBytes.concatBytes(rfsvBytes.encodeU32le(handle), bytes));
  }

  async closeHandle(handle: number): Promise<void> {
    await this.call(RfsvReason.CloseHandle, rfsvBytes.encodeU32le(handle));
  }

  async deleteFile(name: string): Promise<void> {
    await this.call(RfsvReason.Delete, encodeEpocString(name));
  }

  async rename(source: string, destination: string): Promise<void> {
    const data = rfsvBytes.concatBytes(encodeEpocString(source), encodeEpocString(destination));
    await this.call(RfsvReason.Rename, data);
  }

  /** `RFSV32_MKDIR_ALL` requires a trailing separator (plptools' `RFSV32::mkdir` enforces this too). */
  async mkDirAll(name: string): Promise<void> {
    const path = name.endsWith('\\') ? name : `${name}\\`;
    await this.call(RfsvReason.MkDirAll, encodeEpocString(path));
  }

  async rmDir(name: string): Promise<void> {
    await this.call(RfsvReason.RmDir, encodeEpocString(name));
  }

  /** Resolves false (rather than throwing) when the path doesn't exist. */
  async pathTest(name: string): Promise<boolean> {
    try {
      await this.call(RfsvReason.PathTest, encodeEpocString(name));
      return true;
    } catch (err) {
      if (err instanceof RfsvError && (err.status === EpocStatus.NotFound || err.status === EpocStatus.PathNotFound)) {
        return false;
      }
      throw err;
    }
  }

  /** @internal used by RfsvDirHandle */
  readDirRaw(handle: number): Promise<RawReply> {
    return this.request(RfsvReason.ReadDir, rfsvBytes.encodeU32le(handle));
  }

  private handleReply(payload: Uint8Array): void {
    let reply;
    try {
      reply = decodeRfsvReply(payload);
    } catch {
      return; // Malformed reply; drop rather than crash the channel.
    }
    const pending = this.pending.get(reply.opId);
    if (!pending) {
      return; // Unmatched (stale/duplicate) reply.
    }
    this.pending.delete(reply.opId);
    pending.resolve({ status: reply.status, data: reply.data });
  }

  private nextOpId(): number {
    const opId = this.opId;
    this.opId = (this.opId + 1) & 0xffff;
    return opId;
  }

  private request(reason: RfsvReason, data?: Uint8Array): Promise<RawReply> {
    const opId = this.nextOpId();
    return new Promise((resolve, reject) => {
      this.pending.set(opId, { resolve, reject });
      try {
        this.channel.send(encodeRfsvCommand(reason, opId, data));
      } catch (err) {
        this.pending.delete(opId);
        reject(err as Error);
      }
    });
  }

  /** Sends a command and throws RfsvError unless the reply status is E_EPOC_NONE. */
  private async call(reason: RfsvReason, data?: Uint8Array): Promise<Uint8Array> {
    const { status, data: replyData } = await this.request(reason, data);
    if (status !== EpocStatus.None) {
      throw new RfsvError(status);
    }
    return replyData;
  }
}

/**
 * A `RFSV32_OPEN_DIR` handle. `RFSV32_READ_DIR` replies are batched
 * (plptools' `RFSV32::readdir`, see `readdir.ts`) — this buffers each
 * reply's entries and only re-requests once they're exhausted.
 */
export class RfsvDirHandle {
  private buffer: Uint8Array = new Uint8Array(0);
  private queue: RfsvDirEntry[] = [];
  private eof = false;

  constructor(
    private readonly client: RfsvClient,
    readonly handle: number,
  ) {}

  /** Returns the next entry, or null once the directory listing is exhausted (E_EPOC_EOF). */
  async next(): Promise<RfsvDirEntry | null> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    if (this.eof) {
      return null;
    }

    const { status, data } = await this.client.readDirRaw(this.handle);
    if (status === EpocStatus.Eof) {
      this.eof = true;
      return null;
    }
    if (status !== EpocStatus.None) {
      throw new RfsvError(status);
    }

    const combined = this.buffer.length > 0 ? rfsvBytes.concatBytes(this.buffer, data) : data;
    const { entries, remainder } = parseReadDirEntries(combined);
    this.buffer = remainder;
    this.queue.push(...entries);
    if (this.queue.length === 0) {
      throw new Error('RFSV32_READ_DIR reply contained no parseable entries');
    }
    return this.queue.shift()!;
  }

  async readAll(): Promise<RfsvDirEntry[]> {
    const entries: RfsvDirEntry[] = [];
    for (let entry = await this.next(); entry !== null; entry = await this.next()) {
      entries.push(entry);
    }
    return entries;
  }

  async close(): Promise<void> {
    await this.client.closeHandle(this.handle);
  }
}
