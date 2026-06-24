import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of, throwError } from 'rxjs';
import { ProjectDetailComponent } from './project-detail.component';
import { ApiService } from '../core/services/api.service';
import { CreditStatus } from '@shared';

const MOCK_PROJECT = {
  id: 'proj_1',
  name: 'Amazon REDD+',
  developer: 'EcoOrg',
  description: 'Protecting rainforest.',
  location: 'Brazil',
  methodology: 'REDD+',
  documents_cid: 'bafybeitest',
};

const MOCK_CREDIT = {
  id: 'cred_1',
  project_id: 'proj_1',
  issuer: 'GABC',
  vintage_year: 2024,
  methodology: 'REDD+',
  geography: 'BR',
  tonnes: '2000000',
  ipfs_hash: 'bafybei',
  status: CreditStatus.Active,
  issued_at: 1700000000,
};

describe('ProjectDetailComponent', () => {
  let fixture: ComponentFixture<ProjectDetailComponent>;
  let component: ProjectDetailComponent;
  let getProject: ReturnType<typeof vi.fn>;
  let listCreditsByProject: ReturnType<typeof vi.fn>;
  let getCredit: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    getProject = vi.fn().mockReturnValue(of(MOCK_PROJECT));
    listCreditsByProject = vi.fn().mockReturnValue(of(['cred_1']));
    getCredit = vi.fn().mockReturnValue(of(MOCK_CREDIT));

    await TestBed.configureTestingModule({
      imports: [ProjectDetailComponent],
      providers: [
        { provide: ApiService, useValue: { getProject, listCreditsByProject, getCredit } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'proj_1' } } } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ProjectDetailComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('should load and display project metadata', () => {
    expect(component.project()).toEqual(MOCK_PROJECT);
    expect(component.loading()).toBe(false);
    expect(component.error()).toBeNull();
  });

  it('should display project name in heading', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('h1')!.textContent).toContain('Amazon REDD+');
  });

  it('should render IPFS document link', () => {
    const el: HTMLElement = fixture.nativeElement;
    const link = el.querySelector('.ipfs-link') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.href).toContain('bafybeitest');
  });

  it('should load and display linked credits', () => {
    expect(component.credits().length).toBe(1);
    expect(component.credits()[0].id).toBe('cred_1');
  });

  it('should set error on project API failure', async () => {
    getProject.mockReturnValue(throwError(() => new Error('not found')));
    component['loading'].set(true);
    component['error'].set(null);
    component['project'].set(null);
    await component.ngOnInit();
    expect(component.error()).toBe('not found');
  });

  it('formatTonnes should convert correctly', () => {
    expect(component.formatTonnes('2000000')).toBe('2 t');
  });
});
