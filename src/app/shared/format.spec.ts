import { formatBytes, formatDateTime } from './format';

describe('formatBytes', () => {
  it('formats zero and small byte counts plainly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('switches units at 1024-byte boundaries', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
  });

  it('accepts bigint sizes (RfsvDirEntry/VolumeInfo use bigint)', () => {
    expect(formatBytes(2048n)).toBe('2 KB');
  });

  it('falls back to an em dash for negative or non-finite input', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('formatDateTime', () => {
  it('renders a localized date and time', () => {
    const formatted = formatDateTime(new Date('2026-01-15T10:30:00Z'));
    expect(typeof formatted).toBe('string');
    expect(formatted.length).toBeGreaterThan(0);
  });
});
