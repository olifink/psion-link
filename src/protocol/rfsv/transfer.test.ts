import { describe, expect, test } from 'bun:test';
import { NcpChannel } from '../ncp';
import { EpocStatus, RfsvReason } from './constants';
import { RfsvClient } from './client';
import { downloadFile, uploadFile } from './transfer';

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function encodeReply(opId: number, status: EpocStatus, data: number[] = []): Uint8Array {
  return Uint8Array.from([0x11, 0x00, opId & 0xff, (opId >> 8) & 0xff, ...u32le(status), ...data]);
}

class FakeNcpChannel implements NcpChannel {
  readonly localChannel = 1;
  readonly remoteChannel = 7;
  readonly sent: Uint8Array[] = [];
  private listeners = new Set<(payload: Uint8Array) => void>();

  send(payload: Uint8Array): void {
    this.sent.push(payload);
  }

  onData(listener: (payload: Uint8Array) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {}

  /** Test helper: deliver a reply as if it arrived from the device. */
  deliver(payload: Uint8Array): void {
    for (const listener of this.listeners) listener(payload);
  }

  lastOpId(): number {
    const last = this.sent[this.sent.length - 1]!;
    return last[2]! | (last[3]! << 8);
  }

  lastReason(): number {
    const last = this.sent[this.sent.length - 1]!;
    return last[0]! | (last[1]! << 8);
  }
}

/** Lets the pending request's promise continuation register before we inspect `channel.sent`. */
async function tick(): Promise<void> {
  await Bun.sleep(0);
}

describe('downloadFile', () => {
  test('a file smaller than one chunk completes after a single short read', async () => {
    const channel = new FakeNcpChannel();
    const client = new RfsvClient(channel);
    const progress: { bytesTransferred: number; totalBytes: number }[] = [];

    const pending = downloadFile(client, 'C:\\FOO.TXT', 5, {
      chunkSize: 2048,
      onProgress: (p) => progress.push(p),
    });

    await tick();
    expect(channel.lastReason()).toBe(RfsvReason.OpenFile);
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None, [7, 0, 0, 0])); // handle 7

    await tick();
    expect(channel.lastReason()).toBe(RfsvReason.ReadFile);
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None, [1, 2, 3, 4, 5]));

    await tick();
    expect(channel.lastReason()).toBe(RfsvReason.CloseHandle);
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None));

    const data = await pending;
    expect(Array.from(data)).toEqual([1, 2, 3, 4, 5]);
    expect(progress.at(-1)).toEqual({ bytesTransferred: 5, totalBytes: 5 });
  });

  test('a file exactly one chunk long needs a trailing empty read to confirm EOF', async () => {
    const channel = new FakeNcpChannel();
    const client = new RfsvClient(channel);
    const chunk = [1, 2];

    const pending = downloadFile(client, 'C:\\FOO.TXT', 2, { chunkSize: 2 });

    await tick();
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None, [9, 0, 0, 0])); // handle 9

    await tick();
    expect(channel.lastReason()).toBe(RfsvReason.ReadFile);
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None, chunk));

    await tick();
    expect(channel.lastReason()).toBe(RfsvReason.ReadFile); // trailing read confirms EOF
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None, []));

    await tick();
    expect(channel.lastReason()).toBe(RfsvReason.CloseHandle);
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None));

    const data = await pending;
    expect(Array.from(data)).toEqual(chunk);
  });

  test('closes the handle even when a read fails partway through', async () => {
    const channel = new FakeNcpChannel();
    const client = new RfsvClient(channel);

    const pending = downloadFile(client, 'C:\\FOO.TXT', 100);
    pending.catch(() => {});

    await tick();
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None, [1, 0, 0, 0])); // handle 1

    await tick();
    expect(channel.lastReason()).toBe(RfsvReason.ReadFile);
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.Corrupt));

    await tick();
    expect(channel.lastReason()).toBe(RfsvReason.CloseHandle);
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None));

    await expect(pending).rejects.toThrow();
  });
});

describe('uploadFile', () => {
  test('splits data into chunkSize pieces, writes them in order, and closes the handle', async () => {
    const channel = new FakeNcpChannel();
    const client = new RfsvClient(channel);
    const progress: { bytesTransferred: number; totalBytes: number }[] = [];
    const data = Uint8Array.from([1, 2, 3, 4, 5]);

    const pending = uploadFile(client, 'C:\\FOO.TXT', data, {
      chunkSize: 2,
      onProgress: (p) => progress.push(p),
    });

    await tick();
    expect(channel.lastReason()).toBe(RfsvReason.CreateFile);
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None, [3, 0, 0, 0])); // handle 3

    for (const expectedChunkLength of [2, 2, 1]) {
      await tick();
      expect(channel.lastReason()).toBe(RfsvReason.WriteFile);
      const sent = channel.sent[channel.sent.length - 1]!;
      // command bytes: [reason:2][opId:2][handle:4][data...]
      expect(sent.length - 8).toBe(expectedChunkLength);
      channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None));
    }

    await tick();
    expect(channel.lastReason()).toBe(RfsvReason.CloseHandle);
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None));

    await pending;
    expect(progress.at(-1)).toEqual({ bytesTransferred: 5, totalBytes: 5 });
  });

  test('an empty file still opens, closes, and resolves without writing', async () => {
    const channel = new FakeNcpChannel();
    const client = new RfsvClient(channel);

    const pending = uploadFile(client, 'C:\\EMPTY.TXT', new Uint8Array(0));

    await tick();
    expect(channel.lastReason()).toBe(RfsvReason.CreateFile);
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None, [4, 0, 0, 0]));

    await tick();
    expect(channel.lastReason()).toBe(RfsvReason.CloseHandle);
    channel.deliver(encodeReply(channel.lastOpId(), EpocStatus.None));

    await pending;
  });
});
