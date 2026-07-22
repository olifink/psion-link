import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { SettingsService } from '../core/settings.service';
import { stubLocalStorage, unstubLocalStorage } from '../testing/fake-local-storage';
import { OverflowMenu } from './overflow-menu';

describe('OverflowMenu', () => {
  beforeEach(async () => {
    stubLocalStorage();
    await TestBed.configureTestingModule({
      imports: [OverflowMenu],
      providers: [provideNoopAnimations()],
    }).compileComponents();
  });

  afterEach(() => {
    unstubLocalStorage();
  });

  it('toggles the convert-on-transfer setting when clicked', () => {
    const fixture = TestBed.createComponent(OverflowMenu);
    fixture.detectChanges();
    const settings = TestBed.inject(SettingsService);
    expect(settings.convertOnTransfer()).toBe(false);

    const button = (fixture.nativeElement as HTMLElement).querySelector('button[matIconButton]') as HTMLElement;
    button.click();
    fixture.detectChanges();

    const menuItem = document.querySelector('.mat-mdc-menu-item') as HTMLElement;
    menuItem.click();
    fixture.detectChanges();

    expect(settings.convertOnTransfer()).toBe(true);
  });
});
