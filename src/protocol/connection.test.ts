import { describe, expect, test } from 'bun:test';
import {
  Clock,
  PduType,
  encodeContSeq,
  decodeContSeq,
  encodeFrame,
  FrameDecoder,
} from './link';
import { NcpControlFrameType, decodeNcpFrame, encodeDataFrame } from './ncp';
import { PlpConnection, PlpConnectionState } from './connection';
import { AUTOBAUD_RATES } from './transport';

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

/**
 * A minimal fake Psion peer implementing just enough of the wire protocol
 * — link-layer handshake + Ack, one NCP Connect Response, optional data
 * echo — to exercise `PlpConnection`'s wiring end to end using the
 * project's own tested encode/decode primitives, rather than mocking at
 * the `PlpConnection` boundary itself. Real byte format, fake timing.
 */
class FakePsionPeer {
  private host: FakeSerialPort | null = null;
  private decoder = new FrameDecoder();
  private txSeqToHost = 1;
  private currentBaud: number | null = null;

  /** If set, only respond once the host opens at this exact baud rate (simulates autobaud). */
  respondAtBaud: number | null = null;
  /** How the fake Psion answers an NCP Connect frame for "SYS$RFSV.*". */
  connectResponse: { serverChannel: number; status: number } | 'silence' = { serverChannel: 7, status: 0 };
  /** If true, echoes any NCP Data frame straight back on the same channel pairing. */
  echoChannelData = false;
  readonly receivedChannelData: Uint8Array[] = [];

  attachHost(host: FakeSerialPort): void {
    this.host = host;
  }

  onHostOpened(baudRate: number): void {
    this.currentBaud = baudRate;
    this.decoder.reset();
    this.txSeqToHost = 1;
  }

  handleFromHost(chunk: Uint8Array): void {
    if (this.respondAtBaud !== null && this.respondAtBaud !== this.currentBaud) {
      return; // Simulate silence at the wrong baud rate.
    }
    for (const frame of this.decoder.push(chunk)) {
      if (!frame.crcValid) continue;
      this.handlePacket(frame.payload);
    }
  }

  private handlePacket(payload: Uint8Array): void {
    const header = decodeContSeq(payload);
    const data = payload.subarray(header.byteLength);
    switch (header.pduType) {
      case PduType.Req:
        if (header.seq === 1) {
          this.sendReqCon();
        }
        break;
      case PduType.Ack:
        break; // Handshake complete from our side too; nothing further needed.
      case PduType.Data:
        this.sendRaw(encodeContSeq({ pduType: PduType.Ack, seq: header.seq }));
        this.handleNcpPayload(data);
        break;
    }
  }

  private sendReqCon(): void {
    const header = encodeContSeq({ pduType: PduType.Req, seq: 4 });
    const magic = Uint8Array.of(0xaa, 0xbb, 0xcc, 0xdd);
    const body = new Uint8Array(header.length + magic.length);
    body.set(header, 0);
    body.set(magic, header.length);
    this.sendRaw(body);
  }

  private handleNcpPayload(payload: Uint8Array): void {
    const frame = decodeNcpFrame(payload);
    if (frame.kind === 'connect') {
      if (this.connectResponse === 'silence') {
        return;
      }
      const { serverChannel, status } = this.connectResponse;
      const ncpBody = Uint8Array.of(
        0x00,
        status === 0 ? serverChannel : 0,
        NcpControlFrameType.ConnectResponse,
        frame.clientChannel,
        status,
      );
      this.sendDataPdu(ncpBody);
    } else if (frame.kind === 'data') {
      this.receivedChannelData.push(frame.data);
      if (this.echoChannelData) {
        this.sendDataPdu(encodeDataFrame(frame.src, frame.dest, frame.frameType, frame.data));
      }
    }
  }

  private sendDataPdu(ncpPayload: Uint8Array): void {
    const header = encodeContSeq({ pduType: PduType.Data, seq: this.txSeqToHost++ });
    const combined = new Uint8Array(header.length + ncpPayload.length);
    combined.set(header, 0);
    combined.set(ncpPayload, header.length);
    this.sendRaw(combined);
  }

  private sendRaw(contSeqAndData: Uint8Array): void {
    this.host?.pushToHost(encodeFrame(contSeqAndData, { epoc: true }));
  }
}

/** Minimal SerialPort mock: fresh Streams per open() (mirrors real WebSerial's port.close() behavior). */
class FakeSerialPort {
  onconnect: ((this: this, ev: Event) => void) | null = null;
  ondisconnect: ((this: this, ev: Event) => void) | null = null;
  readonly connected = true;
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  openCalls: SerialOptions[] = [];

  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private dsr = true;

  constructor(private readonly peer: FakePsionPeer) {
    peer.attachHost(this);
  }

  async open(options: SerialOptions): Promise<void> {
    this.openCalls.push(options);
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.controller = null;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.peer.handleFromHost(chunk);
      },
    });
    this.peer.onHostOpened(options.baudRate);
  }

  pushToHost(bytes: Uint8Array): void {
    this.controller?.enqueue(bytes);
  }

  async setSignals(): Promise<void> {}

  async getSignals(): Promise<SerialInputSignals> {
    return { dataCarrierDetect: false, clearToSend: false, ringIndicator: false, dataSetReady: this.dsr };
  }

  getInfo(): SerialPortInfo {
    return {};
  }

  async close(): Promise<void> {
    this.readable = null;
    this.writable = null;
    this.controller = null;
  }

  async forget(): Promise<void> {}

  setMockDsr(value: boolean): void {
    this.dsr = value;
  }
}

function createHarness(options: { clock?: Clock; cablePollIntervalMs?: number } = {}) {
  const peer = new FakePsionPeer();
  const port = new FakeSerialPort(peer);
  const states: PlpConnectionState[] = [];
  const failures: string[] = [];
  const negotiatedBauds: number[] = [];
  const connection = new PlpConnection({
    clock: options.clock,
    cablePollIntervalMs: options.cablePollIntervalMs ?? 5,
    onStateChange: (s) => states.push(s),
    onFailed: (reason) => failures.push(reason),
    onBaudRateNegotiated: (b) => negotiatedBauds.push(b),
  });
  return { peer, port, states, failures, negotiatedBauds, connection };
}

describe('PlpConnection.connect happy path', () => {
  test('connects at the first baud rate and returns an RFSV channel', async () => {
    const h = createHarness();
    const channel = await h.connection.connect(h.port as unknown as SerialPort);

    expect(h.connection.getState()).toBe('sessionReady');
    expect(h.connection.getBaudRate()).toBe(115200); // AUTOBAUD_RATES[0]
    expect(h.negotiatedBauds).toEqual([115200]);
    expect(channel.remoteChannel).toBe(7);
    expect(h.states).toEqual(['negotiatingBaud', 'linkConnected', 'sessionReady']);
    expect(h.failures).toEqual([]);
  });

  test('data sent through the RFSV channel reaches the peer and an echoed reply arrives via onData', async () => {
    const h = createHarness();
    h.peer.echoChannelData = true;
    const channel = await h.connection.connect(h.port as unknown as SerialPort);

    const received: Uint8Array[] = [];
    channel.onData((p) => received.push(p));
    channel.send(Uint8Array.of(0x01, 0x02, 0x03));

    // The echo travels through real Streams microtasks (write -> peer -> read
    // loop); give it a tick to land without relying on a fixed sleep.
    await Bun.sleep(0);

    expect(h.peer.receivedChannelData).toHaveLength(1);
    expect(Array.from(h.peer.receivedChannelData[0]!)).toEqual([0x01, 0x02, 0x03]);
    expect(received).toHaveLength(1);
    expect(Array.from(received[0]!)).toEqual([0x01, 0x02, 0x03]);
  });
});

describe('PlpConnection.connect autobaud cascade', () => {
  /**
   * clock.advance() only fires timers already registered *at the moment
   * it's called*; the next baud attempt's setTimeout is registered inside
   * a promise continuation (after abandoning the previous attempt), which
   * needs a real event-loop tick to run. A synchronous burst of advance()
   * calls with no yield in between would only ever process the first
   * scheduled timeout — hence the Bun.sleep(0) between each step.
   */
  async function driveClockUntil(clock: FakeClock, stepMs: number, isDone: () => boolean, maxSteps = 100): Promise<void> {
    for (let i = 0; i < maxSteps && !isDone(); i++) {
      clock.advance(stepMs);
      await Bun.sleep(0);
    }
  }

  test('falls through to the baud rate the peer actually answers at', async () => {
    const clock = new FakeClock();
    const h = createHarness({ clock });
    h.peer.respondAtBaud = 19200; // 4th in AUTOBAUD_RATES: 115200, 57600, 38400, 19200

    const pending = h.connection.connect(h.port as unknown as SerialPort);
    await driveClockUntil(clock, 2000, () => h.connection.getState() === 'sessionReady');
    const channel = await pending;

    expect(h.connection.getBaudRate()).toBe(19200);
    expect(channel.remoteChannel).toBe(7);
    expect(h.port.openCalls.map((o) => o.baudRate)).toEqual([115200, 57600, 38400, 19200]);
  });

  test('fails after exhausting every baud rate with no response', async () => {
    const clock = new FakeClock();
    const h = createHarness({ clock });
    h.peer.respondAtBaud = 1234567; // a rate never actually tried: peer never answers

    const pending = h.connection.connect(h.port as unknown as SerialPort);
    pending.catch(() => {});

    await driveClockUntil(clock, 2000, () => h.connection.getState() === 'failed');

    await expect(pending).rejects.toThrow('no response at any baud rate');
    expect(h.connection.getState()).toBe('failed');
    expect(h.port.openCalls.map((o) => o.baudRate)).toEqual([...AUTOBAUD_RATES]);
    expect(h.failures).toEqual([expect.stringContaining('no response at any baud rate')]);
  });
});

describe('PlpConnection RFSV connect failure', () => {
  test('a rejected Connect Response fails the whole connect(), even though the link came up', async () => {
    const h = createHarness();
    h.peer.connectResponse = { serverChannel: 0, status: 5 };

    await expect(h.connection.connect(h.port as unknown as SerialPort)).rejects.toThrow('RFSV connect failed');
    expect(h.connection.getState()).toBe('failed');
    expect(h.failures.some((f) => f.includes('RFSV connect failed'))).toBe(true);
  });
});

describe('PlpConnection.disconnect', () => {
  test('returns to disconnected without reporting a failure', async () => {
    const h = createHarness();
    await h.connection.connect(h.port as unknown as SerialPort);

    await h.connection.disconnect();

    expect(h.connection.getState()).toBe('disconnected');
    expect(h.connection.getRfsvChannel()).toBeNull();
    expect(h.failures).toEqual([]);
  });
});

describe('PlpConnection cable-pull detection', () => {
  test('a lost DSR signal after the session is established triggers onFailed and teardown', async () => {
    const h = createHarness();
    await h.connection.connect(h.port as unknown as SerialPort);

    h.port.setMockDsr(false);
    // watchCable polls every 5ms per the harness config; give it a couple of ticks.
    await Bun.sleep(30);

    expect(h.connection.getState()).toBe('failed');
    expect(h.failures.some((f) => f.includes('cable'))).toBe(true);
  });
});

