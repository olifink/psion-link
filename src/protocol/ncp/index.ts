/**
 * Session layer (NCP): channel multiplexing and fragmentation over the link
 * layer. Channel 0 = control (XOFF/XON/Connect/ConnectResponse/Disconnect/
 * NcpInfo/NcpTerminate), channel 1 = LINK server. Sends an NCP Information
 * frame (version 0x10, EPOC ER5) on connect, then connects to `SYS$RFSV.*`.
 *
 * Framework-free: no `@angular/*` imports. See CLAUDE.md "Architecture".
 */
export {};
