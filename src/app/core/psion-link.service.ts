import { Injectable, computed, signal } from '@angular/core';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

/**
 * The sole Angular-aware seam onto the protocol core (`src/protocol/*`).
 * Owns the WebSerial `SerialPort` handle, exposes connection state as
 * Signals, and adapts the core's async/event-based API to the UI. Nothing
 * below this service may import `@angular/*` — see CLAUDE.md "Architecture".
 */
@Injectable({ providedIn: 'root' })
export class PsionLinkService {
  private readonly port = signal<SerialPort | null>(null);
  private readonly state = signal<ConnectionState>('disconnected');

  readonly connectionState = this.state.asReadonly();
  readonly isConnected = computed(() => this.state() === 'connected');

  async connect(): Promise<void> {
    throw new Error('not implemented');
  }

  async disconnect(): Promise<void> {
    throw new Error('not implemented');
  }
}
