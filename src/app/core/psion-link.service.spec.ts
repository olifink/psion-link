import { TestBed } from '@angular/core/testing';
import { FakePsionPeer, FakeSerialPort, stubSerial, unstubSerial } from '../testing/fake-psion-peer';
import { PsionLinkService } from './psion-link.service';

describe('PsionLinkService', () => {
  afterEach(() => {
    unstubSerial();
  });

  it('reports unsupported when navigator.serial is absent', () => {
    unstubSerial();
    const service = TestBed.inject(PsionLinkService);
    expect(service.isSupported).toBe(false);
  });

  it('connects through a picked port and republishes state as it establishes', async () => {
    const peer = new FakePsionPeer();
    const port = new FakeSerialPort(peer);
    stubSerial(async () => port as unknown as SerialPort);

    const service = TestBed.inject(PsionLinkService);
    expect(service.connectionState()).toBe('disconnected');

    await service.connect();

    expect(service.connectionState()).toBe('connected');
    expect(service.isConnected()).toBe(true);
    expect(service.negotiatedBaudRate()).toBe(115200);
    expect(service.rfsv()).not.toBeNull();
    expect(service.lastError()).toBeNull();
  });

  it('leaves the service disconnected if the user dismisses the port picker', async () => {
    stubSerial(async () => {
      throw new DOMException('The user did not select a port.', 'NotFoundError');
    });

    const service = TestBed.inject(PsionLinkService);
    await expect(service.connect()).rejects.toThrow();

    expect(service.connectionState()).toBe('disconnected');
    expect(service.rfsv()).toBeNull();
  });

  it('disconnect() tears the session down and clears the RFSV client', async () => {
    const peer = new FakePsionPeer();
    const port = new FakeSerialPort(peer);
    stubSerial(async () => port as unknown as SerialPort);

    const service = TestBed.inject(PsionLinkService);
    await service.connect();
    expect(service.isConnected()).toBe(true);

    await service.disconnect();

    expect(service.connectionState()).toBe('disconnected');
    expect(service.rfsv()).toBeNull();
  });
});
