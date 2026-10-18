import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of, throwError } from 'rxjs';
import { signal } from '@angular/core';

import { CertificatesComponent } from './certificates.component';
import { ApiService } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';
import type { RetirementRecord } from '@shared';

describe('CertificatesComponent — PDF Blob Response Handling', () => {
  let fixture: ComponentFixture<CertificatesComponent>;
  let component: CertificatesComponent;

  const mockRetirementRecord: RetirementRecord = {
    id: 'RET-2024-001',
    credit_id: 'CRED-ABC-01',
    buyer: 'GABC1234567890STEL',
    tonnes_retired: '5000000',
    reason: 'Scope 1 company offset',
    retired_at: 1715000000,
    tx_hash: 'txhash_mock_123',
    certificate_ipfs_hash: 'bafybeicertificate123',
  };

  const actualPdfBuffer = new Uint8Array([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, // %PDF-1.4 header
    0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a,
  ]);
  const realPdfBlob = new Blob([actualPdfBuffer], { type: 'application/pdf' });

  let mockApiService: {
    getRetirement: ReturnType<typeof vi.fn>;
    downloadCertificate: ReturnType<typeof vi.fn>;
    verifyCertificate: ReturnType<typeof vi.fn>;
  };

  let mockAuthService: {
    token: ReturnType<typeof signal<string | null>>;
  };

  let createObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockApiService = {
      getRetirement: vi.fn().mockReturnValue(of(mockRetirementRecord)),
      downloadCertificate: vi.fn().mockReturnValue(of(realPdfBlob)),
      verifyCertificate: vi.fn(),
    };

    mockAuthService = {
      token: signal('jwt-token-xyz'),
    };

    createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:http://localhost/mock-pdf-uuid');
    revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    TestBed.configureTestingModule({
      imports: [CertificatesComponent],
      providers: [
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: {
                get: (key: string) => (key === 'id' ? mockRetirementRecord.id : null),
              },
            },
          },
        },
        { provide: ApiService, useValue: mockApiService },
        { provide: AuthService, useValue: mockAuthService },
      ],
    });

    fixture = TestBed.createComponent(CertificatesComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads retirement record and handles actual PDF blob for preview on init', async () => {
    fixture.detectChanges();
    await fixture.whenStable();

    expect(mockApiService.getRetirement).toHaveBeenCalledWith(mockRetirementRecord.id);
    expect(mockApiService.downloadCertificate).toHaveBeenCalledWith(
      mockRetirementRecord.id,
      'jwt-token-xyz',
    );

    expect(createObjectURLSpy).toHaveBeenCalledWith(expect.any(Blob));
    const passedBlob = createObjectURLSpy.mock.calls[0][0] as Blob;
    expect(passedBlob.type).toBe('application/pdf');
    expect(passedBlob.size).toBe(realPdfBlob.size);

    expect(component.pdfUrl()).toBe('blob:http://localhost/mock-pdf-uuid');
    expect(component.pdfLoading()).toBe(false);
    expect(component.pdfError()).toBeNull();
  });

  it('handles actual PDF blob download with synthetic anchor click and cleanup', async () => {
    component.record.set(mockRetirementRecord);

    const clickSpy = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const el = originalCreateElement(tagName);
      if (tagName.toLowerCase() === 'a') {
        el.click = clickSpy;
      }
      return el;
    });

    await component.download();

    expect(mockApiService.downloadCertificate).toHaveBeenCalledWith(
      mockRetirementRecord.id,
      'jwt-token-xyz',
    );
    expect(createObjectURLSpy).toHaveBeenCalledWith(expect.any(Blob));
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:http://localhost/mock-pdf-uuid');
    expect(component.downloading()).toBe(false);
  });

  it('handles PDF preview failure gracefully when blob fetch fails', async () => {
    mockApiService.downloadCertificate.mockReturnValueOnce(
      throwError(() => new Error('Network error loading blob')),
    );

    component.record.set(mockRetirementRecord);
    await component.loadPdfPreview();

    expect(component.pdfLoading()).toBe(false);
    expect(component.pdfUrl()).toBeNull();
    expect(component.pdfError()).toBe('PDF preview unavailable. You can still download the file.');
  });

  it('handles download failure gracefully when blob fetch fails', async () => {
    mockApiService.downloadCertificate.mockReturnValueOnce(
      throwError(() => new Error('Failed to download blob')),
    );

    component.record.set(mockRetirementRecord);
    await component.download();

    expect(component.downloading()).toBe(false);
    expect(component.error()).toBe('Download failed. Please try again.');
  });

  it('revokes any active blob URL on component destroy to prevent memory leaks', async () => {
    component.record.set(mockRetirementRecord);
    await component.loadPdfPreview();

    expect(createObjectURLSpy).toHaveBeenCalled();
    component.ngOnDestroy();
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:http://localhost/mock-pdf-uuid');
  });
});
