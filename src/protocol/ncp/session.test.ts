import { describe, expect, test } from 'bun:test';
import { Clock } from '../link/clock';
import { NcpControlFrameType, NcpDataFrameType, NCP_VERSION_EPOC_ER5 } from './constants';
import { decodeNcpFrame } from './frame';
import { fragmentDataPayload } from './fragmentation';
import { NcpChannel, NcpSession } from './session';

class FakeClock implements Clock {
  private currentTime = 0;
  private nextId = 1;
  private timers: Array<{ id: number; time: number; callback: () => void }> = [];

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, time: this.currentTime + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  advance(ms: number): void {
    const target = this.currentTime + ms;
    for (;;) {
      this.timers.sort((a, b) => a.time - b.time);
      const due = this.timers.find((t) => t.time <= target);
      if (!due) break;
      this.currentTime = due.time;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      due.callback();
    }
    this.currentTime = target;
  }
}

function createHarness(overrides: { connectTimeoutMs?: number } = {}) {
  const clock = new FakeClock();
  const sent: Uint8Array[] = [];
  const peerInfos: Array<{ version: number; id: number }> = [];
  const terminations: number[] = [];
  const session = new NcpSession({
    clock,
    send: (f) => sent.push(f),
    ncpId: 0x11223344,
    connectTimeoutMs: overrides.connectTimeoutMs,
    onPeerInfo: (info) => peerInfos.push(info),
    onTerminated: () => terminations.push(1),
  });
  return { clock, sent, peerInfos, terminations, session };
}

function connectResponseFrame(clientChannel: number, serverChannel: number, status = 0): Uint8Array {
  return Uint8Array.of(0x00, serverChannel, NcpControlFrameType.ConnectResponse, clientChannel, status);
}

describe('NcpSession.start', () => {
  test('sends an NCP Information frame with version 0x10 (EPOC ER5)', () => {
    const h = createHarness();
    h.session.start();

    expect(h.sent).toHaveLength(1);
    expect(decodeNcpFrame(h.sent[0]!)).toEqual({ kind: 'ncpInfo', version: NCP_VERSION_EPOC_ER5, id: 0x11223344 });
  });
});

describe('NcpSession.connectToServer', () => {
  test('sends a Connect frame for "<name>.*" on the first allocated channel', () => {
    const h = createHarness();
    void h.session.connectToServer('SYS$RFSV');

    expect(h.sent).toHaveLength(1);
    expect(decodeNcpFrame(h.sent[0]!)).toEqual({ kind: 'connect', clientChannel: 1, serverName: 'SYS$RFSV.*' });
  });

  test('resolves with a channel once a matching Connect Response arrives', async () => {
    const h = createHarness();
    const pending = h.session.connectToServer('SYS$RFSV');

    h.session.receiveFrame(connectResponseFrame(1, 7, 0));

    const channel = await pending;
    expect(channel.localChannel).toBe(1);
    expect(channel.remoteChannel).toBe(7);
  });

  test('rejects on a non-zero status code', async () => {
    const h = createHarness();
    const pending = h.session.connectToServer('SYS$RFSV');

    h.session.receiveFrame(connectResponseFrame(1, 0, 5));

    await expect(pending).rejects.toThrow('status 5');
  });

  test('rejects after the connect timeout elapses with no response', async () => {
    const h = createHarness({ connectTimeoutMs: 1000 });
    const pending = h.session.connectToServer('SYS$RFSV');
    pending.catch(() => {}); // avoid an unhandled-rejection warning in the gap before we assert

    h.clock.advance(1000);

    await expect(pending).rejects.toThrow('timed out');
  });

  test('a late Connect Response after timeout is ignored, not double-resolved', async () => {
    const h = createHarness({ connectTimeoutMs: 1000 });
    const pending = h.session.connectToServer('SYS$RFSV');
    pending.catch(() => {});
    h.clock.advance(1000);
    await expect(pending).rejects.toThrow('timed out');

    // Should not throw or resolve a second time.
    expect(() => h.session.receiveFrame(connectResponseFrame(1, 7, 0))).not.toThrow();
  });

  test('allocates distinct channels for concurrent connects, starting at 1', () => {
    const h = createHarness();
    void h.session.connectToServer('LINK');
    void h.session.connectToServer('SYS$RFSV');

    expect(decodeNcpFrame(h.sent[0]!)).toMatchObject({ clientChannel: 1 });
    expect(decodeNcpFrame(h.sent[1]!)).toMatchObject({ clientChannel: 2 });
  });

  test('rejects a server name that does not fit within the 16-byte field', async () => {
    const h = createHarness();
    await expect(h.session.connectToServer('A'.repeat(20))).rejects.toThrow(RangeError);
  });
});

describe('NcpChannel.send / data reassembly', () => {
  async function connectedChannel(h: ReturnType<typeof createHarness>): Promise<NcpChannel> {
    const pending = h.session.connectToServer('SYS$RFSV');
    h.session.receiveFrame(connectResponseFrame(1, 7, 0));
    const channel = await pending;
    h.sent.length = 0; // drop the Connect frame for these assertions
    return channel;
  }

  test('send() fragments and addresses frames using [remoteChannel][localChannel]', async () => {
    const h = createHarness();
    const channel = await connectedChannel(h);

    channel.send(Uint8Array.of(0xaa, 0xbb));

    expect(h.sent).toHaveLength(1);
    expect(decodeNcpFrame(h.sent[0]!)).toEqual({
      kind: 'data',
      dest: 7, // remote channel
      src: 1, // our local channel
      frameType: NcpDataFrameType.Complete,
      data: Uint8Array.of(0xaa, 0xbb),
    });
  });

  test('a large payload sent via the channel arrives reassembled at onData', async () => {
    const h = createHarness();
    const channelA = await connectedChannel(h);
    const received: Uint8Array[] = [];
    channelA.onData((p) => received.push(p));

    // Simulate the remote echoing a large reassembled message back to us
    // on the same channel pairing (dest=our local channel, src=their channel).
    const payload = Uint8Array.from({ length: 600 }, (_, i) => i & 0xff);
    for (const frame of fragmentDataPayload(1, 7, payload, 250)) {
      h.session.receiveFrame(frame);
    }

    expect(received).toHaveLength(1);
    expect(Array.from(received[0]!)).toEqual(Array.from(payload));
  });

  test('onData unsubscribe stops further delivery', async () => {
    const h = createHarness();
    const channel = await connectedChannel(h);
    const received: Uint8Array[] = [];
    const unsubscribe = channel.onData((p) => received.push(p));
    unsubscribe();

    h.session.receiveFrame(Uint8Array.of(1, 7, NcpDataFrameType.Complete, 0x01));
    expect(received).toHaveLength(0);
  });

  test('a data frame for an unknown channel is dropped without throwing', () => {
    const h = createHarness();
    expect(() => h.session.receiveFrame(Uint8Array.of(99, 1, NcpDataFrameType.Complete, 0x01))).not.toThrow();
  });

  test('close() sends a Connection Termination frame and removes the channel', async () => {
    const h = createHarness();
    const channel = await connectedChannel(h);

    channel.close();

    expect(h.sent).toHaveLength(1);
    expect(decodeNcpFrame(h.sent[0]!)).toEqual({ kind: 'connectionTermination', serverChannel: 7 });

    // Data for the now-closed channel is dropped, not delivered.
    const received: Uint8Array[] = [];
    channel.onData((p) => received.push(p));
    h.session.receiveFrame(Uint8Array.of(1, 7, NcpDataFrameType.Complete, 0x01));
    expect(received).toHaveLength(0);
  });
});

describe('NcpSession remote-initiated events', () => {
  test('a Disconnection frame from the server tears down the channel locally', async () => {
    const h = createHarness();
    const pending = h.session.connectToServer('SYS$RFSV');
    h.session.receiveFrame(connectResponseFrame(1, 7, 0));
    const channel = await pending;
    const received: Uint8Array[] = [];
    channel.onData((p) => received.push(p));

    h.session.receiveFrame(Uint8Array.of(0x00, 7, NcpControlFrameType.Disconnection, 1));

    h.session.receiveFrame(Uint8Array.of(1, 7, NcpDataFrameType.Complete, 0x01));
    expect(received).toHaveLength(0);
  });

  test('an incoming NCP Information frame invokes onPeerInfo', () => {
    const h = createHarness();
    h.session.receiveFrame(Uint8Array.of(0x00, 0x00, NcpControlFrameType.NcpInformation, 0x10, 1, 0, 0, 0));

    expect(h.peerInfos).toEqual([{ version: 0x10, id: 1 }]);
  });

  test('an incoming NCP Termination frame invokes onTerminated', () => {
    const h = createHarness();
    h.session.receiveFrame(Uint8Array.of(0x00, 0, NcpControlFrameType.NcpTermination));

    expect(h.terminations).toEqual([1]);
  });

  test('an incoming Connect request (peer LINK.* handshake) is a documented no-op', () => {
    const h = createHarness();
    expect(() =>
      h.session.receiveFrame(Uint8Array.of(0x00, 3, NcpControlFrameType.Connect, 0x4c, 0x00)),
    ).not.toThrow();
    expect(h.sent).toHaveLength(0);
  });
});
