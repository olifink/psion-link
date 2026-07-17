import { crc16Xmodem } from './crc16';
import { DLE, EOT, ETX, STX, SYN } from './constants';

/**
 * Frame: SYN DLE STX <byte-stuffed Cont/Seq + Data> DLE ETX CRC-hi CRC-lo.
 * CRC-16/XMODEM is computed over the Cont/Seq + Data bytes *before*
 * stuffing. Byte stuffing: DLE -> DLE DLE always; ETX -> DLE EOT only in
 * the EPOC variant (SIBO sends ETX literally) — see BRIEF.md §4.2.
 *
 * Verified byte-for-byte against plptools' `DataLink::send` /
 * `DataLink::processInputData` (lib/datalink.cc).
 */
export interface FrameEncodeOptions {
  /** EPOC stuffs ETX as DLE EOT; SIBO does not. This project only speaks EPOC. */
  epoc: boolean;
}

export function encodeFrame(payload: Uint8Array, options: FrameEncodeOptions): Uint8Array {
  const out: number[] = [SYN, DLE, STX];
  for (const byte of payload) {
    if (byte === ETX) {
      if (options.epoc) {
        out.push(DLE, EOT);
      } else {
        out.push(ETX);
      }
    } else if (byte === DLE) {
      out.push(DLE, DLE);
    } else {
      out.push(byte);
    }
  }
  const crc = crc16Xmodem(payload);
  out.push(DLE, ETX, (crc >> 8) & 0xff, crc & 0xff);
  return Uint8Array.from(out);
}

export interface DecodedFrame {
  /** De-stuffed Cont/Seq + Data bytes. */
  payload: Uint8Array;
  /** Whether the trailing CRC matched the payload. */
  crcValid: boolean;
}

type SyncState = 'seekSyn' | 'seekDle' | 'seekStx';
type TrailerState = 'data' | 'crcHigh' | 'crcLow';

/**
 * Incremental frame decoder: feed it raw bytes as they arrive off the
 * serial port (in whatever chunk sizes WebSerial hands over) and it emits
 * complete frames as they're found, resyncing on SYN after any mismatch.
 *
 * Mirrors `DataLink::processInputData`'s state machine, with one
 * deliberate robustness addition: a SYN seen while expecting DLE/STX
 * restarts the sync search on that SYN rather than discarding it. This
 * only affects recovery from line noise, never a well-formed frame, so it
 * doesn't count as a wire-format divergence.
 */
export class FrameDecoder {
  private syncState: SyncState = 'seekSyn';
  private inPacket = false;
  private escaped = false;
  private trailerState: TrailerState = 'data';
  private payload: number[] = [];
  private crcHigh = 0;

  push(chunk: Uint8Array): DecodedFrame[] {
    const frames: DecodedFrame[] = [];
    for (const byte of chunk) {
      const frame = this.pushByte(byte);
      if (frame) {
        frames.push(frame);
      }
    }
    return frames;
  }

  reset(): void {
    this.syncState = 'seekSyn';
    this.inPacket = false;
    this.escaped = false;
    this.trailerState = 'data';
    this.payload = [];
    this.crcHigh = 0;
  }

  private pushByte(byte: number): DecodedFrame | null {
    if (!this.inPacket) {
      this.pushSyncByte(byte);
      return null;
    }
    return this.pushPacketByte(byte);
  }

  private pushSyncByte(byte: number): void {
    switch (this.syncState) {
      case 'seekSyn':
        if (byte === SYN) {
          this.syncState = 'seekDle';
        }
        break;
      case 'seekDle':
        if (byte === DLE) {
          this.syncState = 'seekStx';
        } else if (byte !== SYN) {
          this.syncState = 'seekSyn';
        }
        break;
      case 'seekStx':
        if (byte === STX) {
          this.inPacket = true;
          this.escaped = false;
          this.trailerState = 'data';
          this.payload = [];
          this.syncState = 'seekSyn';
        } else if (byte === SYN) {
          this.syncState = 'seekDle';
        } else {
          this.syncState = 'seekSyn';
        }
        break;
    }
  }

  private pushPacketByte(byte: number): DecodedFrame | null {
    if (this.trailerState === 'crcHigh') {
      this.crcHigh = byte;
      this.trailerState = 'crcLow';
      return null;
    }
    if (this.trailerState === 'crcLow') {
      const receivedCrc = (this.crcHigh << 8) | byte;
      const payload = Uint8Array.from(this.payload);
      const crcValid = crc16Xmodem(payload) === receivedCrc;
      this.inPacket = false;
      return { payload, crcValid };
    }

    // trailerState === 'data'
    if (this.escaped) {
      this.escaped = false;
      if (byte === ETX) {
        this.trailerState = 'crcHigh';
      } else if (byte === EOT) {
        this.payload.push(ETX);
      } else {
        // DLE DLE (or any unexpected DLE-escaped byte) -> literal byte.
        this.payload.push(byte);
      }
    } else if (byte === DLE) {
      this.escaped = true;
    } else {
      this.payload.push(byte);
    }
    return null;
  }
}
