import { RfsvClient } from './client';
import { OPEN_READ_WRITE, OpenShareMode, OpenStreamType, RFSV_RECOMMENDED_TRANSFER_SIZE } from './constants';

const DOWNLOAD_MODE = OpenShareMode.ShareRead | OpenStreamType.Binary;
const UPLOAD_MODE = OpenShareMode.Exclusive | OpenStreamType.Binary | OPEN_READ_WRITE;

export interface TransferProgress {
  bytesTransferred: number;
  /** Best-known total; only a hint (e.g. from a directory listing taken moments earlier). */
  totalBytes: number;
}

export interface TransferOptions {
  /** Bytes per RFSV32_READ_FILE/WRITE_FILE call. Default: BRIEF.md's recommended 2048. */
  chunkSize?: number;
  onProgress?: (progress: TransferProgress) => void;
  signal?: AbortSignal;
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('transfer aborted', 'AbortError');
  }
}

/**
 * Downloads a whole file in `chunkSize` pieces, reporting progress after
 * each RFSV32_READ_FILE reply. A short (or empty) read ends the transfer —
 * EPOC's file read, unlike RFSV32_READ_DIR, signals EOF via a short read
 * rather than a distinct status code, so `RfsvClient.readFile`'s normal
 * throw-on-error `call()` wrapper is safe to use here as-is.
 */
export async function downloadFile(
  client: RfsvClient,
  path: string,
  totalBytes: number,
  options: TransferOptions = {},
): Promise<Uint8Array> {
  const chunkSize = options.chunkSize ?? RFSV_RECOMMENDED_TRANSFER_SIZE;
  const handle = await client.openFile(path, DOWNLOAD_MODE);
  try {
    const chunks: Uint8Array[] = [];
    let bytesTransferred = 0;
    options.onProgress?.({ bytesTransferred, totalBytes });
    for (;;) {
      checkAborted(options.signal);
      const chunk = await client.readFile(handle, chunkSize);
      if (chunk.length > 0) {
        chunks.push(chunk);
        bytesTransferred += chunk.length;
        options.onProgress?.({ bytesTransferred, totalBytes: Math.max(totalBytes, bytesTransferred) });
      }
      if (chunk.length < chunkSize) {
        break;
      }
    }
    return concatChunks(chunks, bytesTransferred);
  } finally {
    await client.closeHandle(handle).catch(() => {});
  }
}

/** Uploads a whole file in `chunkSize` pieces, reporting progress after each RFSV32_WRITE_FILE call. */
export async function uploadFile(
  client: RfsvClient,
  path: string,
  data: Uint8Array,
  options: TransferOptions = {},
): Promise<void> {
  const chunkSize = options.chunkSize ?? RFSV_RECOMMENDED_TRANSFER_SIZE;
  const handle = await client.createFile(path, UPLOAD_MODE);
  try {
    const totalBytes = data.length;
    let bytesTransferred = 0;
    options.onProgress?.({ bytesTransferred, totalBytes });
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      checkAborted(options.signal);
      const chunk = data.subarray(offset, offset + chunkSize);
      await client.writeFile(handle, chunk);
      bytesTransferred += chunk.length;
      options.onProgress?.({ bytesTransferred, totalBytes });
    }
  } finally {
    await client.closeHandle(handle).catch(() => {});
  }
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
