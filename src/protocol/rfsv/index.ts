/**
 * Presentation layer: RFSV32 file service. Command
 * `[reason:u16][opId:u16][data]` / reply `[0x11:u16][opId:u16][status:i32][data]`,
 * `opId` a per-request nonce matched on reply. MVP command set (open/read
 * dir, open/create/read/write/close file, delete, rename, mkdir, rmdir,
 * path test, drive list, volume info) per BRIEF.md §4.4-5, cross-checked
 * against plptools' `lib/rfsv32.cc`.
 *
 * Framework-free: no `@angular/*` imports. See CLAUDE.md "Architecture".
 */
export {
  RfsvReason,
  RFSV_REPLY_MARKER,
  EpocStatus,
  FileAttribute,
  ATTR_GET_UID,
  OpenShareMode,
  OpenStreamType,
  OPEN_READ_WRITE,
  MediaType,
  BatteryStatus,
  DriveAttribute,
  MediaAttribute,
  RFSV_RECOMMENDED_TRANSFER_SIZE,
} from './constants';
export { encodeEpocString, decodeEpocString } from './strings';
export type { DecodedEpocString } from './strings';
export { epocTimeToDate, dateToEpocTime } from './time';
export type { EncodedEpocTime } from './time';
export { encodeRfsvCommand, decodeRfsvReply } from './frame';
export type { DecodedRfsvReply } from './frame';
export { parseReadDirEntries } from './readdir';
export type { RfsvDirEntry } from './readdir';
export { parseVolumeReply } from './volume';
export type { VolumeInfo } from './volume';
export { RfsvClient, RfsvError, RfsvDirHandle } from './client';
export type { DriveListEntry } from './client';
