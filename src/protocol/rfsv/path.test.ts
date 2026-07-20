import { describe, expect, test } from 'bun:test';
import { driveRootPath, isDriveRoot, joinEpocPath, listPattern, parentPath, pathSegments } from './path';

describe('driveRootPath / listPattern / joinEpocPath', () => {
  test('driveRootPath appends the separator', () => {
    expect(driveRootPath('C:')).toBe('C:\\');
  });

  test('listPattern wildcards a directory (already-separated or not)', () => {
    expect(listPattern('C:\\')).toBe('C:\\*.*');
    expect(listPattern('C:\\DOCS')).toBe('C:\\DOCS\\*.*');
  });

  test('joinEpocPath appends a leaf name', () => {
    expect(joinEpocPath('C:\\DOCS', 'LETTER.TXT')).toBe('C:\\DOCS\\LETTER.TXT');
    expect(joinEpocPath('C:\\DOCS\\', 'LETTER.TXT')).toBe('C:\\DOCS\\LETTER.TXT');
  });
});

describe('isDriveRoot', () => {
  test('true only for a bare drive root', () => {
    expect(isDriveRoot('C:\\')).toBe(true);
    expect(isDriveRoot('C:\\DOCS\\')).toBe(false);
    expect(isDriveRoot('C:\\DOCS')).toBe(false);
  });
});

describe('parentPath', () => {
  test('steps up one directory level', () => {
    expect(parentPath('C:\\DOCS\\FOO\\')).toBe('C:\\DOCS\\');
  });

  test('a top-level directory\'s parent is the drive root', () => {
    expect(parentPath('C:\\DOCS\\')).toBe('C:\\');
  });

  test('the drive root is its own parent', () => {
    expect(parentPath('C:\\')).toBe('C:\\');
  });
});

describe('pathSegments', () => {
  test('breaks a path into breadcrumb segments from the drive down', () => {
    expect(pathSegments('C:\\DOCS\\FOO\\')).toEqual([
      { label: 'C:', path: 'C:\\' },
      { label: 'DOCS', path: 'C:\\DOCS\\' },
      { label: 'FOO', path: 'C:\\DOCS\\FOO\\' },
    ]);
  });

  test('a bare drive root has a single segment', () => {
    expect(pathSegments('C:\\')).toEqual([{ label: 'C:', path: 'C:\\' }]);
  });
});
