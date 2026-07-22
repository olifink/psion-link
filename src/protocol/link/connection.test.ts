import { beforeEach, describe, expect, test } from 'bun:test';
import { PduType } from './constants';
import { decodeContSeq, encodeContSeq } from './cont-seq';
import { encodeFrame, FrameDecoder } from './framing';
import { Clock } from './clock';
import { CONNECT_RETRIES, DATA_RETRIES, MAX_OUTSTANDING, retransmitTimeoutMs } from './timing';
import { ConnectionState, LinkConnection } from './connection';

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

  /** Advances time, firing any due timers (in time order) as it goes, including ones newly scheduled by earlier callbacks. */
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

const BAUD = 115200;
const T = retransmitTimeoutMs(BAUD);

function buildFrame(pduType: PduType, seq: number, data: Uint8Array = new Uint8Array()): Uint8Array {
  const header = encodeContSeq({ pduType, seq });
  const wire = new Uint8Array(header.length + data.length);
  wire.set(header, 0);
  wire.set(data, header.length);
  return encodeFrame(wire, { epoc: true });
}

function decodeEmitted(frame: Uint8Array) {
  const [decoded] = new FrameDecoder().push(frame);
  if (!decoded || !decoded.crcValid) {
    throw new Error('emitted frame did not decode cleanly');
  }
  const header = decodeContSeq(decoded.payload);
  return { ...header, data: decoded.payload.subarray(header.byteLength) };
}

function createHarness(baudRate = BAUD) {
  const clock = new FakeClock();
  const framesOut: Uint8Array[] = [];
  const dataReceived: Uint8Array[] = [];
  const states: ConnectionState[] = [];
  const failures: string[] = [];
  const connection = new LinkConnection({
    baudRate,
    clock,
    onFrameReady: (f) => framesOut.push(f),
    onDataReceived: (d) => dataReceived.push(d),
    onStateChange: (s) => states.push(s),
    onFailed: (reason) => failures.push(reason),
  });
  return { clock, framesOut, dataReceived, states, failures, connection };
}

/** Drives the harness through a successful handshake so it's ready for data. */
function connectHarness(h: ReturnType<typeof createHarness>): void {
  h.connection.connect();
  h.connection.receiveBytes(buildFrame(PduType.Req, 4));
}

describe('LinkConnection handshake', () => {
  test('connect() sends Req_Req_Pdu (Cont=Req, Seq=1) and enters idleReq', () => {
    const h = createHarness();
    h.connection.connect();

    expect(h.connection.getState()).toBe('idleReq');
    expect(h.framesOut).toHaveLength(1);
    expect(decodeEmitted(h.framesOut[0]!)).toMatchObject({ pduType: PduType.Req, seq: 1 });
  });

  test('connect() throws unless idle', () => {
    const h = createHarness();
    h.connection.connect();
    expect(() => h.connection.connect()).toThrow();
  });

  test('receiving Req_Con confirms the connection: sends Ack(0), enters connected', () => {
    const h = createHarness();
    h.connection.connect();
    h.connection.receiveBytes(buildFrame(PduType.Req, 4)); // Req_Con uses seq 4..6

    expect(h.connection.getState()).toBe('connected');
    expect(h.states).toEqual(['idleReq', 'connected']);
    const ack = decodeEmitted(h.framesOut[1]!);
    expect(ack).toMatchObject({ pduType: PduType.Ack, seq: 0 });
  });

  test('accepts any Req_Con seq in the documented 4..6 range', () => {
    for (const seq of [4, 5, 6]) {
      const h = createHarness();
      h.connection.connect();
      h.connection.receiveBytes(buildFrame(PduType.Req, seq));
      expect(h.connection.getState()).toBe('connected');
    }
  });

  test('retries the handshake up to 4 times, then fails back to idle', () => {
    const h = createHarness();
    h.connection.connect();

    // 4 retry fires resend Req_Req; a 5th fire (after the last retry's own
    // timeout) is what actually observes retries exhausted and fails.
    h.clock.advance((CONNECT_RETRIES + 1) * T + 10);

    // Initial Req_Req + 4 retries = 5 frames sent, all Req_Req.
    expect(h.framesOut).toHaveLength(CONNECT_RETRIES + 1);
    for (const frame of h.framesOut) {
      expect(decodeEmitted(frame)).toMatchObject({ pduType: PduType.Req, seq: 1 });
    }
    expect(h.connection.getState()).toBe('idle');
    expect(h.failures).toEqual(['connection handshake timed out']);
  });
});

describe('LinkConnection data send + ARQ', () => {
  let h: ReturnType<typeof createHarness>;

  beforeEach(() => {
    h = createHarness();
    connectHarness(h);
    h.framesOut.length = 0; // drop the handshake frames for these assertions
  });

  test('send() transmits a Data_Pdu with seq starting at 1', () => {
    h.connection.send(Uint8Array.of(0xaa, 0xbb));

    expect(h.framesOut).toHaveLength(1);
    const decoded = decodeEmitted(h.framesOut[0]!);
    expect(decoded.pduType).toBe(PduType.Data);
    expect(decoded.seq).toBe(1);
    expect(Array.from(decoded.data)).toEqual([0xaa, 0xbb]);
  });

  test('send() throws if not connected', () => {
    const fresh = createHarness();
    expect(() => fresh.connection.send(Uint8Array.of(1))).toThrow();
  });

  test('send() throws for payloads over 300 bytes', () => {
    expect(() => h.connection.send(new Uint8Array(301))).toThrow(RangeError);
  });

  test('a matching ack clears the outstanding queue', () => {
    h.connection.send(Uint8Array.of(0x01));
    expect(h.connection.getOutstandingCount()).toBe(1);

    h.connection.receiveBytes(buildFrame(PduType.Ack, 1));
    expect(h.connection.getOutstandingCount()).toBe(0);
  });

  test('an unmatched ack is ignored', () => {
    h.connection.send(Uint8Array.of(0x01));
    h.connection.receiveBytes(buildFrame(PduType.Ack, 99));
    expect(h.connection.getOutstandingCount()).toBe(1);
  });

  test('multiAck: acking a later packet implicitly clears older still-pending ones', () => {
    h.connection.send(Uint8Array.of(0x01)); // seq 1
    h.connection.send(Uint8Array.of(0x02)); // seq 2
    h.connection.send(Uint8Array.of(0x03)); // seq 3
    expect(h.connection.getOutstandingCount()).toBe(3);

    h.connection.receiveBytes(buildFrame(PduType.Ack, 3));
    expect(h.connection.getOutstandingCount()).toBe(0);
  });

  test('unacknowledged data is retransmitted, then fails after 8 retries', () => {
    h.connection.send(Uint8Array.of(0x01));

    // 8 retry fires resend the Data_Pdu; a 9th fire observes retries
    // exhausted and fails the connection.
    h.clock.advance((DATA_RETRIES + 1) * T + 10);

    // Initial send + 8 retries = 9 Data_Pdu frames, then a Disc_Pdu.
    const dataFrames = h.framesOut.filter((f) => decodeEmitted(f).pduType === PduType.Data);
    expect(dataFrames).toHaveLength(DATA_RETRIES + 1);
    for (const frame of dataFrames) {
      expect(decodeEmitted(frame).seq).toBe(1); // retransmits reuse the seq, never advancing it
    }
    const lastFrame = decodeEmitted(h.framesOut[h.framesOut.length - 1]!);
    expect(lastFrame.pduType).toBe(PduType.Disc);
    expect(h.connection.getState()).toBe('idle');
    expect(h.failures).toEqual(['data retransmit limit exceeded']);
  });

  test('holds sends beyond the window in a backlog until a slot frees up', () => {
    for (let i = 0; i < MAX_OUTSTANDING + 1; i++) {
      h.connection.send(Uint8Array.of(i));
    }
    // Only MAX_OUTSTANDING packets are actually on the wire so far.
    expect(h.connection.getOutstandingCount()).toBe(MAX_OUTSTANDING);
    expect(h.framesOut).toHaveLength(MAX_OUTSTANDING);

    // Acking the oldest frees a slot for the backlogged 9th packet.
    h.connection.receiveBytes(buildFrame(PduType.Ack, 1));
    expect(h.connection.getOutstandingCount()).toBe(MAX_OUTSTANDING);
    expect(h.framesOut).toHaveLength(MAX_OUTSTANDING + 1);
    const last = decodeEmitted(h.framesOut[h.framesOut.length - 1]!);
    expect(last.seq).toBe(MAX_OUTSTANDING + 1);
  });
});

describe('LinkConnection data receive', () => {
  let h: ReturnType<typeof createHarness>;

  beforeEach(() => {
    h = createHarness();
    connectHarness(h);
    h.framesOut.length = 0;
  });

  test('delivers an in-order Data_Pdu upward and acks it', () => {
    h.connection.receiveBytes(buildFrame(PduType.Data, 1, Uint8Array.of(0x42)));

    expect(h.dataReceived).toHaveLength(1);
    expect(Array.from(h.dataReceived[0]!)).toEqual([0x42]);
    expect(decodeEmitted(h.framesOut[0]!)).toMatchObject({ pduType: PduType.Ack, seq: 1 });
  });

  test('re-acks a duplicate without redelivering it', () => {
    h.connection.receiveBytes(buildFrame(PduType.Data, 1, Uint8Array.of(0x42)));
    h.connection.receiveBytes(buildFrame(PduType.Data, 1, Uint8Array.of(0x42))); // duplicate

    expect(h.dataReceived).toHaveLength(1);
    expect(h.framesOut).toHaveLength(2);
    expect(decodeEmitted(h.framesOut[1]!)).toMatchObject({ pduType: PduType.Ack, seq: 1 }); // re-ack of last good seq
  });

  test('ignores an out-of-order Data_Pdu but still re-acks the last good seq', () => {
    h.connection.receiveBytes(buildFrame(PduType.Data, 5, Uint8Array.of(0x99)));

    expect(h.dataReceived).toHaveLength(0);
    expect(decodeEmitted(h.framesOut[0]!)).toMatchObject({ pduType: PduType.Ack, seq: 0 });
  });
});

describe('LinkConnection disconnect + robustness', () => {
  test('disconnect() sends Disc_Pdu and returns to idle without onFailed', () => {
    const h = createHarness();
    connectHarness(h);
    h.framesOut.length = 0;

    h.connection.disconnect();

    expect(h.connection.getState()).toBe('idle');
    expect(decodeEmitted(h.framesOut[0]!).pduType).toBe(PduType.Disc);
    expect(h.failures).toEqual([]);
  });

  test('receiving Disc_Pdu resets to idle via onFailed', () => {
    const h = createHarness();
    connectHarness(h);

    h.connection.receiveBytes(buildFrame(PduType.Disc, 0));

    expect(h.connection.getState()).toBe('idle');
    expect(h.failures).toEqual(['peer disconnected']);
  });

  test('stays connected indefinitely with an empty queue and no traffic (no self-inflicted idle disconnect)', () => {
    const h = createHarness();
    connectHarness(h);
    h.framesOut.length = 0;

    // plptools' Link class has no idle/keep-alive disconnect at all — an
    // empty ackWaitQueue should never trigger a timeout, however long it's
    // been since the last frame. See timing.ts for why.
    h.clock.advance(10 * 60_000);

    expect(h.connection.getState()).toBe('connected');
    expect(h.framesOut).toEqual([]);
    expect(h.failures).toEqual([]);
  });

  test('a pending data ack retransmits on its own schedule', () => {
    const h = createHarness();
    connectHarness(h);
    h.connection.send(Uint8Array.of(0x01));
    h.framesOut.length = 0;

    h.clock.advance(T + 10);

    expect(h.connection.getState()).toBe('connected');
    expect(h.connection.getOutstandingCount()).toBe(1);
    const dataFrames = h.framesOut.filter((f) => decodeEmitted(f).pduType === PduType.Data);
    expect(dataFrames).toHaveLength(1);
    expect(h.failures).toEqual([]);
  });

  test('drops CRC-invalid frames silently', () => {
    const h = createHarness();
    connectHarness(h);
    h.framesOut.length = 0;
    h.dataReceived.length = 0;

    const frame = buildFrame(PduType.Data, 1, Uint8Array.of(0x42));
    frame[frame.length - 1] ^= 0xff; // corrupt CRC
    h.connection.receiveBytes(frame);

    expect(h.dataReceived).toHaveLength(0);
    expect(h.framesOut).toHaveLength(0);
    expect(h.connection.getState()).toBe('connected');
  });

  test('a Req_Req received while connected resets the link', () => {
    const h = createHarness();
    connectHarness(h);

    h.connection.receiveBytes(buildFrame(PduType.Req, 1));

    expect(h.connection.getState()).toBe('idle');
    expect(h.failures).toEqual(['peer restarted the link']);
  });
});
