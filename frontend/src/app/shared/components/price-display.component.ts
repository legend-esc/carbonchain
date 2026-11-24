/**
 * Issue #1334 — PriceDisplayComponent
 *
 * Renders a formatted price that automatically updates when the user changes
 * their preferred currency via the global CurrencyStateService.
 *
 * Also provides the currency selector dropdown used in the app header so
 * every price on every page reformats in real-time.
 *
 * Usage (price only):
 *   <app-price-display [stroops]="offer.price_raw" />
 *
 * Usage (currency selector — typically in the header):
 *   <app-currency-selector />
 */
import { Component, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PricePipe } from '../pipes/price.pipe';
import {
  CurrencyStateService,
  SUPPORTED_CURRENCIES,
  SupportedCurrency,
} from '../services/currency-state.service';

// ---------------------------------------------------------------------------
// PriceDisplayComponent — renders one formatted price
// ---------------------------------------------------------------------------

@Component({
  selector: 'app-price-display',
  standalone: true,
  imports: [CommonModule, PricePipe],
  template: `<span class="price-display">{{ stroops | price }}</span>`,
  styles: [
    `
      .price-display {
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
})
export class PriceDisplayComponent {
  /** Raw stroop value from the API. */
  @Input({ required: true }) stroops!: string | number | null;
}

// ---------------------------------------------------------------------------
// CurrencySelectorComponent — the header dropdown
// ---------------------------------------------------------------------------

@Component({
  selector: 'app-currency-selector',
  standalone: true,
  imports: [CommonModule],
  template: `
    <label class="currency-selector__label" for="currency-select">
      <span class="sr-only">Display currency</span>
      <select
        id="currency-select"
        class="currency-selector__select"
        [value]="currencyState.currency()"
        (change)="onChange($event)"
        aria-label="Select display currency"
      >
        @for (c of currencies; track c) {
          <option [value]="c" [selected]="c === currencyState.currency()">{{ c }}</option>
        }
      </select>
    </label>
  `,
  styles: [
    `
      .currency-selector__label {
        display: flex;
        align-items: center;
      }

      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }

      .currency-selector__select {
        padding: 0.25rem 0.5rem;
        border-radius: 6px;
        border: 1px solid #d0d0d0;
        background: var(--surface, #fff);
        font-size: 0.85rem;
        cursor: pointer;
        color: inherit;
      }

      .currency-selector__select:focus-visible {
        outline: 3px solid #1565c0;
        outline-offset: 2px;
      }
    `,
  ],
})
export class CurrencySelectorComponent {
  protected readonly currencyState = inject(CurrencyStateService);
  protected readonly currencies = SUPPORTED_CURRENCIES;

  onChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as SupportedCurrency;
    this.currencyState.setCurrency(value);
  }
}
