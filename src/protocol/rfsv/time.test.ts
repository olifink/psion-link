import { describe, expect, test } from 'bun:test';
import { dateToEpocTime, epocTimeToDate } from './time';

describe('dateToEpocTime / epocTimeToDate', () => {
  test('round-trips a modern date to millisecond precision', () => {
    const date = new Date('2026-07-17T12:34:56.789Z');
    const { modifiedLow, modifiedHigh } = dateToEpocTime(date);
    const roundTripped = epocTimeToDate(modifiedLow, modifiedHigh);
    expect(roundTripped.getTime()).toBe(date.getTime());
  });

  test('the Unix epoch converts to the documented EPOCH_DIFF microsecond offset', () => {
    const { modifiedLow, modifiedHigh } = dateToEpocTime(new Date(0));
    const micros = (BigInt(modifiedHigh >>> 0) << 32n) | BigInt(modifiedLow >>> 0);
    expect(micros).toBe(0x00dcddb30f2f8000n);
  });

  test('round-trips a pre-1970 date (EPOC epoch starts at year 1)', () => {
    const date = new Date('1950-06-15T00:00:00.000Z');
    const { modifiedLow, modifiedHigh } = dateToEpocTime(date);
    expect(epocTimeToDate(modifiedLow, modifiedHigh).getTime()).toBe(date.getTime());
  });
});
