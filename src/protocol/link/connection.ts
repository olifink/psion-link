import { PduType } from './constants';
import { ContSeqHeader, decodeContSeq, encodeContSeq } from './cont-seq';
import { DecodedFrame, FrameDecoder, encodeFrame } from './framing';
import { Clock, SYSTEM_CLOCK } from './clock';
import { CONNECT_RETRIES, DATA_RETRIES, INACTIVITY_TIMEOUT_MS, MAX_OUTSTANDING, MAX_PAYLOAD_BYTES, retransmitTimeoutMs } from './timing';

/** EPOC variant: mod-2048 sequencing (BRIEF.md §4.2). */
const SEQ_MASK = 0x7ff;

/**
 * Client/initiator-only connection state. The PLP spec's sample state
 * machine (plp.html §"State Machine") names five states — Idle_State,
 * Idle_Req_State, Idle_Ack_State, Data_State, Data_Ack_State — for a
 * bidirectional (peer-to-peer capable) machine. This implementation only
 * ever plays the client/initiator role against the Psion (per BRIEF.md's
 * handshake: client sends Req_Req, Psion replies Req_Con, client sends
 * Ack), so:
 *  - Idle_Ack_State (the *acceptor's* "I sent Req_Con, awaiting Ack" state)
 *    never occurs here — we never send Req_Con ourselves.
 *  - Data_State / Data_Ack_State are collapsed into 'connected': EPOC is
 *    multi-windowed (up to 8 outstanding Data_Pdus, not the spec sample's
 *    single-window simplification), so "awaiting an ack" isn't a single
 *    connection-wide state — it's tracked per packet in `ackWaitQueue`.
 *    `checkTimeouts` reproduces the spec's Data_State vs. Data_Ack_State
 *    Timeout-event split (inactivity vs. per-packet retransmit) based on
 *    whether that queue is empty.
 */
export type ConnectionState = 'idle' | 'idleReq' | 'connected';

export interface LinkConnectionOptions {
  /** Negotiated baud rate; drives the spec's retransmit-timeout formula. */
  baudRate: number;
  /** Fully wire-encoded frames (SYN...CRC) ready to write to the transport. */
  onFrameReady: (frame: Uint8Array) => void;
  /** De-duplicated, in-order NCP-layer payloads (Cont/Seq header stripped). */
  onDataReceived: (payload: Uint8Array) => void;
  onStateChange?: (state: ConnectionState) => void;
  /** Connection torn down for a reason other than a local disconnect() call. */
  onFailed?: (reason: string) => void;
  clock?: Clock;
}

interface PendingPacket {
  seq: number;
  /** Fully wire-encoded frame, kept around verbatim for retransmission. */
  frame: Uint8Array;
  retriesRemaining: number;
  deadline: number;
}

/**
 * The PLP data link layer's ARQ + connection state machine: owns framing
 * (via FrameDecoder/encodeFrame), the Cont/Seq handshake, the sliding
 * send window, and retransmission/inactivity timeouts. Transport-agnostic
 * — feed it raw serial bytes via `receiveBytes`, and write whatever it
 * hands to `onFrameReady` back out to the wire; it has no dependency on
 * WebSerialTransport.
 */
export class LinkConnection {
  private readonly clock: Clock;
  private readonly decoder = new FrameDecoder();

  private state: ConnectionState = 'idle';
  private txSeq = 1;
  private rxSeq = -1;
  private connectRetriesRemaining = CONNECT_RETRIES;
  private idleReqDeadline = 0;
  private lastActivityAt = 0;
  private timerHandle: unknown = null;

  private ackWaitQueue: PendingPacket[] = [];
  private sendBacklog: Uint8Array[] = [];

  constructor(private readonly options: LinkConnectionOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  getState(): ConnectionState {
    return this.state;
  }

  getOutstandingCount(): number {
    return this.ackWaitQueue.length;
  }

  /** Idle -> Idle_Req: sends Req_Req_Pdu and starts the handshake retry timer. */
  connect(): void {
    if (this.state !== 'idle') {
      throw new Error(`cannot connect() while ${this.state}`);
    }
    this.connectRetriesRemaining = CONNECT_RETRIES;
    this.setState('idleReq');
    this.sendReqReq();
    this.idleReqDeadline = this.clock.now() + retransmitTimeoutMs(this.options.baudRate);
    this.rescheduleTimer();
  }

  /** Sends Disc_Pdu (if connected/connecting) and returns to Idle_State. */
  disconnect(): void {
    if (this.state === 'idleReq' || this.state === 'connected') {
      this.sendDisc();
    }
    this.resetState();
    this.setState('idle');
  }

  /**
   * Queues an application payload for reliable delivery as a Data_Pdu.
   * Transmits immediately if the send window has room, otherwise holds it
   * until an earlier packet is acknowledged.
   */
  send(payload: Uint8Array): void {
    if (this.state !== 'connected') {
      throw new Error(`cannot send() while ${this.state}`);
    }
    if (payload.length > MAX_PAYLOAD_BYTES) {
      throw new RangeError(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes: ${payload.length}`);
    }
    this.sendBacklog.push(payload);
    this.pumpSendBacklog();
  }

  /** Feed raw bytes as they arrive off the serial port, in any chunk size. */
  receiveBytes(chunk: Uint8Array): void {
    const frames = this.decoder.push(chunk);
    for (const frame of frames) {
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: DecodedFrame): void {
    if (!frame.crcValid) {
      return; // Drop silently; the sender's ARQ will retransmit.
    }
    let header: ContSeqHeader & { byteLength: number };
    try {
      header = decodeContSeq(frame.payload);
    } catch {
      return; // Malformed header; drop.
    }
    const data = frame.payload.subarray(header.byteLength);
    switch (header.pduType) {
      case PduType.Data:
        this.onDataPdu(header.seq, data);
        break;
      case PduType.Ack:
        this.onAckPdu(header.seq);
        break;
      case PduType.Req:
        this.onReqPdu(header.seq);
        break;
      case PduType.Disc:
        this.onDiscPdu();
        break;
      default:
        break;
    }
  }

  private onReqPdu(seq: number): void {
    // Req_Con_Pdu uses Seq 4..6 (spec: "4 ... 6 (use 4)"). The spec's own
    // sample state table doesn't show this transition for the initiator
    // role (see the class doc comment); this follows plptools'
    // Link::receive case 0x20 instead, which does.
    const isReqCon = seq >= 4 && seq <= 6;
    if (this.state === 'idleReq' && isReqCon) {
      this.rxSeq = 0;
      this.txSeq = 1;
      this.connectRetriesRemaining = CONNECT_RETRIES;
      this.setState('connected');
      this.sendAck(0);
      this.noteActivity();
      this.rescheduleTimer();
      return;
    }
    if (this.state === 'connected') {
      // Peer restarted the link (spec: Data_State/Data_Ack_State + Req_Rx /
      // Req_Req_Rx / Req_Con_Rx -> Reset(); connection terminated).
      this.fail('peer restarted the link');
    }
    // Otherwise: acceptor-role transitions (we'd be replying with our own
    // Req_Con) are out of scope — we only ever initiate.
  }

  private onDiscPdu(): void {
    if (this.state !== 'idle') {
      this.fail('peer disconnected');
    }
  }

  private onDataPdu(seq: number, payload: Uint8Array): void {
    if (this.state !== 'connected') {
      return; // Spec: Data_Rx in any Idle_* state is a no-op.
    }
    const expected = (this.rxSeq + 1) & SEQ_MASK;
    if (seq === expected) {
      this.rxSeq = expected;
      this.sendAck(this.rxSeq);
      this.noteActivity();
      this.rescheduleTimer();
      this.options.onDataReceived(payload);
    } else {
      // Duplicate or out-of-order: re-ack the last known-good seq (spec:
      // "Seq field of the Ack_Pdu should be set to the value from the last
      // valid Data_Pdu received, not necessarily that of the Data_Pdu
      // being responded to"). Don't redeliver upward.
      this.sendAck(this.rxSeq);
    }
  }

  private onAckPdu(seq: number): void {
    if (this.state !== 'connected') {
      return;
    }
    const index = this.ackWaitQueue.findIndex((p) => p.seq === seq);
    if (index === -1) {
      return; // Unmatched ack; ignored (plptools also retransmits seq+1
      // immediately as a latency optimization here — deferred, not
      // required for correctness since the normal retransmit timer covers it).
    }
    // plptools' multiAck(): an ack also implicitly confirms any older
    // still-outstanding packets, since the receiver processes Data_Pdus in
    // order. The queue is always in FIFO transmission order (entries are
    // only ever pushed to the end), so "older" is just "earlier index" —
    // no need for plptools' timestamp comparison, which breaks down for
    // packets sent within the same clock tick.
    this.ackWaitQueue.splice(0, index + 1);
    this.noteActivity();
    this.pumpSendBacklog();
    this.rescheduleTimer();
  }

  private pumpSendBacklog(): void {
    while (this.sendBacklog.length > 0 && this.ackWaitQueue.length < MAX_OUTSTANDING) {
      const payload = this.sendBacklog.shift()!;
      this.transmitDataPacket(payload);
    }
    this.rescheduleTimer();
  }

  private transmitDataPacket(payload: Uint8Array): void {
    const seq = this.txSeq;
    this.txSeq = (this.txSeq + 1) & SEQ_MASK;
    const header = encodeContSeq({ pduType: PduType.Data, seq });
    const wire = new Uint8Array(header.length + payload.length);
    wire.set(header, 0);
    wire.set(payload, header.length);
    const frame = encodeFrame(wire, { epoc: true });
    this.ackWaitQueue.push({
      seq,
      frame,
      retriesRemaining: DATA_RETRIES,
      deadline: this.clock.now() + retransmitTimeoutMs(this.options.baudRate),
    });
    this.emitFrame(frame);
  }

  /** The spec's single "Timeout" event: dispatches on current state. */
  private checkTimeouts(now: number): void {
    if (this.state === 'idleReq') {
      if (now < this.idleReqDeadline) {
        return;
      }
      if (this.connectRetriesRemaining > 0) {
        this.connectRetriesRemaining--;
        this.sendReqReq();
        this.idleReqDeadline = now + retransmitTimeoutMs(this.options.baudRate);
      } else {
        this.fail('connection handshake timed out');
      }
      return;
    }

    if (this.state === 'connected') {
      const oldest = this.ackWaitQueue[0];
      if (oldest) {
        if (now < oldest.deadline) {
          return;
        }
        if (oldest.retriesRemaining > 0) {
          oldest.retriesRemaining--;
          oldest.deadline = now + retransmitTimeoutMs(this.options.baudRate);
          this.emitFrame(oldest.frame);
        } else {
          this.sendDisc();
          this.fail('data retransmit limit exceeded');
        }
        return;
      }
      const inactivityDeadline = this.lastActivityAt + INACTIVITY_TIMEOUT_MS;
      if (now < inactivityDeadline) {
        return;
      }
      this.sendDisc();
      this.fail('inactivity timeout');
    }
  }

  private noteActivity(): void {
    this.lastActivityAt = this.clock.now();
  }

  private sendReqReq(): void {
    const header = encodeContSeq({ pduType: PduType.Req, seq: 1 });
    this.emitFrame(encodeFrame(header, { epoc: true }));
  }

  private sendAck(seq: number): void {
    const header = encodeContSeq({ pduType: PduType.Ack, seq });
    this.emitFrame(encodeFrame(header, { epoc: true }));
  }

  private sendDisc(): void {
    const header = encodeContSeq({ pduType: PduType.Disc, seq: 0 });
    this.emitFrame(encodeFrame(header, { epoc: true }));
  }

  private emitFrame(frame: Uint8Array): void {
    this.options.onFrameReady(frame);
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.options.onStateChange?.(state);
  }

  private fail(reason: string): void {
    this.resetState();
    this.setState('idle');
    this.options.onFailed?.(reason);
  }

  private resetState(): void {
    this.clearTimer();
    this.ackWaitQueue = [];
    this.sendBacklog = [];
    this.decoder.reset();
    this.txSeq = 1;
    this.rxSeq = -1;
    this.connectRetriesRemaining = CONNECT_RETRIES;
  }

  private clearTimer(): void {
    if (this.timerHandle !== null) {
      this.clock.clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }

  private rescheduleTimer(): void {
    this.clearTimer();
    let deadline: number | null = null;
    if (this.state === 'idleReq') {
      deadline = this.idleReqDeadline;
    } else if (this.state === 'connected') {
      deadline =
        this.ackWaitQueue.length > 0
          ? this.ackWaitQueue[0]!.deadline
          : this.lastActivityAt + INACTIVITY_TIMEOUT_MS;
    }
    if (deadline === null) {
      return;
    }
    const delay = Math.max(0, deadline - this.clock.now());
    this.timerHandle = this.clock.setTimeout(() => {
      this.timerHandle = null;
      this.checkTimeouts(this.clock.now());
      this.rescheduleTimer();
    }, delay);
  }
}
