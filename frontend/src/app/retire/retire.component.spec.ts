import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { RetireComponent } from './retire.component';
import { AuthService } from '../core/services/auth.service';

describe('RetireComponent', () => {
  let authSpy: jasmine.SpyObj<AuthService>;

  beforeEach(async () => {
    authSpy = jasmine.createSpyObj('AuthService', ['isAuthenticated', 'token']);
    authSpy.isAuthenticated.and.returnValue(true);
    authSpy.token.and.returnValue('fake-jwt');

    await TestBed.configureTestingModule({
      imports: [RetireComponent],
      providers: [
        provideHttpClient(),
        { provide: AuthService, useValue: authSpy },
      ],
    }).compileComponents();
  });

  it('starts on the form step', () => {
    const fixture = TestBed.createComponent(RetireComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('form.wizard-form')).toBeTruthy();
    expect(el.querySelector('.confirm-box')).toBeFalsy();
  });

  it('advances to confirm step on goConfirm()', () => {
    const fixture = TestBed.createComponent(RetireComponent);
    fixture.detectChanges();
    const comp = fixture.componentInstance as RetireComponent;

    (comp as any).goConfirm();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.confirm-box')).toBeTruthy();
    expect(el.querySelector('form.wizard-form')).toBeFalsy();
  });

  it('displays credit ID, tonnes and reason in the confirm box', () => {
    const fixture = TestBed.createComponent(RetireComponent);
    fixture.detectChanges();
    const comp = fixture.componentInstance as any;

    comp.creditId = 'abc123';
    comp.tonnes = 2_000_000;
    comp.reason = '2024 Scope 3';
    comp.goConfirm();
    fixture.detectChanges();

    const dl = (fixture.nativeElement as HTMLElement).querySelector('dl')!.textContent!;
    expect(dl).toContain('abc123');
    expect(dl).toContain('2024 Scope 3');
  });

  it('returns to form step when Back is clicked', () => {
    const fixture = TestBed.createComponent(RetireComponent);
    fixture.detectChanges();
    const comp = fixture.componentInstance as any;
    comp.goConfirm();
    fixture.detectChanges();

    const back = (fixture.nativeElement as HTMLElement)
      .querySelectorAll<HTMLButtonElement>('.actions button')[0];
    back.click();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('form.wizard-form')).toBeTruthy();
  });
});
