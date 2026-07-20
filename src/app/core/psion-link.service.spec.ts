import { TestBed } from '@angular/core/testing';
import {
  PduType,
  encodeContSeq,
  decodeContSeq,
  encodeFrame,
  FrameDecoder,
  NcpControlFrameType,
  decodeNcpFrame,
} from '../../protocol';
import { PsionLinkService } from './psion-link.service';

/**
 * The minimal fake Psion peer needed to drive a real handshake through
 * `PsionLinkService` -> `PlpConnection`, built from the project's own
 * tested encode/decode primitives rather than mocking at the service
 * boundary. Trimmed down from `src/protocol/connection.test.ts`'s
 * `FakePsionPeer` — this spec only needs the happy path, since autobaud/
 * cable-pull/etc. are already covered at the protocol-core layer.
 */
class FakePsionPeer {
  private host: FakeSerialPort | null = null;
  private decoder = new FrameDecoder();
  private txSeqToHost = 1;

  attachHost(host: FakeSerialPort): void {
    this.host = host;
  }

  onHostOpened(): void {
    this.decoder.reset();
    this.txSeqToHost = 1;
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

function stubSerial(requestPort: () => Promise<SerialPort>): void {
  Object.defineProperty(navigator, 'serial', {
    configurable: true,
    value: { requestPort, getPorts: async () => [] },
  });
}

function unstubSerial(): void {
  delete (navigator as { serial?: unknown }).serial;
}

describe('PsionLinkService', () => {
  afterEach(() => {
    unstubSerial();
  });

  it('reports unsupported when navigator.serial is absent', () => {
    unstubSerial();
    const service = TestBed.inject(PsionLinkService);
    expect(service.isSupported).toBe(false);
  });

  it('connects through a picked port and republishes state as it establishes', async () => {
    const peer = new FakePsionPeer();
    const port = new FakeSerialPort(peer);
    stubSerial(async () => port as unknown as SerialPort);

    const service = TestBed.inject(PsionLinkService);
    expect(service.connectionState()).toBe('disconnected');

    await service.connect();

    expect(service.connectionState()).toBe('connected');
    expect(service.isConnected()).toBe(true);
    expect(service.negotiatedBaudRate()).toBe(115200);
    expect(service.rfsv()).not.toBeNull();
    expect(service.lastError()).toBeNull();
  });

  it('leaves the service disconnected if the user dismisses the port picker', async () => {
    stubSerial(async () => {
      throw new DOMException('The user did not select a port.', 'NotFoundError');
    });

    const service = TestBed.inject(PsionLinkService);
    await expect(service.connect()).rejects.toThrow();

    expect(service.connectionState()).toBe('disconnected');
    expect(service.rfsv()).toBeNull();
  });

  it('disconnect() tears the session down and clears the RFSV client', async () => {
    const peer = new FakePsionPeer();
    const port = new FakeSerialPort(peer);
    stubSerial(async () => port as unknown as SerialPort);

    const service = TestBed.inject(PsionLinkService);
    await service.connect();
    expect(service.isConnected()).toBe(true);

    await service.disconnect();

    expect(service.connectionState()).toBe('disconnected');
    expect(service.rfsv()).toBeNull();
  });
});
