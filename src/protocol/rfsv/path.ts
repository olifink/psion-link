/**
 * EPOC path syntax helpers: drive letter + backslash-separated components
 * (e.g. `C:\DOCS\LETTER.TXT`), matching what `RFSV32_OPEN_DIR`'s pattern
 * argument and every other RFSV32 path argument expect (confirmed against
 * this project's own `client.test.ts` fixtures, e.g. `'C:\\*.*'` to list a
 * drive's root). Pure path-string manipulation — no wire I/O.
 */

function withTrailingSeparator(path: string): string {
  return path.endsWith('\\') ? path : `${path}\\`;
}

/** `"C:"` -> `"C:\"`. */
export function driveRootPath(letter: string): string {
  return withTrailingSeparator(letter);
}

/** `RFSV32_OPEN_DIR`'s wildcard pattern for listing everything directly under `dirPath`. */
export function listPattern(dirPath: string): string {
  return `${withTrailingSeparator(dirPath)}*.*`;
}

/** Appends a leaf `name` (no separators of its own) onto a directory path. */
export function joinEpocPath(dirPath: string, name: string): string {
  return `${withTrailingSeparator(dirPath)}${name}`;
}

export function isDriveRoot(dirPath: string): boolean {
  return /^[A-Za-z]:\\$/.test(dirPath);
}

/** The containing directory of `dirPath`; a drive root's parent is itself. */
export function parentPath(dirPath: string): string {
  const trimmed = dirPath.endsWith('\\') ? dirPath.slice(0, -1) : dirPath;
  const idx = trimmed.lastIndexOf('\\');
  if (idx <= 2) {
    const drive = /^([A-Za-z]:)/.exec(trimmed);
    return drive ? `${drive[1]}\\` : withTrailingSeparator(trimmed);
  }
  return `${trimmed.slice(0, idx)}\\`;
}

export interface PathSegment {
  /** The path component's own label, e.g. `"DOCS"` (or `"C:"` for the drive itself). */
  label: string;
  /** The full path up to and including this segment, e.g. `"C:\DOCS\"`. */
  path: string;
}

/** Breadcrumb segments for `dirPath`, from the drive root down. */
export function pathSegments(dirPath: string): PathSegment[] {
  const trimmed = dirPath.endsWith('\\') ? dirPath.slice(0, -1) : dirPath;
  const parts = trimmed.split('\\').filter((part) => part.length > 0);
  const segments: PathSegment[] = [];
  let running = '';
  for (const part of parts) {
    running = `${running}${part}\\`;
    segments.push({ label: part, path: running });
  }
  return segments;
}
