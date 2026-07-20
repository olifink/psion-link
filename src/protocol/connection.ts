import { AUTOBAUD_RATES, WebSerialTransport } from './transport';
import { Clock, LinkConnection } from './link';
import { NcpChannel, NcpSession } from './ncp';
import { RfsvClient } from './rfsv';

export type PlpConnectionState = 'disconnected' | 'negotiatingBaud' | 'linkConnected' | 'sessionReady' | 'failed';

export interface PlpConnectionOptions {
  /** Baud rates to try in order (BRIEF.md §4.1: 115200 -> 57600 -> ... -> 9600). */
  baudRates?: readonly number[];
  /** How long to wait for the RFSV Connect Response once the session starts. Default 5s. */
  rfsvConnectTimeoutMs?: number;
  /** DSR poll interval for cable-pull detection; a small value is useful in tests. Default 1000ms. */
  cablePollIntervalMs?: number;
  clock?: Clock;
  onStateChange?: (state: PlpConnectionState) => void;
  onBaudRateNegotiated?: (baudRate: number) => void;
  /** Fires when a fully-established session (link + RFSV channel) is torn down unexpectedly. */
  onFailed?: (reason: string) => void;
  onPeerInfo?: (info: { version: number; id: number }) => void;
}

const DEFAULT_RFSV_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_CABLE_POLL_INTERVAL_MS = 1000;

/**
 * Wires the three framework-free protocol layers together end to end:
 * `WebSerialTransport` (physical) <-> `LinkConnection` (data link, ARQ) <->
 * `NcpSession` (session, channel multiplexing). `connect()` autobauds
 * against a raw `SerialPort` and hands back an `NcpChannel` already
 * connected to SYS$RFSV; `getRfsvClient()` exposes the same channel wrapped
 * as an `RfsvClient` (the RFSV32 presentation layer, `rfsv/client.ts`) for
 * everything above the wire protocol to use instead.
 *
 * This is the object an Angular `PsionLinkService` (CLAUDE.md
 * "Architecture") is meant to adapt to Signals — the last framework-free
 * layer before the UI. `PlpConnection` itself has no `@angular/*` imports.
 */
export class PlpConnection {
  private readonly baudRates: readonly number[];
  private readonly rfsvConnectTimeoutMs: number;
  private readonly cablePollIntervalMs: number;

  private state: PlpConnectionState = 'disconnected';
  private negotiatedBaudRate: number | null = null;
  private transport: WebSerialTransport | null = null;
  private link: LinkConnection | null = null;
  private ncp: NcpSession | null = null;
  private rfsvChannel: NcpChannel | null = null;
  private rfsvClient: RfsvClient | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoopPromise: Promise<void> | null = null;
  private unsubscribeCable: (() => void) | null = null;
  private sessionEstablished = false;
  private teardownInProgress = false;

  constructor(private readonly options: PlpConnectionOptions = {}) {
    this.baudRates = options.baudRates ?? AUTOBAUD_RATES;
    this.rfsvConnectTimeoutMs = options.rfsvConnectTimeoutMs ?? DEFAULT_RFSV_CONNECT_TIMEOUT_MS;
    this.cablePollIntervalMs = options.cablePollIntervalMs ?? DEFAULT_CABLE_POLL_INTERVAL_MS;
  }

  getState(): PlpConnectionState {
    return this.state;
  }

  getBaudRate(): number | null {
    return this.negotiatedBaudRate;
  }

  getRfsvChannel(): NcpChannel | null {
    return this.rfsvChannel;
  }

  /** The RFSV32 file-service client bound to the SYS$RFSV channel, once `connect()` resolves. */
  getRfsvClient(): RfsvClient | null {
    return this.rfsvClient;
  }

  /**
   * Autobauds against `port` (BRIEF.md §4.1: 115200 down to 9600), brings
   * up the data link + NCP session at whichever rate answers, and connects
   * to SYS$RFSV. Resolves with the RFSV channel once ready.
   */
  async connect(port: SerialPort): Promise<NcpChannel> {
    if (this.state !== 'disconnected') {
      throw new Error(`cannot connect() while ${this.state}`);
    }
    this.setState('negotiatingBaud');

    for (const baudRate of this.baudRates) {
      const channel = await this.tryBaud(port, baudRate);
      if (channel) {
        return channel;
      }
    }

    this.setState('failed');
    const reason = `no response at any baud rate (tried ${this.baudRates.join(', ')})`;
    this.options.onFailed?.(reason);
    throw new Error(reason);
  }

  /** Tears everything down: RFSV channel, NCP session, data link, and the serial port. */
  async disconnect(): Promise<void> {
    this.rfsvChannel = null;
    this.rfsvClient = null;
    this.link?.disconnect();
    await this.teardownTransport();
    this.link = null;
    this.ncp = null;
    this.sessionEstablished = false;
    this.setState('disconnected');
  }

  /** Attempts the full handshake + RFSV connect at one baud rate; null means "try the next rate". */
  private async tryBaud(port: SerialPort, baudRate: number): Promise<NcpChannel | null> {
    const transport = new WebSerialTransport(port);
    await transport.open(baudRate);
    const reader = transport.readable!.getReader();
    const writer = transport.writable!.getWriter();

    let resolveHandshake!: (outcome: 'connected' | 'failed') => void;
    const handshakeOutcome = new Promise<'connected' | 'failed'>((resolve) => {
      resolveHandshake = resolve;
    });

    // `ncp` is referenced by `link`'s onDataReceived closure before it's
    // constructed below; safe because the closure only runs once both
    // exist (LinkConnection never delivers data synchronously from its
    // constructor).
    let ncp!: NcpSession;
    const link = new LinkConnection({
      baudRate,
      clock: this.options.clock,
      onFrameReady: (frame) => this.enqueueWrite(writer, frame),
      onDataReceived: (payload) => ncp.receiveFrame(payload),
      onStateChange: (s) => {
        if (s === 'connected') {
          resolveHandshake('connected');
        }
      },
      onFailed: (reason) => {
        resolveHandshake('failed');
        if (this.sessionEstablished) {
          this.handleRuntimeFailure(reason);
        }
      },
    });
    ncp = new NcpSession({
      clock: this.options.clock,
      send: (payload) => link.send(payload),
      connectTimeoutMs: this.rfsvConnectTimeoutMs,
      onPeerInfo: this.options.onPeerInfo,
      onTerminated: () => this.handleRuntimeFailure('peer sent an NCP Termination frame'),
    });

    const readLoopPromise = this.runReadLoop(reader, link);
    link.connect();
    const outcome = await handshakeOutcome;

    if (outcome === 'failed') {
      await this.abandonAttempt(transport, reader, writer, readLoopPromise);
      return null;
    }

    // Link connected at this baud rate — commit to it; autobaud is done.
    this.negotiatedBaudRate = baudRate;
    this.options.onBaudRateNegotiated?.(baudRate);
    this.transport = transport;
    this.link = link;
    this.ncp = ncp;
    this.reader = reader;
    this.writer = writer;
    this.readLoopPromise = readLoopPromise;
    this.sessionEstablished = true;
    this.setState('linkConnected');
    this.watchCable(transport);

    ncp.start();
    try {
      const channel = await ncp.connectToServer('SYS$RFSV');
      this.rfsvChannel = channel;
      this.rfsvClient = new RfsvClient(channel);
      this.setState('sessionReady');
      return channel;
    } catch (err) {
      // The link came up fine; a failure here is an RFSV problem, not a
      // wrong-baud-rate problem, so it's a hard failure rather than a
      // reason to keep autobauding.
      this.sessionEstablished = false;
      await this.teardownTransport();
      this.link = null;
      this.ncp = null;
      this.setState('failed');
      const reason = `RFSV connect failed: ${(err as Error).message}`;
      this.options.onFailed?.(reason);
      throw new Error(reason);
    }
  }

  private async abandonAttempt(
    transport: WebSerialTransport,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    readLoopPromise: Promise<void>,
  ): Promise<void> {
    await reader.cancel().catch(() => {});
    await readLoopPromise.catch(() => {});
    try {
      writer.releaseLock();
    } catch {
      // Already released or the stream errored; nothing further to do.
    }
    await transport.close().catch(() => {});
  }

  private async runReadLoop(reader: ReadableStreamDefaultReader<Uint8Array>, link: LinkConnection): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          return;
        }
        if (value) {
          link.receiveBytes(value);
        }
      }
    } catch (err) {
      this.handleRuntimeFailure(`serial read error: ${(err as Error).message}`);
    }
  }

  private enqueueWrite(writer: WritableStreamDefaultWriter<Uint8Array>, frame: Uint8Array): void {
    void writer.write(frame).catch((err) => {
      this.handleRuntimeFailure(`serial write error: ${(err as Error).message}`);
    });
  }

  private watchCable(transport: WebSerialTransport): void {
    this.unsubscribeCable = transport.onCableStateChange((cableState) => {
      if (cableState === 'pulled') {
        this.handleRuntimeFailure('cable disconnected (DSR lost)');
      }
    });
    transport.watchCable(this.cablePollIntervalMs);
  }

  /** Reports and tears down after the session was already established (not during autobaud). */
  private handleRuntimeFailure(reason: string): void {
    if (!this.sessionEstablished) {
      return; // A stray/late callback from an attempt already abandoned.
    }
    this.sessionEstablished = false;
    this.rfsvChannel = null;
    this.rfsvClient = null;
    this.options.onFailed?.(reason);
    void this.teardownTransport().then(() => {
      this.link = null;
      this.ncp = null;
      this.setState('failed');
    });
  }

  private async teardownTransport(): Promise<void> {
    if (this.teardownInProgress) {
      return;
    }
    this.teardownInProgress = true;
    try {
      this.unsubscribeCable?.();
      this.unsubscribeCable = null;
      if (this.reader) {
        await this.reader.cancel().catch(() => {});
      }
      if (this.readLoopPromise) {
        await this.readLoopPromise.catch(() => {});
      }
      if (this.writer) {
        try {
          this.writer.releaseLock();
        } catch {
          // Already released or errored.
        }
      }
      if (this.transport) {
        await this.transport.close().catch(() => {});
      }
    } finally {
      this.reader = null;
      this.writer = null;
      this.transport = null;
      this.readLoopPromise = null;
      this.teardownInProgress = false;
    }
  }

  private setState(state: PlpConnectionState): void {
    this.state = state;
    this.options.onStateChange?.(state);
  }
}
