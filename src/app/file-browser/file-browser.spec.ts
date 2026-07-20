import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { EpocStatus, RfsvReason } from '../../protocol';
import { PsionLinkService } from '../core/psion-link.service';
import { FakePsionPeer, FakeSerialPort, stubSerial, unstubSerial } from '../testing/fake-psion-peer';
import { FileBrowser } from './file-browser';

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function encodeReply(opId: number, status: EpocStatus, data: number[] = []): Uint8Array {
  return Uint8Array.from([0x11, 0x00, opId & 0xff, (opId >> 8) & 0xff, ...u32le(status), ...data]);
}

function decodeCommand(payload: Uint8Array): { reason: number; opId: number } {
  return { reason: payload[0]! | (payload[1]! << 8), opId: payload[2]! | (payload[3]! << 8) };
}

/** Scripts the fake peer to answer GetDriveList (C: only) and an always-empty directory listing. */
function respondWithEmptyCDrive(peer: FakePsionPeer): void {
  peer.onChannelData((payload) => {
    const { reason, opId } = decodeCommand(payload);
    switch (reason) {
      case RfsvReason.GetDriveList: {
        const drives = new Array(26).fill(0);
        drives[2] = 1; // C:
        peer.replyOnChannel(encodeReply(opId, EpocStatus.None, drives));
        break;
      }
      case RfsvReason.OpenDir:
        peer.replyOnChannel(encodeReply(opId, EpocStatus.None, [1, 0, 0, 0])); // handle 1
        break;
      case RfsvReason.ReadDir:
        peer.replyOnChannel(encodeReply(opId, EpocStatus.Eof));
        break;
      case RfsvReason.CloseHandle:
        peer.replyOnChannel(encodeReply(opId, EpocStatus.None));
        break;
    }
  });
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: condition never became true');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('FileBrowser', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FileBrowser],
      providers: [provideNoopAnimations()],
    }).compileComponents();
  });

  afterEach(() => {
    unstubSerial();
  });

  it('shows the not-connected empty state', () => {
    const fixture = TestBed.createComponent(FileBrowser);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Connect a Psion');
  });

  it('lists an empty drive root once a device connects', async () => {
    const peer = new FakePsionPeer();
    const port = new FakeSerialPort(peer);
    stubSerial(async () => port as unknown as SerialPort);
    respondWithEmptyCDrive(peer);

    const psionLink = TestBed.inject(PsionLinkService);
    await psionLink.connect();

    const fixture = TestBed.createComponent(FileBrowser);
    fixture.detectChanges();

    // The breadcrumb nav only renders once `currentPath` is set, which happens
    // at the *end* of navigateTo() — unlike "This folder is empty.", which is
    // also true (vacuously) before any data has loaded.
    await waitFor(() => {
      fixture.detectChanges();
      return (fixture.nativeElement as HTMLElement).querySelector('.breadcrumbs')?.textContent?.includes('C:') ?? false;
    });

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('C:');
    expect(text).toContain('This folder is empty.');
  });
});
