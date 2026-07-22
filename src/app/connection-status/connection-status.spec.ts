import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { PsionLinkService } from '../core/psion-link.service';
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

  it('shows the negotiated baud once connected', async () => {
    const peer = new FakePsionPeer();
    const port = new FakeSerialPort(peer);
    stubSerial(async () => port as unknown as SerialPort);

    const psionLink = TestBed.inject(PsionLinkService);
    await psionLink.connect();

    const fixture = TestBed.createComponent(ConnectionStatus);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Connected');
    expect(text).toContain('115200 baud');
  });

  it('shows the unsupported message when Web Serial is unavailable', () => {
    unstubSerial();
    const fixture = TestBed.createComponent(ConnectionStatus);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain("isn't available");
  });
});
