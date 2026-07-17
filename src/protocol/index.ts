/**
 * The framework-free protocol core (transport/link/ncp/rfsv, plus the
 * end-to-end wiring in connection.ts). No `@angular/*` imports anywhere
 * under this tree — see CLAUDE.md "Architecture". This barrel is the
 * intended import surface for the Angular `PsionLinkService` seam.
 */
export * from './transport';
export * from './link';
export * from './ncp';
export * from './rfsv';
export { PlpConnection } from './connection';
export type { PlpConnectionState, PlpConnectionOptions } from './connection';
