import {
  PduType,
  encodeContSeq,
  decodeContSeq,
  encodeFrame,
  FrameDecoder,
  NcpControlFrameType,
  NcpDataFrameType,
  decodeNcpFrame,
  encodeDataFrame,
} from '../../protocol';

/**
 * The minimal fake Psion peer needed to drive a real handshake through
 * `PsionLinkService` -> `PlpConnection` in Angular specs, built from the
 * project's own tested encode/decode primitives rather than mocking at a
 * service boundary. Trimmed down from `src/protocol/connection.test.ts`'s
 * `FakePsionPeer` — no autobaud/cable-pull simulation, since those are
 * already covered at the protocol-core layer; this only drives the happy
 * path plus RFSV32 command/reply exchange for file-browser specs.
 */
export class FakePsionPeer {
  private host: FakeSerialPort | null = null;
  private decoder = new FrameDecoder();
  private txSeqToHost = 1;
  readonly receivedChannelData: Uint8Array[] = [];
  private channelListener: ((payload: Uint8Array) => void) | null = null;
  private lastChannelFrame: { dest: number; src: number; frameType: NcpDataFrameType } | null = null;

  attachHost(host: FakeSerialPort): void {
    this.host = host;
  }

  onHostOpened(): void {
    this.decoder.reset();
    this.txSeqToHost = 1;
  }

  /** Registers a handler for RFSV32 command payloads arriving on the data channel. */
  onChannelData(listener: (payload: Uint8Array) => void): void {
    this.channelListener = listener;
  }

  /** Sends a reply payload back down the same NCP data channel the last command arrived on. */
  replyOnChannel(payload: Uint8Array): void {
    if (!this.lastChannelFrame) {
      throw new Error('replyOnChannel() called before any channel data was received');
    }
    const { dest, src, frameType } = this.lastChannelFrame;
    // Data frames are directional: reply with dest/src swapped, same frame type.
    this.sendDataPdu(encodeDataFrame(src, dest, frameType, payload));
  }

  handleFromHost(chunk: Uint8Array): void {
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
        if (header.seq === 1) this.sendReqCon();
        break;
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
      const ncpBody = Uint8Array.of(0x00, 7, NcpControlFrameType.ConnectResponse, frame.clientChannel, 0);
      this.sendDataPdu(ncpBody);
    } else if (frame.kind === 'data') {
      this.lastChannelFrame = { dest: frame.dest, src: frame.src, frameType: frame.frameType };
      this.receivedChannelData.push(frame.data);
      this.channelListener?.(frame.data);
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
export class FakeSerialPort {
  onconnect: ((this: this, ev: Event) => void) | null = null;
  ondisconnect: ((this: this, ev: Event) => void) | null = null;
  readonly connected = true;
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;

  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  constructor(private readonly peer: FakePsionPeer) {
    peer.attachHost(this);
  }

  async open(): Promise<void> {
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
    this.peer.onHostOpened();
  }

  pushToHost(bytes: Uint8Array): void {
    this.controller?.enqueue(bytes);
  }

  async setSignals(): Promise<void> {}

  async getSignals(): Promise<SerialInputSignals> {
    return { dataCarrierDetect: false, clearToSend: false, ringIndicator: false, dataSetReady: true };
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
}

export function stubSerial(requestPort: () => Promise<SerialPort>): void {
  Object.defineProperty(navigator, 'serial', {
    configurable: true,
    value: { requestPort, getPorts: async () => [] },
  });
}

export function unstubSerial(): void {
  delete (navigator as { serial?: unknown }).serial;
}
