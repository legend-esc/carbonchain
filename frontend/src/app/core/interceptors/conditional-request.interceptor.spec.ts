import { TestBed } from '@angular/core/testing';
import {
  HttpClient,
  HttpStatusCode,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { conditionalRequestInterceptor } from './conditional-request.interceptor';

describe('conditionalRequestInterceptor (Issue #966)', () => {
  let http: HttpClient;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([conditionalRequestInterceptor])),
        provideHttpClientTesting(),
      ],
    });

    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    controller.verify();
  });

  it('caches GET /api/portfolio responses and returns cached body on 304', () => {
    http.get('/api/portfolio').subscribe((body: any) => {
      expect(body).toEqual({ holdings: 5 });
    });

    const req1 = controller.expectOne('/api/portfolio');
    req1.flush({ holdings: 5 }, { headers: { ETag: '"abc"' } });

    http.get('/api/portfolio').subscribe((body: any) => {
      expect(body).toEqual({ holdings: 5 });
    });

    const req2 = controller.expectOne('/api/portfolio');
    expect(req2.request.headers.get('If-None-Match')).toBe('"abc"');
    req2.flush(null, { status: HttpStatusCode.NotModified, statusText: 'Not Modified' });
  });

  it('does not cache POST requests', () => {
    http.post('/api/portfolio', {}).subscribe();
    controller.expectOne('/api/portfolio').flush({}, { headers: { ETag: '"x"' } });

    http.get('/api/portfolio').subscribe();
    const req = controller.expectOne('/api/portfolio');
    expect(req.request.headers.get('If-None-Match')).toBeNull();
    req.flush({ ok: true });
  });

  it('does not cache non-cacheable endpoints', () => {
    http.get('/api/credits/ABC').subscribe();
    const req = controller.expectOne('/api/credits/ABC');
    req.flush({ ok: true }, { headers: { ETag: '"x"' } });

    http.get('/api/credits/ABC').subscribe();
    const req2 = controller.expectOne('/api/credits/ABC');
    expect(req2.request.headers.get('If-None-Match')).toBeNull();
    req2.flush({ ok: true });
  });
});
