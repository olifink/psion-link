/** Binary-unit byte formatting (KB/MB matching Explorer/PsiWin-era convention, not decimal SI). */
export function formatBytes(bytes: number | bigint): string {
  const n = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  if (!Number.isFinite(n) || n < 0) {
    return '—';
  }
  if (n === 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const value = n / 1024 ** exponent;
  const rounded = Math.round(value * 10) / 10;
  const precision = exponent === 0 || Number.isInteger(rounded) ? 0 : 1;
  return `${rounded.toFixed(precision)} ${units[exponent]}`;
}

export function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
