import { Injectable, signal } from '@angular/core';

const CONVERT_ON_TRANSFER_KEY = 'psion-link.convertOnTransfer';

/**
 * Standing user preferences, persisted to `localStorage`. Currently just
 * the "convert files on transfer" toggle (SPECSv3.md §6) — on by default;
 * revised from SPECSv3.md §10's original "off by default" once the
 * feature proved useful enough in practice to want on unprompted.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly _convertOnTransfer = signal(readStoredBoolean(CONVERT_ON_TRANSFER_KEY, true));
  readonly convertOnTransfer = this._convertOnTransfer.asReadonly();

  setConvertOnTransfer(value: boolean): void {
    this._convertOnTransfer.set(value);
    writeStoredBoolean(CONVERT_ON_TRANSFER_KEY, value);
  }

  toggleConvertOnTransfer(): void {
    this.setConvertOnTransfer(!this._convertOnTransfer());
  }
}

// `localStorage` access can fail for reasons beyond "doesn't exist" —
// Node's own experimental global throws without a --localstorage-file
// flag, real browsers can throw in private-browsing/quota-exceeded cases,
// and the Vitest/Angular unit-test environment doesn't expose
// `window.localStorage` at all. Falling back to in-memory-only behavior
// covers all of these uniformly, rather than trying to detect each case.

function readStoredBoolean(key: string, defaultValue: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? defaultValue : stored === '1';
  } catch {
    return defaultValue;
  }
}

function writeStoredBoolean(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Setting not persisted this session; readStoredBoolean() will fall back to the default again next time.
  }
}
