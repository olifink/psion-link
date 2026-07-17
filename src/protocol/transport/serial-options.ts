/** BRIEF.md §4.1: 8N1, hardware flow control, autobaud high-to-low. */
export const AUTOBAUD_RATES: readonly number[] = [115200, 57600, 38400, 19200, 9600];

export const PHYSICAL_SERIAL_OPTIONS: Omit<SerialOptions, 'baudRate'> = {
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'hardware',
};
