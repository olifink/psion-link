import { Clock, SYSTEM_CLOCK } from '../link/clock';
import { MAX_CHANNELS, NCP_VERSION_EPOC_ER5 } from './constants';
import { DecodedNcpFrame, decodeNcpFrame, encodeConnectFrame, encodeConnectionTerminationFrame, encodeNcpInfoFrame } from './frame';
import { FrameReassembler, fragmentDataPayload } from './fragmentation';

export interface NcpSessionOptions {
  /** Hands a wire-encoded NCP frame down to the data link (LinkConnection.send). */
  send: (payload: Uint8Array) => void;
  clock?: Clock;
  /** How long to wait for a Connect Response before rejecting connectToServer(). Default 5s. */
  connectTimeoutMs?: number;
  /** Injectable for deterministic tests; a random 32-bit value otherwise. */
  ncpId?: number;
  /** Fires when the peer's own NCP Information frame arrives. */
  onPeerInfo?: (info: { version: number; id: number }) => void;
  /** Fires if the peer sends an NCP Termination frame. */
  onTerminated?: () => void;
}

export interface NcpChannel {
  readonly localChannel: number;
  readonly remoteChannel: number;
  send(payload: Uint8Array): void;
  onData(listener: (payload: Uint8Array) => void): () => void;
  /** Sends a Connection Termination frame and removes the channel locally. */
  close(): void;
}

interface PendingConnect {
  resolve: (channel: NcpChannel) => void;
  reject: (err: Error) => void;
  timeoutHandle: unknown;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

class NcpChannelImpl implements NcpChannel {
  private readonly listeners = new Set<(payload: Uint8Array) => void>();

  constructor(
    readonly localChannel: number,
    readonly remoteChannel: number,
    private readonly session: NcpSession,
  ) {}

  send(payload: Uint8Array): void {
    this.session.sendOnChannel(this.localChannel, this.remoteChannel, payload);
  }

  onData(listener: (payload: Uint8Array) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.session.closeChannel(this.localChannel, this.remoteChannel);
  }

  deliver(payload: Uint8Array): void {
    for (const listener of this.listeners) {
      listener(payload);
    }
  }
}

/**
 * NCP session layer: channel multiplexing + fragmentation over a data-link
 * connection. Client/initiator role only, matching `LinkConnection` (see
 * its doc comment) — we open channels to servers on the Psion (SYS$RFSV.*
 * per BRIEF.md §4.3); we never accept incoming connections.
 *
 * OPEN QUESTION: the PLP spec's general Connection Sequence table
 * (plp.html §"Session Layer") shows both peers sending a Connect frame for
 * LINK.* to *each other* symmetrically. This implementation never responds
 * to an incoming Connect frame (we have no LINK service to offer), on the
 * assumption — per BRIEF.md §4.3, which only documents outbound Connect to
 * SYS$RFSV.*, and plptools' own SYS$RFSV fast path (`socketchannel.cc`),
 * which connects without first completing a symmetric LINK.* handshake —
 * that the Psion doesn't require it either. Unconfirmed against real
 * hardware; revisit if a device stalls waiting for our Connect Response to
 * its own LINK.* request.
 *
 * The LINK-channel Register fallback BRIEF.md describes ("if [Connect to
 * SYS$RFSV.*] fails, use the Link Register command on channel 1") is not
 * implemented yet — plptools' own SYS$RFSV special case (`socketchannel.cc`)
 * suggests it should rarely be needed in practice.
 */
export class NcpSession {
  private readonly clock: Clock;
  private readonly connectTimeoutMs: number;
  private nextChannel = 1; // channel 0 reserved for control (PLP spec §"Channels")
  private readonly channels = new Map<number, NcpChannelImpl>();
  private readonly reassemblers = new Map<number, FrameReassembler>();
  private readonly pendingConnects = new Map<number, PendingConnect>();

  constructor(private readonly options: NcpSessionOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  /** Sends the NCP Information frame. Call once the data link reaches 'connected'. */
  start(): void {
    const id = this.options.ncpId ?? (Math.random() * 0x1_0000_0000) >>> 0;
    this.options.send(encodeNcpInfoFrame(NCP_VERSION_EPOC_ER5, id));
  }

  /** Opens a channel to `${baseName}.*` (e.g. "SYS$RFSV") and resolves once the server accepts. */
  connectToServer(baseName: string): Promise<NcpChannel> {
    const localChannel = this.allocateChannel();
    const serverName = `${baseName}.*`;
    return new Promise<NcpChannel>((resolve, reject) => {
      const timeoutHandle = this.clock.setTimeout(() => {
        this.pendingConnects.delete(localChannel);
        reject(new Error(`connect to "${serverName}" timed out`));
      }, this.connectTimeoutMs);
      this.pendingConnects.set(localChannel, { resolve, reject, timeoutHandle });
      this.options.send(encodeConnectFrame(localChannel, serverName));
    });
  }

  /** Feed de-fragmented NCP-layer payloads here, from LinkConnection's onDataReceived. */
  receiveFrame(payload: Uint8Array): void {
    const frame = decodeNcpFrame(payload);
    switch (frame.kind) {
      case 'connectResponse':
        this.handleConnectResponse(frame);
        break;
      case 'data':
        this.handleDataFrame(frame);
        break;
      case 'disconnection':
        this.handleRemoteDisconnection(frame);
        break;
      case 'ncpInfo':
        this.options.onPeerInfo?.({ version: frame.version, id: frame.id });
        break;
      case 'ncpTermination':
        this.options.onTerminated?.();
        break;
      case 'connect':
      case 'connectionTermination':
      case 'xoff':
      case 'xon':
        // Peer-initiated connect requests and flow control aren't handled
        // yet — see the class doc comment's OPEN QUESTION. Connection
        // Termination from a peer we never accepted a connection from is
        // a no-op.
        break;
    }
  }

  private handleConnectResponse(frame: Extract<DecodedNcpFrame, { kind: 'connectResponse' }>): void {
    const pending = this.pendingConnects.get(frame.clientChannel);
    if (!pending) {
      return; // Unmatched or already timed out.
    }
    this.pendingConnects.delete(frame.clientChannel);
    this.clock.clearTimeout(pending.timeoutHandle);
    if (frame.status !== 0) {
      pending.reject(new Error(`connect rejected: status ${frame.status}`));
      return;
    }
    const channel = new NcpChannelImpl(frame.clientChannel, frame.serverChannel, this);
    this.channels.set(frame.clientChannel, channel);
    this.reassemblers.set(frame.clientChannel, new FrameReassembler());
    pending.resolve(channel);
  }

  private handleDataFrame(frame: Extract<DecodedNcpFrame, { kind: 'data' }>): void {
    const reassembler = this.reassemblers.get(frame.dest);
    const channel = this.channels.get(frame.dest);
    if (!reassembler || !channel) {
      return; // Unknown channel; drop.
    }
    const complete = reassembler.push(frame.frameType, frame.data);
    if (complete) {
      channel.deliver(complete);
    }
  }

  private handleRemoteDisconnection(frame: Extract<DecodedNcpFrame, { kind: 'disconnection' }>): void {
    // Server-initiated teardown (PLP spec: "The specified server has
    // disconnected the specified client"); frame.clientChannel is our
    // local channel number.
    this.channels.delete(frame.clientChannel);
    this.reassemblers.delete(frame.clientChannel);
  }

  /** @internal used by NcpChannelImpl */
  sendOnChannel(localChannel: number, remoteChannel: number, payload: Uint8Array): void {
    for (const frame of fragmentDataPayload(remoteChannel, localChannel, payload)) {
      this.options.send(frame);
    }
  }

  /** @internal used by NcpChannelImpl */
  closeChannel(localChannel: number, remoteChannel: number): void {
    this.channels.delete(localChannel);
    this.reassemblers.delete(localChannel);
    this.options.send(encodeConnectionTerminationFrame(remoteChannel));
  }

  private allocateChannel(): number {
    let candidate = this.nextChannel;
    for (let attempts = 0; attempts < MAX_CHANNELS; attempts++) {
      if (!this.channels.has(candidate) && !this.pendingConnects.has(candidate)) {
        this.nextChannel = candidate + 1 >= MAX_CHANNELS ? 1 : candidate + 1;
        return candidate;
      }
      candidate = candidate + 1 >= MAX_CHANNELS ? 1 : candidate + 1;
    }
    throw new Error('no free NCP channels');
  }
}
