import { TestBed } from '@angular/core/testing';
import { TranslationService } from './translation.service';
import { TranslatePipe } from '../pipes/translate.pipe';

describe('TranslationService (#961)', () => {
  let service: TranslationService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
    service = TestBed.inject(TranslationService);
  });

  afterEach(() => localStorage.clear());

  it('returns the raw key when a translation is missing (never empty)', () => {
    expect(service.t('definitely.missing.key')).toBe('definitely.missing.key');
  });

  it('switches locale and persists the choice', () => {
    service.setLocale('fr');
    expect(service.locale()).toBe('fr');
    expect(localStorage.getItem('locale')).toBe('fr');
  });

  it('substitutes {placeholder} params', () => {
    (service as unknown as { translations: Record<string, string> }).translations = {
      'a.greeting': 'Hello {name}, you have {n} credits',
    };
    expect(service.t('a.greeting', { name: 'Ada', n: 3 })).toBe('Hello Ada, you have 3 credits');
  });

  it('leaves unknown placeholders untouched', () => {
    (service as unknown as { translations: Record<string, string> }).translations = {
      'a.greeting': 'Hello {name} from {city}',
    };
    expect(service.t('a.greeting', { name: 'Ada' })).toBe('Hello Ada from {city}');
  });
});

describe('TranslatePipe (#961)', () => {
  it('passes params through to the service', () => {
    localStorage.clear();
    TestBed.resetTestingModule();
    const service = TestBed.inject(TranslationService);
    (service as unknown as { translations: Record<string, string> }).translations = {
      'pipe.count': '{n} selected',
    };
    const pipe = TestBed.runInInjectionContext(() => new TranslatePipe());
    expect(pipe.transform('pipe.count', { n: 5 })).toBe('5 selected');
  });
});
