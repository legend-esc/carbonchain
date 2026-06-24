import { TestBed } from '@angular/core/testing';
import { StellarWalletService } from './stellar-wallet.service';

describe('StellarWalletService', () => {
  let service: StellarWalletService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(StellarWalletService);
  });

  afterEach(() => {
    // clean up any freighter mock
    delete (window as any).freighter;
  });

  it('creates the service', () => {
    expect(service).toBeTruthy();
  });

  it('starts in disconnected state', () => {
    expect(service.state()).toBe('disconnected');
    expect(service.isConnected()).toBe(false);
    expect(service.publicKey()).toBeNull();
  });

  it('isFreighterInstalled returns false when window.freighter is absent', () => {
    expect(service.isFreighterInstalled).toBe(false);
  });

  it('isFreighterInstalled returns true when window.freighter is present', () => {
    (window as any).freighter = {};
    expect(service.isFreighterInstalled).toBe(true);
  });

  it('connect() throws and sets error state when Freighter is not installed', async () => {
    await expect(service.connect()).rejects.toThrow('Freighter wallet extension is not installed');
    expect(service.state()).toBe('error');
  });

  it('connect() sets error state when Freighter reports not connected', async () => {
    (window as any).freighter = {
      isConnected: async () => false,
      getPublicKey: async () => 'GABC',
    };
    await expect(service.connect()).rejects.toThrow();
    expect(service.state()).toBe('error');
  });

  it('connect() sets connected state and returns public key', async () => {
    (window as any).freighter = {
      isConnected: async () => true,
      getPublicKey: async () => 'GABC123XYZ',
    };
    const key = await service.connect();
    expect(key).toBe('GABC123XYZ');
    expect(service.state()).toBe('connected');
    expect(service.publicKey()).toBe('GABC123XYZ');
    expect(service.isConnected()).toBe(true);
  });

  it('disconnect() resets state to disconnected', async () => {
    (window as any).freighter = {
      isConnected: async () => true,
      getPublicKey: async () => 'GABC123XYZ',
    };
    await service.connect();
    service.disconnect();
    expect(service.state()).toBe('disconnected');
    expect(service.publicKey()).toBeNull();
    expect(service.isConnected()).toBe(false);
  });

  it('signTransaction() throws when wallet is not connected', async () => {
    await expect(service.signTransaction('xdr-string')).rejects.toThrow('Wallet is not connected');
  });

  it('signTransaction() returns signed XDR when connected', async () => {
    (window as any).freighter = {
      isConnected: async () => true,
      getPublicKey: async () => 'GABC123',
      signTransaction: async (xdr: string) => `signed:${xdr}`,
    };
    await service.connect();
    const result = await service.signTransaction('raw-xdr', 'Test SDF Network ; September 2015');
    expect(result).toBe('signed:raw-xdr');
  });

  it('getNetworkDetails() throws when Freighter is not installed', async () => {
    await expect(service.getNetworkDetails()).rejects.toThrow(
      'Freighter wallet extension is not installed',
    );
  });

  it('getNetworkDetails() returns network info', async () => {
    (window as any).freighter = {
      getNetworkDetails: async () => ({
        network: 'TESTNET',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }),
    };
    const details = await service.getNetworkDetails();
    expect(details.network).toBe('TESTNET');
  });
});
