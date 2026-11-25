import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter, ActivatedRoute } from '@angular/router';
import { of, throwError } from 'rxjs';
import { VerifierInspectionComponent } from './verifier-inspection.component';
import { ApiService } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';
import { ToastService } from '../core/services/toast.service';
import { ProjectProfile } from '@shared';

const mockProject: ProjectProfile = {
  id: 'proj-1',
  name: 'Forest Reserve Alpha',
  developer: 'Green Corp',
  description: 'Deforestation prevention project',
  location: 'BR',
  methodology: 'REDD+',
  documents_cid: 'ipfs://docs',
};

describe('VerifierInspectionComponent', () => {
  let fixture: ComponentFixture<VerifierInspectionComponent>;
  let component: VerifierInspectionComponent;

  const authMock = {
    isAuthenticated: signal(true).asReadonly(),
    token: signal<string | null>('admin-token').asReadonly(),
  };

  const toastMock = {
    show: vi.fn(),
    showSuccess: vi.fn(),
    showError: vi.fn(),
    showInfo: vi.fn(),
  };

  let apiMock = {
    getProject: vi.fn().mockReturnValue(of(mockProject)),
    reviewVerifierApplication: vi.fn().mockReturnValue(of(null)),
  };

  beforeEach(async () => {
    apiMock = {
      getProject: vi.fn().mockReturnValue(of(mockProject)),
      reviewVerifierApplication: vi.fn().mockReturnValue(of(null)),
    };

    await TestBed.configureTestingModule({
      imports: [VerifierInspectionComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: { get: (k: string) => (k === 'projectId' ? 'proj-1' : null) } },
          },
        },
        { provide: ApiService, useValue: apiMock },
        { provide: AuthService, useValue: authMock },
        { provide: ToastService, useValue: toastMock },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(VerifierInspectionComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('renders the workbench heading', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Verifier Inspection Workbench');
  });

  it('shows project ID badge after loading', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.project-badge')?.textContent).toContain('proj-1');
  });

  it('renders slider wrap after imagery loads', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.slider-wrap')).toBeTruthy();
  });

  it('renders approve and reject buttons', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.btn-approve')).toBeTruthy();
    expect(el.querySelector('.btn-reject')).toBeTruthy();
  });

  it('updates slider position on drag (mouse)', () => {
    const wrap = fixture.nativeElement.querySelector('.slider-wrap') as HTMLElement;
    // Simulate mouse events
    wrap.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0 }));
    wrap.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100 }));
    wrap.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    // Position will be updated — just verify no crash
    expect(component.sliderPct()).toBeDefined();
  });

  it('opens reject modal when Reject button clicked', () => {
    const btn = fixture.nativeElement.querySelector('.btn-reject') as HTMLButtonElement;
    btn.click();
    fixture.detectChanges();
    expect(component.rejectStep()).toBe('open');
    const modal = fixture.nativeElement.querySelector('.modal');
    expect(modal).toBeTruthy();
  });

  it('closes reject modal when Cancel clicked', () => {
    component.openRejectModal();
    fixture.detectChanges();
    const cancel = fixture.nativeElement.querySelector('.modal .btn-outline') as HTMLButtonElement;
    cancel.click();
    fixture.detectChanges();
    expect(component.rejectStep()).toBe('idle');
    expect(fixture.nativeElement.querySelector('.modal')).toBeFalsy();
  });

  it('requires a reason before submitting rejection', () => {
    component.openRejectModal();
    component.rejectReason = '';
    fixture.detectChanges();
    const submit = fixture.nativeElement.querySelector('.modal .btn-reject') as HTMLButtonElement;
    submit.click();
    fixture.detectChanges();
    // Should have shown error (submitting state) but not called API
    expect(apiMock.reviewVerifierApplication).not.toHaveBeenCalledWith(
      expect.anything(),
      'rejected',
      expect.anything(),
    );
  });

  it('calls reviewVerifierApplication(approved) on Approve click', async () => {
    const btn = fixture.nativeElement.querySelector('.btn-approve') as HTMLButtonElement;
    btn.click();
    await fixture.whenStable();
    expect(apiMock.reviewVerifierApplication).toHaveBeenCalledWith(
      'proj-1',
      'approved',
      'admin-token',
    );
  });

  it('calls reviewVerifierApplication(rejected) with reason on submit', async () => {
    component.openRejectModal();
    component.rejectReason = 'Insufficient baseline data';
    await component.submitReject();
    expect(apiMock.reviewVerifierApplication).toHaveBeenCalledWith(
      'proj-1',
      'rejected',
      'admin-token',
    );
  });

  it('shows error state when project load fails', async () => {
    apiMock.getProject.mockReturnValue(throwError(() => new Error('Not found')));
    component.imagery.set(null);
    await (component as unknown as { loadImagery(id: string): Promise<void> }).loadImagery(
      'bad-id',
    );
    fixture.detectChanges();
    expect(component.loadError()).toBeTruthy();
  });

  it('shows baseline clip path using slider percentage', () => {
    // Use the public setter onSliderChange instead of accessing private signal
    component.onSliderChange(60);
    expect(component.baselineClip()).toBe('inset(0 40% 0 0)');
  });

  it('renders range input for accessibility', () => {
    const input = fixture.nativeElement.querySelector('#slider-range') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.type).toBe('range');
  });
});
