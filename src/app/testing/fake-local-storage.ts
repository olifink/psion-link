/**
 * A minimal in-memory `Storage` stand-in. The Angular/Vitest unit-test
 * environment doesn't expose a working `window.localStorage` at all (not
 * merely absent — accessing it is fine, but there's nothing usable
 * behind it), so specs that need to verify real persistence (not just
 * `SettingsService`'s graceful in-memory fallback) install this instead.
 */
export class FakeLocalStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'clear'> {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

let original: PropertyDescriptor | undefined;

export function stubLocalStorage(): FakeLocalStorage {
  const fake = new FakeLocalStorage();
  original = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', { value: fake, configurable: true });
  return fake;
}

export function unstubLocalStorage(): void {
  if (original) {
    Object.defineProperty(window, 'localStorage', original);
    original = undefined;
  } else {
    delete (window as { localStorage?: unknown }).localStorage;
  }
}
