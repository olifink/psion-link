import { TestBed } from '@angular/core/testing';
import { SettingsService } from '../core/settings.service';
import { stubLocalStorage, unstubLocalStorage } from '../testing/fake-local-storage';
import { ConversionStatus } from './conversion-status';

describe('ConversionStatus', () => {
  beforeEach(() => {
    stubLocalStorage();
  });

  afterEach(() => {
    unstubLocalStorage();
  });

  it('shows off by default', () => {
    const fixture = TestBed.createComponent(ConversionStatus);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('off');
  });

  it('reflects the setting once turned on', () => {
    TestBed.inject(SettingsService).setConvertOnTransfer(true);

    const fixture = TestBed.createComponent(ConversionStatus);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('on');
  });
});
