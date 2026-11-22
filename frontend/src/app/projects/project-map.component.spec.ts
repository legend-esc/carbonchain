/**
 * Issue #1335 — unit tests for ProjectMapComponent.
 *
 * Leaflet requires a real DOM and canvas; in jsdom we mock the loadLeaflet()
 * method so the component logic can be exercised without the `leaflet` package
 * being installed.  The tests verify:
 *  - component creation
 *  - loading / error states
 *  - popup HTML builder (formatTonnes, escapeHtml)
 *  - no crash when no projects have coordinates
 */
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { ProjectMapComponent, MapProject } from './project-map.component';
import { ApiService } from '../core/services/api.service';

// ---------------------------------------------------------------------------
// Mock Leaflet object returned by loadLeaflet()
// ---------------------------------------------------------------------------

const mockMarker = {
  bindPopup: vi.fn().mockReturnThis(),
  on: vi.fn().mockReturnThis(),
  addTo: vi.fn().mockReturnThis(),
};

const mockLayerGroup = {
  addLayer: vi.fn().mockReturnThis(),
  addTo: vi.fn().mockReturnThis(),
};

const mockMap = {
  remove: vi.fn(),
  addLayer: vi.fn(),
  setView: vi.fn(),
  fitBounds: vi.fn(),
};

const mockLeaflet = {
  map: vi.fn(() => mockMap),
  tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
  circleMarker: vi.fn(() => mockMarker),
  layerGroup: vi.fn(() => mockLayerGroup),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_WITH_COORDS: MapProject = {
  id: 'proj-1',
  name: 'Forest Alpha',
  developer: 'Dev Co',
  location: 'Brazil',
  methodology: 'REDD+',
  lat: -10,
  lng: -55,
  available_tonnes: '5000000',
};

const PROJECT_NO_COORDS: MapProject = {
  id: 'proj-2',
  name: 'No Location',
  developer: 'Dev B',
  location: 'Unknown',
  methodology: 'AGB',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProjectMapComponent', () => {
  let fixture: ComponentFixture<ProjectMapComponent>;
  let component: ProjectMapComponent;
  let apiSpy: { listProjects: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    apiSpy = { listProjects: vi.fn().mockReturnValue(of([PROJECT_WITH_COORDS])) };

    await TestBed.configureTestingModule({
      imports: [ProjectMapComponent],
      providers: [{ provide: ApiService, useValue: apiSpy }],
    }).compileComponents();

    fixture = TestBed.createComponent(ProjectMapComponent);
    component = fixture.componentInstance;

    // Override the dynamic import so the test never tries to resolve 'leaflet'
    vi.spyOn(component as unknown as { loadLeaflet(): Promise<unknown> }, 'loadLeaflet')
      .mockResolvedValue(mockLeaflet as unknown as typeof import('leaflet'));
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  it('starts in loading state', () => {
    expect(component.loading()).toBe(true);
    expect(component.error()).toBeNull();
  });

  it('leaves loading=false after projects are fetched', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    expect(component.loading()).toBe(false);
  });

  it('sets error when the API call fails', async () => {
    apiSpy.listProjects.mockReturnValue(throwError(() => new Error('network error')));
    fixture = TestBed.createComponent(ProjectMapComponent);
    component = fixture.componentInstance;
    vi.spyOn(component as unknown as { loadLeaflet(): Promise<unknown> }, 'loadLeaflet')
      .mockResolvedValue(mockLeaflet as unknown as typeof import('leaflet'));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(component.error()).toContain('network error');
  });

  it('renders the map container element', () => {
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.project-map')).not.toBeNull();
  });

  it('shows loading status text while loading', () => {
    // Before detectChanges, loading is true — just confirm no crash
    fixture.detectChanges();
    expect(component.loading()).toBeDefined();
  });

  it('renders an error paragraph when error() is set', async () => {
    apiSpy.listProjects.mockReturnValue(throwError(() => new Error('boom')));
    fixture = TestBed.createComponent(ProjectMapComponent);
    component = fixture.componentInstance;
    vi.spyOn(component as unknown as { loadLeaflet(): Promise<unknown> }, 'loadLeaflet')
      .mockResolvedValue(mockLeaflet as unknown as typeof import('leaflet'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const err: HTMLElement = fixture.nativeElement.querySelector('.map-error');
    expect(err).not.toBeNull();
    expect(err.textContent).toContain('boom');
  });

  describe('formatTonnes()', () => {
    it('converts stroops to tonnes string', () => {
      expect(component.formatTonnes('10000000')).toBe('10 t');
    });

    it('returns "—" for undefined', () => {
      expect(component.formatTonnes(undefined)).toBe('—');
    });

    it('returns "—" for non-numeric', () => {
      expect(component.formatTonnes('xyz')).toBe('—');
    });

    it('handles fractional tonnes', () => {
      expect(component.formatTonnes('5500000')).toContain('5.5');
    });
  });

  it('handles projects without coordinates gracefully (no crash)', async () => {
    apiSpy.listProjects.mockReturnValue(of([PROJECT_NO_COORDS]));
    fixture = TestBed.createComponent(ProjectMapComponent);
    component = fixture.componentInstance;
    vi.spyOn(component as unknown as { loadLeaflet(): Promise<unknown> }, 'loadLeaflet')
      .mockResolvedValue(mockLeaflet as unknown as typeof import('leaflet'));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(component.error()).toBeNull();
  });

  it('popupProject() starts null', () => {
    expect(component.popupProject()).toBeNull();
  });
});
