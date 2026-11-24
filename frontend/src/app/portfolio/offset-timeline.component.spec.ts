import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OffsetTimelineComponent } from './offset-timeline.component';
import { RetirementRecord } from '@shared';

function makeRetirement(overrides: Partial<RetirementRecord> = {}): RetirementRecord {
  return {
    id: 'r1',
    credit_id: 'c1',
    buyer: 'GBUYER',
    tonnes_retired: '2000000', // 2 tonnes
    reason: 'VCS:offset',
    retired_at: 1700000000,
    tx_hash: 'abc123',
    vintage_year: 2022,
    ...overrides,
  };
}

describe('OffsetTimelineComponent', () => {
  let fixture: ComponentFixture<OffsetTimelineComponent>;
  let component: OffsetTimelineComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OffsetTimelineComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(OffsetTimelineComponent);
    component = fixture.componentInstance;
  });

  it('renders empty state when no retirements provided', () => {
    component.retirements = [];
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.empty-state')).toBeTruthy();
    expect(el.querySelector('.timeline-svg')).toBeFalsy();
  });

  it('renders chart SVG when retirements are provided', () => {
    component.retirements = [makeRetirement()];
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.timeline-svg')).toBeTruthy();
    expect(el.querySelector('.empty-state')).toBeFalsy();
  });

  it('groups retirements by vintage year into bar groups', () => {
    component.retirements = [
      makeRetirement({ vintage_year: 2021, tonnes_retired: '1000000' }),
      makeRetirement({ id: 'r2', credit_id: 'c2', vintage_year: 2022, tonnes_retired: '3000000' }),
      makeRetirement({ id: 'r3', credit_id: 'c3', vintage_year: 2021, tonnes_retired: '500000' }),
    ];
    fixture.detectChanges();
    const groups = component.groups();
    expect(groups.length).toBe(2);
    expect(groups[0].vintageYear).toBe(2021);
    expect(groups[1].vintageYear).toBe(2022);
  });

  it('calculates total tonnes per group correctly', () => {
    component.retirements = [
      makeRetirement({ vintage_year: 2021, tonnes_retired: '1000000' }), // 1 tonne
      makeRetirement({ id: 'r2', credit_id: 'c2', vintage_year: 2021, tonnes_retired: '2000000' }), // 2 tonnes
    ];
    fixture.detectChanges();
    const groups = component.groups();
    expect(groups.length).toBe(1);
    expect(groups[0].totalTonnes).toBeCloseTo(3, 1);
  });

  it('renders legend items for each methodology', () => {
    component.retirements = [
      makeRetirement({ reason: 'VCS:offset', vintage_year: 2022 }),
      makeRetirement({ id: 'r2', credit_id: 'c2', reason: 'REDD+:offset', vintage_year: 2023 }),
    ];
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const legendItems = el.querySelectorAll('.legend-item');
    expect(legendItems.length).toBeGreaterThanOrEqual(1);
  });

  it('shows tooltip on bar hover', () => {
    component.retirements = [makeRetirement()];
    fixture.detectChanges();
    const bar = fixture.nativeElement.querySelector('.bar-rect') as HTMLElement;
    expect(bar).toBeTruthy();
    bar.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    fixture.detectChanges();
    expect(component.tooltip()).not.toBeNull();
    expect(component.tooltip()!.vintageYear).toBe(2022);
  });

  it('clears tooltip on mouse leave', () => {
    component.retirements = [makeRetirement()];
    fixture.detectChanges();
    const bar = fixture.nativeElement.querySelector('.bar-rect') as HTMLElement;
    bar.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    fixture.detectChanges();
    const wrap = fixture.nativeElement.querySelector('.chart-wrap') as HTMLElement;
    wrap.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    fixture.detectChanges();
    expect(component.tooltip()).toBeNull();
  });

  it('renders accessible SVG with aria-label', () => {
    component.retirements = [makeRetirement()];
    fixture.detectChanges();
    const svg = fixture.nativeElement.querySelector('.timeline-svg') as SVGElement;
    expect(svg.getAttribute('aria-label')).toBeTruthy();
  });
});
