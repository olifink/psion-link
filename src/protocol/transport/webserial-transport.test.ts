import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { WebSerialTransport } from './webserial-transport';

class MockSerialPort extends EventTarget {
  onconnect: ((this: this, ev: Event) => void) | null = null;
  ondisconnect: ((this: this, ev: Event) => void) | null = null;
  readonly connected = true;
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;

  openCalls: SerialOptions[] = [];
  signalsHistory: SerialOutputSignals[] = [];
  closeCallCount = 0;

  private dsr = true;

  async open(options: SerialOptions): Promise<void> {
    this.openCalls.push(options);
  }

  async setSignals(signals: SerialOutputSignals): Promise<void> {
    this.signalsHistory.push(signals);
  }

  async getSignals(): Promise<SerialInputSignals> {
    return {
      dataCarrierDetect: false,
      clearToSend: false,
      ringIndicator: false,
      dataSetReady: this.dsr,
    };
  }

  getInfo(): SerialPortInfo {
    return {};
  }

  async close(): Promise<void> {
    this.closeCallCount++;
  }

  async forget(): Promise<void> {}

  setMockDsr(value: boolean): void {
    this.dsr = value;
  }
}

function createTransport() {
  const port = new MockSerialPort();
  const transport = new WebSerialTransport(port as unknown as SerialPort);
  return { port, transport };
}

describe('WebSerialTransport', () => {
  test('open() configures 8N1 + hardware flow control at the given baud', async () => {
    const { port, transport } = createTransport();
    await transport.open(19200);

    expect(port.openCalls).toEqual([
      { baudRate: 19200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'hardware' },
    ]);
    expect(transport.isOpen).toBe(true);
  });

  test('open() raises DTR and RTS', async () => {
    const { port, transport } = createTransport();
    await transport.open(115200);

    expect(port.signalsHistory).toEqual([{ dataTerminalReady: true, requestToSend: true }]);
  });

  test('open() throws if already open', async () => {
    const { transport } = createTransport();
    await transport.open(115200);

    await expect(transport.open(57600)).rejects.toThrow('already open');
  });

  test('close() is a no-op when not open', async () => {
    const { port, transport } = createTransport();
    await transport.close();

    expect(port.closeCallCount).toBe(0);
  });

  test('close() lowers DTR/RTS, closes the port, and resets isOpen', async () => {
    const { port, transport } = createTransport();
    await transport.open(115200);
    await transport.close();

    expect(port.signalsHistory[1]).toEqual({ dataTerminalReady: false, requestToSend: false });
    expect(port.closeCallCount).toBe(1);
    expect(transport.isOpen).toBe(false);
  });

  test('readable/writable pass through to the underlying port', () => {
    const { port, transport } = createTransport();
    const readable = new ReadableStream<Uint8Array>();
    const writable = new WritableStream<Uint8Array>();
    port.readable = readable;
    port.writable = writable;

    expect(transport.readable).toBe(readable);
    expect(transport.writable).toBe(writable);
  });

  test('getDsr() reflects the port signal state', async () => {
    const { port, transport } = createTransport();
    await transport.open(115200);

    port.setMockDsr(true);
    expect(await transport.getDsr()).toBe(true);

    port.setMockDsr(false);
    expect(await transport.getDsr()).toBe(false);
  });

  test('watchCable() throws before open()', () => {
    const { transport } = createTransport();
    expect(() => transport.watchCable()).toThrow('before open');
  });
});

describe('WebSerialTransport cable watching', () => {
  let port: MockSerialPort;
  let transport: WebSerialTransport;

  beforeEach(async () => {
    ({ port, transport } = createTransport());
    await transport.open(115200);
  });

  afterEach(() => {
    transport.stopWatchingCable();
  });

  test('notifies listeners on cable state change, not on repeats', async () => {
    const states: string[] = [];
    transport.onCableStateChange((state) => states.push(state));

    port.setMockDsr(true);
    transport.watchCable(5);
    await Bun.sleep(15);
    const countAfterFirst = states.length;
    expect(states[0]).toBe('present');
    expect(countAfterFirst).toBe(1);

    port.setMockDsr(false);
    await Bun.sleep(15);
    expect(states.at(-1)).toBe('pulled');
    expect(states.length).toBe(2);
  });

  test('stopWatchingCable() halts polling', async () => {
    const states: string[] = [];
    transport.onCableStateChange((state) => states.push(state));
    transport.watchCable(5);
    await Bun.sleep(10);
    transport.stopWatchingCable();
    const countAfterStop = states.length;

    port.setMockDsr(false);
    await Bun.sleep(15);
    expect(states.length).toBe(countAfterStop);
  });

  test('onCableStateChange() unsubscribe stops further notifications', async () => {
    const states: string[] = [];
    const unsubscribe = transport.onCableStateChange((state) => states.push(state));
    transport.watchCable(5);
    await Bun.sleep(10);
    unsubscribe();

    port.setMockDsr(false);
    await Bun.sleep(15);
    expect(states).toEqual(['present']);
  });
});
