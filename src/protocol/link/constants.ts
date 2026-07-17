/** BRIEF.md §4.2: SYN=0x16, DLE=0x10, STX=0x02, ETX=0x03, EOT=0x04. */
export const SYN = 0x16;
export const DLE = 0x10;
export const STX = 0x02;
export const ETX = 0x03;
export const EOT = 0x04;

/** Cont nibble (high nibble of the first Cont/Seq byte). */
export enum PduType {
  Ack = 0,
  Disc = 1,
  Req = 2,
  Data = 3,
}
