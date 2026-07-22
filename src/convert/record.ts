import { EpocDocHeader, hex32, parseEpocDocHeader } from './epoc-doc';

/** Psion's built-in "Record" (voice memo) app's UID3 — matches `KNOWN_APP_UIDS['Record']` in file-browser.ts, sourced from real hardware. */
const RECORD_APP_UID3 = 0x1000007e;

/** The Record Section's identifier within the Section Table (psiconv: `52 00 00 10`). */
const RECORD_SECTION_ID = 0x10000052;

const CODEC_ALAW = 0x00000000;
/** psiconv: `A1 01 00 10` little-endian. */
const CODEC_ADPCM = 0x100001a1;

/**
 * psiconv's docs describe this only as "(about) 8.3 kHz" — not an exact
 * figure. Not yet confirmed against real hardware (no way to measure
 * pitch/duration without ears); treat as approximate until checked.
 */
export const SAMPLE_RATE_HZ = 8300;

export interface DecodedRecordAudio {
  sampleRate: number;
  /** 16-bit signed linear PCM samples, mono — decoded from the device's A-law-companded bytes (see `decodeAlaw`). */
  samples: Int16Array;
  /** 1 (minimum) to 5 (maximum), as recorded on the device. */
  volume: number;
  /** Number of times the device would play the sound, i.e. the stored "repeat minus one" field, plus one. */
  repeatCount: number;
  repeatDelayMs: number;
}

function u32le(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new RangeError(`truncated Record file: expected 4 bytes at offset ${offset}`);
  }
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function u16le(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) {
    throw new RangeError(`truncated Record file: expected 2 bytes at offset ${offset}`);
  }
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function findRecordSection(header: EpocDocHeader): number {
  if (header.uid3 !== RECORD_APP_UID3) {
    throw new Error(`not a Record file (UID3 is ${hex32(header.uid3)}, expected ${hex32(RECORD_APP_UID3)})`);
  }
  const offset = header.sections.get(RECORD_SECTION_ID);
  if (offset === undefined) {
    throw new Error('Record file has no Record Section');
  }
  return offset;
}

/**
 * Standard ITU-T G.711 A-law decode: one companded byte -> a linear PCM
 * value in roughly a 13-bit range. This is the international telephony
 * standard, not a Psion-specific algorithm — every A-law codec (sox,
 * ffmpeg, etc.) implements this exact bit-shuffle.
 *
 * Discovered empirically, not from psiconv's docs: psiconv describes
 * "standard" Record compression only as "(about) 8.3 kHz 8 bits sampling.
 * So each byte records a volume" — which reads like plain linear PCM, and
 * is what this module originally implemented. Treating a real recording's
 * bytes that way produced garbled, harsh, overly loud audio; a byte
 * histogram of the real file showed the exact "smooth 7-bit magnitude,
 * near-random top bit" signature A-law's sign+segment encoding produces
 * under a naive linear reading, and an independent source (Psion's `.wve`
 * sound format is documented elsewhere as "8-bit A-law audio") confirmed
 * it. Re-decoding with this function instead produces a proper 16-bit
 * waveform ~60x smoother sample-to-sample than the naive linear reading
 * (relative to full scale) — consistent with real, coherent audio.
 */
function alawByteToLinear(alaw: number): number {
  const a = alaw ^ 0x55;
  let magnitude = (a & 0x0f) << 4;
  const segment = (a & 0x70) >> 4;
  if (segment === 0) {
    magnitude += 8;
  } else if (segment === 1) {
    magnitude += 0x108;
  } else {
    magnitude += 0x108;
    magnitude <<= segment - 1;
  }
  return (a & 0x80) !== 0 ? magnitude : -magnitude;
}

function decodeAlaw(bytes: Uint8Array): Int16Array {
  const samples = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    samples[i] = alawByteToLinear(bytes[i]!);
  }
  return samples;
}

/**
 * Decodes a Psion Record (voice memo) file's audio. Header/section-table
 * field layout is per psiconv's `Record_File`/`Record_Section` docs
 * (copied verbatim, not reconstructed from memory); the audio codec
 * itself is A-law (see `alawByteToLinear`'s comment for how that was
 * established).
 */
export function decodeRecordFile(data: Uint8Array): DecodedRecordAudio {
  const header = parseEpocDocHeader(data);
  const section = findRecordSection(header);

  // Record Section layout (all offsets relative to `section`):
  //   0x00 L   uncompressed data length (unused — sound data is always
  //            stored one byte per sample regardless of codec; ADPCM's
  //            "compression" is in bits-per-sample, not a shorter buffer)
  //   0x04 ID  codec: 0x00000000 A-law, 0x100001A1 ADPCM
  //   0x08 W   repeat count minus one
  //   0x0A B   volume, 1 (min) - 5 (max)
  //   0x0B B   padding, always 0
  //   0x0C L   inter-repeat delay, in microseconds
  //   0x10 LListB sound data: 4-byte length (in bytes) + that many bytes
  const codec = u32le(data, section + 0x04);
  const repeatCountMinusOne = u16le(data, section + 0x08);
  const volume = data[section + 0x0a];
  if (volume === undefined) {
    throw new RangeError('truncated Record file: missing volume field');
  }
  const repeatDelayUs = u32le(data, section + 0x0c);
  const soundDataLength = u32le(data, section + 0x10);
  const soundDataStart = section + 0x14;
  if (soundDataStart + soundDataLength > data.length) {
    throw new RangeError('truncated Record file: sound data runs past the end of the file');
  }
  const soundData = data.subarray(soundDataStart, soundDataStart + soundDataLength);

  if (codec === CODEC_ADPCM) {
    throw new Error('ADPCM-compressed Record files are not yet supported');
  }
  if (codec !== CODEC_ALAW) {
    throw new Error(`unrecognized Record codec ${hex32(codec)}`);
  }

  return {
    sampleRate: SAMPLE_RATE_HZ,
    samples: decodeAlaw(soundData),
    volume,
    repeatCount: repeatCountMinusOne + 1,
    repeatDelayMs: repeatDelayUs / 1000,
  };
}

function writeAscii(buffer: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    buffer[offset + i] = text.charCodeAt(i);
  }
}

/** Encodes mono 16-bit signed PCM samples as a standard WAV file. WAV is a container, not a codec — no encoding step beyond the header. */
export function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * (bitsPerSample / 8);

  const buffer = new Uint8Array(44 + dataSize);
  const view = new DataView(buffer.buffer);

  writeAscii(buffer, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(buffer, 8, 'WAVE');

  writeAscii(buffer, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // AudioFormat: 1 = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  writeAscii(buffer, 36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, samples[i]!, true);
  }

  return buffer;
}

/** Converts a Psion Record file's bytes straight to a playable WAV file's bytes. */
export function recordToWav(data: Uint8Array): Uint8Array {
  const audio = decodeRecordFile(data);
  return encodeWav(audio.samples, audio.sampleRate);
}
