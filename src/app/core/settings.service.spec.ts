import { TestBed } from '@angular/core/testing';
import { stubLocalStorage, unstubLocalStorage } from '../testing/fake-local-storage';
import { SettingsService } from './settings.service';

describe('SettingsService', () => {
  beforeEach(() => {
    stubLocalStorage();
  });

  afterEach(() => {
    unstubLocalStorage();
  });

  it('defaults convertOnTransfer to off', () => {
    const service = TestBed.inject(SettingsService);
    expect(service.convertOnTransfer()).toBe(false);
  });

  it('toggles and persists the setting', () => {
    const service = TestBed.inject(SettingsService);
    service.toggleConvertOnTransfer();
    expect(service.convertOnTransfer()).toBe(true);
    expect(window.localStorage.getItem('psion-link.convertOnTransfer')).toBe('1');

    service.toggleConvertOnTransfer();
    expect(service.convertOnTransfer()).toBe(false);
    expect(window.localStorage.getItem('psion-link.convertOnTransfer')).toBe('0');
  });

  it('a fresh instance reads the persisted value back', () => {
    TestBed.inject(SettingsService).setConvertOnTransfer(true);

    TestBed.resetTestingModule();
    const fresh = TestBed.inject(SettingsService);
    expect(fresh.convertOnTransfer()).toBe(true);
  });
});
