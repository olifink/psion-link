import { Injectable, computed, signal } from '@angular/core';
import { PlpConnection, PlpConnectionState, RfsvClient } from '../../protocol';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

const CONNECTING_STATES: ReadonlySet<PlpConnectionState> = new Set(['negotiatingBaud', 'linkConnected']);

/**
 * The sole Angular-aware seam onto the protocol core (`src/protocol/*`).
 * Owns the WebSerial `SerialPort` handle (obtained via
 * `navigator.serial.requestPort()`), drives a `PlpConnection` through it,
 * and republishes its state as Signals. Nothing below this service may
 * import `@angular/*` — see CLAUDE.md "Architecture".
 */
@Injectable({ providedIn: 'root' })
export class PsionLinkService {
  private connection: PlpConnection | null = null;

  private readonly port = signal<SerialPort | null>(null);
  private readonly state = signal<ConnectionState>('disconnected');
  private readonly baudRate = signal<number | null>(null);
  private readonly peerInfo = signal<{ version: number; id: number } | null>(null);
  private readonly error = signal<string | null>(null);
  private readonly rfsvClient = signal<RfsvClient | null>(null);

  readonly connectionState = this.state.asReadonly();
  readonly isConnected = computed(() => this.state() === 'connected');
  readonly isConnecting = computed(() => this.state() === 'connecting');
  /** Negotiated baud rate (BRIEF.md §4.1 autobaud cascade), once known. */
  readonly negotiatedBaudRate = this.baudRate.asReadonly();
  /** The remote's NCP Information frame (version, machine-type id), once known. */
  readonly peer = this.peerInfo.asReadonly();
  /** The reason the last connection attempt or an established session failed, if any. */
  readonly lastError = this.error.asReadonly();
  /** The RFSV32 file-service client, available once `connectionState() === 'connected'`. */
  readonly rfsv = this.rfsvClient.asReadonly();

  /** WebSerial is Chrome/Chromium/ChromeOS-only (CLAUDE.md "Scope discipline") — absent elsewhere. */
  readonly isSupported = typeof navigator !== 'undefined' && 'serial' in navigator;

  async connect(): Promise<void> {
    if (this.state() !== 'disconnected') {
      throw new Error(`cannot connect() while ${this.state()}`);
    }
    if (!this.isSupported) {
      throw new Error('Web Serial is not available in this browser');
    }

    const port = await navigator.serial.requestPort();

    this.error.set(null);
    this.baudRate.set(null);
    this.peerInfo.set(null);
    this.state.set('connecting');

    const connection = new PlpConnection({
      onStateChange: (s) => this.applyPlpState(s),
      onBaudRateNegotiated: (b) => this.baudRate.set(b),
      onPeerInfo: (info) => this.peerInfo.set(info),
      onFailed: (reason) => this.error.set(reason),
    });
    this.connection = connection;
    this.port.set(port);

    try {
      await connection.connect(port);
      this.rfsvClient.set(connection.getRfsvClient());
    } catch (err) {
      this.connection = null;
      this.port.set(null);
      this.rfsvClient.set(null);
      this.state.set('disconnected');
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.port.set(null);
    this.rfsvClient.set(null);
    if (connection) {
      await connection.disconnect();
    }
    this.state.set('disconnected');
  }

  private applyPlpState(plpState: PlpConnectionState): void {
    if (plpState === 'sessionReady') {
      this.state.set('connected');
    } else if (plpState === 'failed') {
      this.connection = null;
      this.port.set(null);
      this.rfsvClient.set(null);
      this.state.set('disconnected');
    } else if (CONNECTING_STATES.has(plpState)) {
      this.state.set('connecting');
    }
    // A 'disconnected' report from PlpConnection is driven by our own
    // disconnect(), which already sets this.state — nothing further to do.
  }
}
