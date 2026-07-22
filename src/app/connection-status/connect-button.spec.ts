import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { FakePsionPeer, FakeSerialPort, stubSerial, unstubSerial } from '../testing/fake-psion-peer';
import { ConnectButton } from './connect-button';

describe('ConnectButton', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConnectButton],
      providers: [provideNoopAnimations()],
    }).compileComponents();
  });

  afterEach(() => {
    unstubSerial();
  });

  it('shows a Connect button when disconnected, and connects on click', async () => {
    const peer = new FakePsionPeer();
    const port = new FakeSerialPort(peer);
    stubSerial(async () => port as unknown as SerialPort);

    const fixture = TestBed.createComponent(ConnectButton);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const button = el.querySelector('button');
    expect(button?.textContent).toContain('Connect');

    button!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(el.textContent).toContain('Disconnect');
  });

  it('renders nothing when Web Serial is unavailable', () => {
    unstubSerial();
    const fixture = TestBed.createComponent(ConnectButton);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('button')).toBeNull();
  });
});
