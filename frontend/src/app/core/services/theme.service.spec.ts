import { TestBed } from '@angular/core/testing';
import { ThemeService } from './theme.service';

describe('ThemeService', () => {
  let service: ThemeService;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
    TestBed.configureTestingModule({});
    service = TestBed.inject(ThemeService);
  });

  it('should default to light mode when no preference stored', () => {
    expect(service.isDark()).toBe(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('should toggle to dark mode', () => {
    service.toggle();
    expect(service.isDark()).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('should toggle back to light mode', () => {
    service.toggle();
    service.toggle();
    expect(service.isDark()).toBe(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('should restore dark preference from localStorage', () => {
    localStorage.setItem('theme', 'dark');
    document.documentElement.classList.remove('dark');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const fresh = TestBed.inject(ThemeService);
    expect(fresh.isDark()).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('icon should be ☀️ in dark mode and 🌙 in light mode', () => {
    expect(service.icon()).toBe('🌙');
    service.toggle();
    expect(service.icon()).toBe('☀️');
  });
});
