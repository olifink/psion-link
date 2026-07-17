import { PHYSICAL_SERIAL_OPTIONS } from './serial-options';

export type CableState = 'present' | 'pulled';
export type CableStateListener = (state: CableState) => void;

/**
 * Owns a WebSerial `SerialPort`: opens it at a given baud rate with 8N1 +
 * hardware flow control, raises DTR/RTS while open, and polls DSR to
 * detect the cable being pulled. Exposes `port.readable`/`port.writable`
 * directly — framing and read-loop ownership belong to the link layer
 * above, per CLAUDE.md's architecture diagram.
 */
export class WebSerialTransport {
  private open_ = false;
  private dsrPollHandle: ReturnType<typeof setInterval> | null = null;
  private lastCableState: CableState | null = null;
  private readonly cableStateListeners = new Set<CableStateListener>();

  constructor(private readonly port: SerialPort) {}

  get isOpen(): boolean {
    return this.open_;
  }

  get readable(): ReadableStream<Uint8Array> | null {
    return this.port.readable;
  }

  get writable(): WritableStream<Uint8Array> | null {
    return this.port.writable;
  }

  async open(baudRate: number): Promise<void> {
    if (this.open_) {
      throw new Error('WebSerialTransport is already open');
    }
    await this.port.open({ baudRate, ...PHYSICAL_SERIAL_OPTIONS });
    this.open_ = true;
    await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
  }

  async close(): Promise<void> {
    if (!this.open_) {
      return;
    }
    this.stopWatchingCable();
    try {
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
    } finally {
      await this.port.close();
      this.open_ = false;
    }
  }

  async getDsr(): Promise<boolean> {
    const signals = await this.port.getSignals();
    return signals.dataSetReady;
  }

  /** Poll DSR on an interval, notifying listeners only on state change. */
  watchCable(pollIntervalMs = 1000): void {
    if (!this.open_) {
      throw new Error('cannot watch cable state before open()');
    }
    if (this.dsrPollHandle !== null) {
      return;
    }
    this.dsrPollHandle = setInterval(() => {
      void this.pollCable();
    }, pollIntervalMs);
    void this.pollCable();
  }

  stopWatchingCable(): void {
    if (this.dsrPollHandle !== null) {
      clearInterval(this.dsrPollHandle);
      this.dsrPollHandle = null;
    }
  }

  onCableStateChange(listener: CableStateListener): () => void {
    this.cableStateListeners.add(listener);
    return () => this.cableStateListeners.delete(listener);
  }

  private async pollCable(): Promise<void> {
    const dsr = await this.getDsr().catch(() => false);
    const state: CableState = dsr ? 'present' : 'pulled';
    if (state !== this.lastCableState) {
      this.lastCableState = state;
      for (const listener of this.cableStateListeners) {
        listener(state);
      }
    }
  }
}
