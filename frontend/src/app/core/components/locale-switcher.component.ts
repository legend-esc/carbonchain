import { Component, inject } from '@angular/core';
import { TranslationService, Locale } from '../services/translation.service';

@Component({
  selector: 'app-locale-switcher',
  standalone: true,
  template: `
    <div class="locale-switcher">
      @for (l of i18n.locales; track l.code) {
        <button
          class="locale-btn"
          [class.active]="i18n.locale() === l.code"
          (click)="i18n.setLocale(l.code)"
          [attr.aria-pressed]="i18n.locale() === l.code"
        >
          {{ l.label }}
        </button>
      }
    </div>
  `,
  styles: [
    `
      .locale-switcher {
        display: flex;
        gap: 0.25rem;
      }
      .locale-btn {
        background: none;
        border: 1px solid transparent;
        border-radius: 4px;
        color: #ccc;
        cursor: pointer;
        font-size: 0.8rem;
        padding: 0.2rem 0.4rem;
      }
      .locale-btn:hover {
        color: #fff;
      }
      .locale-btn.active {
        border-color: #ccc;
        color: #fff;
      }
    `,
  ],
})
export class LocaleSwitcherComponent {
  protected readonly i18n = inject(TranslationService);
}
