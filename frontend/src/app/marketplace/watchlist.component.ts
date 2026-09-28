import { Component, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { Offer } from '@shared';
import { WatchlistStore, type WatchAlert } from '../../core/store/watchlist.store';

/**
 * Issue #958 — watchlist panel with client-side alerts.
 *
 * Entries are local (`WatchlistStore`, localStorage-backed). When the parent
 * marketplace loads listings it calls `evaluate()`, and anything at or below a
 * target price is surfaced here. No push, no email.
 */
@Component({
  selector: 'app-watchlist',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <section class="watchlist" aria-labelledby="watchlist-heading">
      <h2 id="watchlist-heading">Watchlist</h2>

      @if (watchlist.isEmpty()) {
        <p class="watchlist__empty">
          Nothing watched yet. Add a project or credit to get an alert when a listing
          hits your target price.
        </p>
      } @else {
        <!-- Issue #963: alerts are announced politely, not just drawn. -->
        <ul class="watchlist__alerts" aria-live="polite" aria-label="Watchlist alerts">
          @for (alert of watchlist.alerts(); track alert.offer.id) {
            <li class="alert-row">
              <button
                class="alert-row__link"
                type="button"
                (click)="alertSelected.emit(alert)"
              >
                <span class="alert-row__label">{{ alert.label }}</span>
                <span class="alert-row__price">
                  {{ formatPrice(priceOfAlert(alert)) }}
                  @if (alert.discount > 0) {
                    <span class="alert-row__discount">
                      {{ (alert.discount * 100).toFixed(0) }}% below target
                    </span>
                  }
                </span>
              </button>
            </li>
          } @empty {
            <li class="watchlist__no-alerts">No listings currently meet your targets.</li>
          }
        </ul>

        <ul class="watchlist__entries">
          @for (entry of watchlist.entries(); track entry.key) {
            <li class="entry">
              <span class="entry__label">{{ entry.label }}</span>

              <label class="entry__target">
                <span class="visually-hidden">Target price for {{ entry.label }}</span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  [value]="targetDraft(entry.key, entry.targetPrice)"
                  (change)="onTargetChange(entry.key, $event)"
                  placeholder="Target"
                  [attr.aria-label]="'Target price for ' + entry.label"
                />
              </label>

              <button
                class="btn btn-ghost"
                type="button"
                (click)="watchlist.unwatch(entry.key)"
                [attr.aria-label]="'Stop watching ' + entry.label"
              >
                Remove
              </button>
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: [
    `
      .watchlist {
        background: #f9f9f9;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        padding: 1rem 1.25rem;
        margin-bottom: 1.25rem;
      }
      h2 {
        margin: 0 0 0.75rem;
        font-size: 1rem;
        color: #1a1a1a;
      }
      .visually-hidden {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: -1px;
        padding: 0;
        overflow: hidden;
        clip: rect(0 0 0 0);
        clip-path: inset(50%);
        white-space: nowrap;
        border: 0;
      }
      .watchlist__empty,
      .watchlist__no-alerts {
        color: #595959;
        font-size: 0.85rem;
        margin: 0 0 0.5rem;
      }
      .watchlist__alerts,
      .watchlist__entries {
        list-style: none;
        margin: 0 0 0.75rem;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
      }
      .alert-row__link {
        display: flex;
        justify-content: space-between;
        gap: 0.75rem;
        width: 100%;
        text-align: left;
        background: #e8f5e9;
        border: 1px solid #a5d6a7;
        border-radius: 6px;
        padding: 0.5rem 0.75rem;
        cursor: pointer;
        font-size: 0.85rem;
        color: #1b5e20;
      }
      .alert-row__discount {
        font-weight: 600;
      }
      .entry {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.85rem;
      }
      .entry__label {
        flex: 1;
        color: #1a1a1a;
      }
      .entry__target input {
        width: 8rem;
        padding: 0.3rem 0.5rem;
        border: 1px solid #767676;
        border-radius: 4px;
        font-size: 0.85rem;
      }
      .entry__target input:focus-visible {
        outline: 3px solid #1565c0;
        outline-offset: 1px;
      }
      .btn {
        padding: 0.3rem 0.7rem;
        border-radius: 6px;
        cursor: pointer;
        font-size: 0.8rem;
        background: transparent;
        border: 1px solid #767676;
        color: #262626;
      }
      .btn:focus-visible {
        outline: 3px solid #1565c0;
        outline-offset: 2px;
      }
    `,
  ],
})
export class WatchlistComponent {
  readonly watchlist = inject(WatchlistStore);

  /** Emitted when the user activates an alert to jump to the matching listing. */
  readonly alertSelected = output<WatchAlert>();

  /** The currently loaded listings; re-evaluated on every change. */
  readonly offers = input<Offer[]>([]);

  /** Re-run the alert comparison whenever the listings change. */
  readonly matchedCount = computed(() => {
    const alerts = this.watchlist.evaluate(this.offers());
    return alerts.length;
  });

  /** Draft target price so a partially-typed number is not committed per keystroke. */
  readonly targetDrafts = signal<Record<string, string>>({});

  priceOfAlert(alert: WatchAlert): number {
    return Number(alert.offer.price_amount ?? alert.offer.price_xlm);
  }

  formatPrice(baseUnits: number): string {
    return (baseUnits / 10_000_000).toLocaleString(undefined, { maximumFractionDigits: 4 });
  }

  /**
   * Displayed target: the in-progress draft if the user has typed one, otherwise
   * the stored value. Drafts are only committed on `change`, so a partially
   * typed number is never persisted mid-keystroke.
   */
  targetDraft(key: string, stored: number | null): string {
    const drafts = this.targetDrafts();
    if (key in drafts) return drafts[key];
    return stored === null ? '' : String(stored);
  }

  onTargetChange(key: string, event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    this.targetDrafts.update((d) => ({ ...d, [key]: raw }));

    if (raw.trim() === '') {
      this.watchlist.setTargetPrice(key, null);
      return;
    }
    const parsed = Number(raw);
    this.watchlist.setTargetPrice(key, Number.isFinite(parsed) && parsed > 0 ? parsed : null);
  }
}
