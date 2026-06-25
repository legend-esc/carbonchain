import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { signal } from '@angular/core';
import { OfflineComponent } from './offline.component';
import { OnlineStatusService } from '../core/services/online-status.service';

describe('OfflineComponent', () => {
  let fixture: ComponentFixture<OfflineComponent>;
  let component: OfflineComponent;
  let navigate: ReturnType<typeof vi.fn>;
  let online: ReturnType<typeof signal<boolean>>;

  beforeEach(async () => {
    navigate = vi.fn();
    online = signal(false);

    await TestBed.configureTestingModule({
      imports: [OfflineComponent],
      providers: [
        { provide: Router, useValue: { navigate } },
        { provide: OnlineStatusService, useValue: { online } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(OfflineComponent);
    component = fixture.componentInstance;
  });

  it('does not navigate away while still offline', () => {
    component.retry();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates to the dashboard once back online', () => {
    online.set(true);
    component.retry();
    expect(navigate).toHaveBeenCalledWith(['/dashboard']);
  });
});
