/**
 * PLP spec: "Modified low and Modified high fields combine to form a 64
 * bit modification date, specified as the number of micro-seconds since
 * 00:00 on 1st January 1." (the EPOC epoch).
 *
 * `EPOCH_DIFF_MICROS` (EPOC epoch -> Unix epoch, in microseconds) is
 * plptools' `EPOCH_DIFF` (lib/psitime.cc). plptools additionally corrects
 * for the Psion's own on-device timezone setting relative to UTC
 * (`PsiTime::psi2unix`'s `evalOffset` call) — that requires porting a
 * timezone-database emulation layer and is not implemented here, so
 * `epocTimeToDate`/`dateToEpocTime` treat the on-wire value as already
 * UTC. Timestamps will be off by the device's configured UTC offset until
 * this is added.
 */
const EPOCH_DIFF_MICROS = 0x00dcddb30f2f8000n;

export function epocTimeToDate(modifiedLow: number, modifiedHigh: number): Date {
  const micros = ((BigInt(modifiedHigh >>> 0) << 32n) | BigInt(modifiedLow >>> 0)) - EPOCH_DIFF_MICROS;
  return new Date(Number(micros / 1000n));
}

export interface EncodedEpocTime {
  modifiedLow: number;
  modifiedHigh: number;
}

export function dateToEpocTime(date: Date): EncodedEpocTime {
  const micros = BigInt(date.getTime()) * 1000n + EPOCH_DIFF_MICROS;
  return {
    modifiedLow: Number(micros & 0xffffffffn),
    modifiedHigh: Number((micros >> 32n) & 0xffffffffn),
  };
}
