import { BatteryStatus, DriveAttribute, MediaAttribute, MediaType } from './constants';

const windows1252Decoder = new TextDecoder('windows-1252');

export interface VolumeInfo {
  mediaType: MediaType;
  batteryStatus: BatteryStatus;
  driveAttributes: number;
  mediaAttributes: number;
  uid: number;
  sizeBytes: bigint;
  freeBytes: bigint;
  label: string;
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function u64le(bytes: Uint8Array, lowOffset: number, highOffset: number): bigint {
  return (BigInt(u32le(bytes, highOffset)) << 32n) | BigInt(u32le(bytes, lowOffset));
}

/**
 * `RFSV32_VOLUME` reply field layout (PLP spec §"RFSV32_VOLUME"), offsets
 * confirmed against plptools' `RFSV32::devinfo` (lib/rfsv32.cc): MediaType
 * @0, BatteryStatus @4, DriveAttributes @8, MediaAttributes @12, UID @16,
 * SizeLow/High @20/24, FreeLow/High @28/32, VolumeLabelLength @36,
 * VolumeLabel @40. The spec calls out VolumeLabel as using the *4-byte*
 * length prefix (like `READ_DIR`'s LongName/ShortName), not the standard
 * 2-byte length + Unicode-flag-bit format most other RFSV32 strings use
 * — decoded here as Windows-1252 to match that same READ_DIR convention.
 */
export function parseVolumeReply(data: Uint8Array): VolumeInfo {
  const labelLength = u32le(data, 36);
  return {
    mediaType: u32le(data, 0) as MediaType,
    batteryStatus: u32le(data, 4) as BatteryStatus,
    driveAttributes: u32le(data, 8) as DriveAttribute,
    mediaAttributes: u32le(data, 12) as MediaAttribute,
    uid: u32le(data, 16),
    sizeBytes: u64le(data, 20, 24),
    freeBytes: u64le(data, 28, 32),
    label: windows1252Decoder.decode(data.subarray(40, 40 + labelLength)),
  };
}
