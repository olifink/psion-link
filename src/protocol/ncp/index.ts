/**
 * Session layer (NCP): channel multiplexing and fragmentation over the link
 * layer. Channel 0 = control (XOFF/XON/Connect/ConnectResponse/Disconnect/
 * NcpInfo/NcpTerminate). Sends an NCP Information frame (version 0x10,
 * EPOC ER5) on connect, then connects to `SYS$RFSV.*` via `NcpSession`.
 *
 * Framework-free: no `@angular/*` imports. See CLAUDE.md "Architecture".
 */
export {
  NcpControlFrameType,
  NcpDataFrameType,
  CONTROL_CHANNEL,
  MAX_CHANNELS,
  NCP_FRAGMENT_SIZE,
  MAX_SERVER_NAME_BYTES,
  NCP_VERSION_EPOC_ER5,
} from './constants';
export {
  encodeNcpHeader,
  encodeConnectFrame,
  encodeNcpInfoFrame,
  encodeConnectionTerminationFrame,
  encodeNcpTerminationFrame,
  encodeDataFrame,
  decodeNcpFrame,
} from './frame';
export type { NcpHeader, DecodedNcpFrame } from './frame';
export { fragmentDataPayload, FrameReassembler } from './fragmentation';
export { NcpSession } from './session';
export type { NcpSessionOptions, NcpChannel } from './session';
