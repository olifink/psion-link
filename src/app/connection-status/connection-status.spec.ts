import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { FakePsionPeer, FakeSerialPort, stubSerial, unstubSerial } from '../testing/fake-psion-peer';
import { ConnectionStatus } from './connection-status';

describe('ConnectionStatus', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConnectionStatus],
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

    const fixture = TestBed.createComponent(ConnectionStatus);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const button = el.querySelector('button');
    expect(button?.textContent).toContain('Connect');

    button!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(el.textContent).toContain('Connected');
    expect(el.textContent).toContain('115200 baud');
  });

  it('shows the unsupported message when Web Serial is unavailable', () => {
    unstubSerial();
    const fixture = TestBed.createComponent(ConnectionStatus);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain("isn't available");
  });
});
