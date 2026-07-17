import { describe, expect, test } from 'bun:test';
import { BatteryStatus, MediaType } from './constants';
import { parseVolumeReply } from './volume';

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

describe('parseVolumeReply', () => {
  test('parses every field at its documented offset', () => {
    const label = 'Internal Disk';
    const labelBytes = Array.from(new TextEncoder().encode(label));
    const bytes = Uint8Array.from([
      ...u32le(MediaType.FlashDisk), // 0
      ...u32le(BatteryStatus.Good), // 4
      ...u32le(0x11), // 8  drive attributes
      ...u32le(0x02), // 12 media attributes
      ...u32le(0x10000037), // 16 uid
      ...u32le(0x00500000), // 20 size low
      ...u32le(0x00000001), // 24 size high
      ...u32le(0x00100000), // 28 free low
      ...u32le(0x00000000), // 32 free high
      ...u32le(labelBytes.length), // 36 volume label length (4-byte field)
      ...labelBytes, // 40 volume label
    ]);

    const info = parseVolumeReply(bytes);

    expect(info.mediaType).toBe(MediaType.FlashDisk);
    expect(info.batteryStatus).toBe(BatteryStatus.Good);
    expect(info.driveAttributes).toBe(0x11);
    expect(info.mediaAttributes).toBe(0x02);
    expect(info.uid).toBe(0x10000037);
    expect(info.sizeBytes).toBe((1n << 32n) | 0x00500000n);
    expect(info.freeBytes).toBe(0x00100000n);
    expect(info.label).toBe(label);
  });

  test('an empty volume label decodes to an empty string', () => {
    const bytes = Uint8Array.from([
      ...u32le(MediaType.Rom),
      ...u32le(BatteryStatus.Dead),
      ...u32le(0),
      ...u32le(0),
      ...u32le(0),
      ...u32le(0),
      ...u32le(0),
      ...u32le(0),
      ...u32le(0),
      ...u32le(0), // label length = 0
    ]);
    expect(parseVolumeReply(bytes).label).toBe('');
  });
});
