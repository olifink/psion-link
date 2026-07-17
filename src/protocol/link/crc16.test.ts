import { describe, expect, test } from 'bun:test';
import { crc16Xmodem } from './crc16';

describe('crc16Xmodem', () => {
  test('matches the standard "123456789" check value', () => {
    const data = new TextEncoder().encode('123456789');
    expect(crc16Xmodem(data)).toBe(0x31c3);
  });

  test('empty input yields the init value', () => {
    expect(crc16Xmodem(new Uint8Array())).toBe(0x0000);
  });
});
