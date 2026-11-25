import { Component, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

export type CalculatorProfile = 'individual' | 'smb';

// Standard transparent emission factors:
// - Grid electricity: 0.4 kg CO2e / kWh (0.0004 t)
// - Aviation: 250 kg CO2e / flight hour (0.25 t)
// - Road commute: 170 g CO2e / km (0.00017 t)
const ENERGY_FACTOR_T_PER_KWH = 0.0004;
const FLIGHT_FACTOR_T_PER_HR = 0.25;
const COMMUTE_FACTOR_T_PER_KM = 0.00017;

@Component({
  selector: 'app-carbon-calculator-widget',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './carbon-calculator-widget.component.html',
  styles: [
    `
      .calc-widget {
        background: var(--surface-bg, #ffffff);
        border: 1px solid var(--border-color, #e5e7eb);
        border-radius: 12px;
        padding: 1.25rem 1.5rem;
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
      }

      .calc-widget__header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
      }

      .calc-widget__title {
        margin: 0 0 0.25rem;
        font-size: 1.125rem;
        font-weight: 600;
      }

      .calc-widget__subtitle {
        margin: 0;
        font-size: 0.85rem;
        color: var(--text-muted, #6b7280);
      }

      .calc-widget__tabs {
        display: inline-flex;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        overflow: hidden;
      }

      .calc-tab {
        border: none;
        background: transparent;
        padding: 0.35rem 0.75rem;
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
        color: #4b5563;
      }

      .calc-tab--active {
        background: #1976d2;
        color: #ffffff;
      }

      .calc-sliders {
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }

      .calc-slider {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
      }

      .calc-slider__top {
        display: flex;
        justify-content: space-between;
        font-size: 0.875rem;
        font-weight: 600;
      }

      .calc-slider__val {
        color: #1976d2;
      }

      .calc-slider input[type='range'] {
        width: 100%;
        accent-color: #1976d2;
      }

      .calc-slider__sub {
        font-size: 0.78rem;
        color: var(--text-muted, #6b7280);
      }

      .calc-widget__footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
        padding-top: 0.75rem;
        border-top: 1px solid var(--border-color, #e5e7eb);
      }

      .calc-total {
        display: flex;
        flex-direction: column;
      }

      .calc-total__label {
        font-size: 0.75rem;
        text-transform: uppercase;
        font-weight: 600;
        color: var(--text-muted, #6b7280);
      }

      .calc-total__value {
        font-size: 1.5rem;
        font-weight: 700;
        color: #2e7d32;
      }

      .calc-retire-btn {
        padding: 0.6rem 1.15rem;
        border-radius: 8px;
        border: none;
        background: #2e7d32;
        color: #ffffff;
        font-weight: 600;
        font-size: 0.9rem;
        cursor: pointer;
        transition: background-color 0.15s ease;
      }

      .calc-retire-btn:hover {
        background: #1b5e20;
      }
    `,
  ],
})
export class CarbonCalculatorWidgetComponent {
  private readonly router = inject(Router);

  readonly showRetireButton = input<boolean>(true);
  readonly navigateOnRetire = input<boolean>(true);
  readonly retireOffset = output<number>();

  readonly profile = signal<CalculatorProfile>('individual');
  readonly homeEnergyKwh = signal<number>(450);
  readonly flightHoursYr = signal<number>(12);
  readonly commuteKmWk = signal<number>(120);

  readonly energyTonnes = computed(() => this.homeEnergyKwh() * 12 * ENERGY_FACTOR_T_PER_KWH);
  readonly flightsTonnes = computed(() => this.flightHoursYr() * FLIGHT_FACTOR_T_PER_HR);
  readonly commuteTonnes = computed(() => this.commuteKmWk() * 52 * COMMUTE_FACTOR_T_PER_KM);

  readonly totalTonnes = computed(
    () =>
      Math.round((this.energyTonnes() + this.flightsTonnes() + this.commuteTonnes()) * 100) / 100,
  );

  /** Rounded up to 0.1 tonne resolution (matching TONNES_SCALE = 1_000_000n). */
  readonly recommendedTonnes = computed(() =>
    Math.max(0.1, Math.ceil(this.totalTonnes() * 10) / 10),
  );

  setProfile(next: CalculatorProfile): void {
    this.profile.set(next);
    if (next === 'smb') {
      this.homeEnergyKwh.set(2500);
      this.flightHoursYr.set(60);
      this.commuteKmWk.set(800);
    } else {
      this.homeEnergyKwh.set(450);
      this.flightHoursYr.set(12);
      this.commuteKmWk.set(120);
    }
  }

  onRetireOffset(): void {
    const tonnes = this.recommendedTonnes();
    this.retireOffset.emit(tonnes);
    if (this.navigateOnRetire()) {
      void this.router.navigate(['/retire'], { queryParams: { tonnes } });
    }
  }
}
