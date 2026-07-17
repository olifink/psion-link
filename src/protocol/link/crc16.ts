/**
 * CRC-16/XMODEM: poly 0x1021, init 0x0000, no reflect, no xorout, MSB first.
 * Used by the PLP data link layer over Cont/Seq + Data, before byte-stuffing.
 */
export function crc16Xmodem(data: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
