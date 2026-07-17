/**
 * Physical layer: thin wrapper over the WebSerial `SerialPort`.
 *
 * Owns baud negotiation (autobaud 115200 -> 57600 -> 38400 -> 19200 -> 9600),
 * 8N1 + hardware flow control, DTR/RTS assertion, and DSR polling to detect
 * a pulled cable. Exposes plain byte streams (`ReadableStream<Uint8Array>` /
 * `WritableStream<Uint8Array>`) upward to the link layer — no framing here.
 *
 * Framework-free: no `@angular/*` imports. See CLAUDE.md "Architecture".
 */
export { AUTOBAUD_RATES, PHYSICAL_SERIAL_OPTIONS } from './serial-options';
export { WebSerialTransport } from './webserial-transport';
export type { CableState, CableStateListener } from './webserial-transport';
