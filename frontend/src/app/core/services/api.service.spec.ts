import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApiService } from './api.service';

describe('ApiService — Certificate Download Methods', () => {
  let service: ApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ApiService,
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });

    service = TestBed.inject(ApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  describe('Method 1: downloadCertificate (GET /certificates/:id/download)', () => {
    it('should request certificate blob with bearer token authentication', () => {
      const certificateId = 'cert-abc-123';
      const token = 'mock-jwt-token';
      const mockBlob = new Blob(['%PDF-1.4 test certificate bytes'], { type: 'application/pdf' });

      let receivedBlob: Blob | undefined;
      service.downloadCertificate(certificateId, token).subscribe({
        next: (blob) => {
          receivedBlob = blob;
        },
      });

      const req = httpMock.expectOne(`/api/certificates/${certificateId}/download`);
      expect(req.request.method).toBe('GET');
      expect(req.request.headers.get('Authorization')).toBe(`Bearer ${token}`);
      expect(req.request.responseType).toBe('blob');

      req.flush(mockBlob);
      expect(receivedBlob).toEqual(mockBlob);
    });

    it('should propagate 404 error when certificate is not found', () => {
      const certificateId = 'nonexistent-cert';
      const token = 'mock-jwt-token';

      let errorResponse: unknown;
      service.downloadCertificate(certificateId, token).subscribe({
        next: () => fail('Should have failed with 404'),
        error: (err) => {
          errorResponse = err;
        },
      });

      const req = httpMock.expectOne(`/api/certificates/${certificateId}/download`);
      req.flush('Certificate not found', { status: 404, statusText: 'Not Found' });

      expect(errorResponse).toBeTruthy();
    });
  });

  describe('Method 2: downloadRetirementCertificate (GET /retirement/certificates/:id/download)', () => {
    it('should request retirement certificate blob with bearer token authentication', () => {
      const retirementId = 'ret-xyz-789';
      const token = 'mock-jwt-token';
      const mockBlob = new Blob(['%PDF-1.4 retirement certificate bytes'], { type: 'application/pdf' });

      let receivedBlob: Blob | undefined;
      service.downloadRetirementCertificate(retirementId, token).subscribe({
        next: (blob) => {
          receivedBlob = blob;
        },
      });

      const req = httpMock.expectOne(`/api/retirement/certificates/${retirementId}/download`);
      expect(req.request.method).toBe('GET');
      expect(req.request.headers.get('Authorization')).toBe(`Bearer ${token}`);
      expect(req.request.responseType).toBe('blob');

      req.flush(mockBlob);
      expect(receivedBlob).toEqual(mockBlob);
    });

    it('should propagate 401 error when token is invalid or missing', () => {
      const retirementId = 'ret-xyz-789';
      const invalidToken = 'expired-token';

      let errorResponse: unknown;
      service.downloadRetirementCertificate(retirementId, invalidToken).subscribe({
        next: () => fail('Should have failed with 401'),
        error: (err) => {
          errorResponse = err;
        },
      });

      const req = httpMock.expectOne(`/api/retirement/certificates/${retirementId}/download`);
      req.flush('Unauthorized', { status: 401, statusText: 'Unauthorized' });

      expect(errorResponse).toBeTruthy();
    });
  });
});
