/** PLP spec §"Session Layer" / plptools `lib/ncp.h`: NCP control-frame types (sent on channel 0). */
export enum NcpControlFrameType {
  Xoff = 0x01,
  Xon = 0x02,
  Connect = 0x03,
  ConnectResponse = 0x04,
  ConnectionTermination = 0x05,
  NcpInformation = 0x06,
  Disconnection = 0x07,
  NcpTermination = 0x08,
}

/** PLP spec §"Data Frames": distinguishes a final fragment from a continuation. */
export enum NcpDataFrameType {
  Complete = 0x01,
  Partial = 0x02,
}

/** Control channel, always used for NCP's own housekeeping frames (PLP spec §"Channels"). */
export const CONTROL_CHANNEL = 0;

/** EPOC variant channel space (PLP spec §"Channels"); SIBO's 8-channel variant is out of scope per CLAUDE.md. */
export const MAX_CHANNELS = 256;

/**
 * Fragmentation chunk size for outgoing NCP Data frames. Not specified by
 * the prose spec (which only says the data link's frame size limits an
 * NCP message); 250 matches plptools' `NCP_SENDLEN` (lib/ncp.h), chosen to
 * leave headroom under the data link's 300-byte payload cap once the
 * 3-byte NCP header and the 1-2 byte Cont/Seq header are added.
 */
export const NCP_FRAGMENT_SIZE = 250;

/** PLP spec §"Connect Frame": "maximum length of the server name field is 16 characters, including the NUL terminator". */
export const MAX_SERVER_NAME_BYTES = 16;

/** BRIEF.md §4.3: NCP Information frame version for EPOC ER5 (Series 5/5mx/Revo/netBook 7). */
export const NCP_VERSION_EPOC_ER5 = 0x10;
