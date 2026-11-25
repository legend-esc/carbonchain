import { Injectable } from '@nestjs/common';

export interface DrawdownProjection {
  creditId: string;
  currentInventory: number;
  movingAverageVelocity: {
    days30: number; // tonnes/month
    days90: number;
    days180: number;
  };
  projectedDepletionMonths: {
    days30: { months: number; confidence: number };
    days90: { months: number; confidence: number };
    days180: { months: number; confidence: number };
  };
  projectionDate: Date;
}

/**
 * Issue #1291 — Credit retirement forecast and inventory drawdown projection.
 * Calculates moving average retirement velocity over 30, 90, 180 days.
 */
@Injectable()
export class DrawdownForecastService {
  /**
   * Calculate drawdown projection for a credit vintage.
   * Returns estimated months until depletion based on historical burn velocity.
   */
  calculateDrawdownProjection(
    creditId: string,
    currentInventory: number,
    retirementHistory: Array<{ date: Date; tonnesRetired: number }>,
  ): DrawdownProjection {
    const now = new Date();

    // Calculate moving averages for different windows
    const avg30 = this.calculateMovingAverage(retirementHistory, 30, now);
    const avg90 = this.calculateMovingAverage(retirementHistory, 90, now);
    const avg180 = this.calculateMovingAverage(retirementHistory, 180, now);

    // Project depletion timeline
    const projection30 =
      currentInventory > 0 && avg30 > 0
        ? { months: currentInventory / avg30, confidence: 0.85 }
        : { months: Infinity, confidence: 0 };

    const projection90 =
      currentInventory > 0 && avg90 > 0
        ? { months: currentInventory / avg90, confidence: 0.7 }
        : { months: Infinity, confidence: 0 };

    const projection180 =
      currentInventory > 0 && avg180 > 0
        ? { months: currentInventory / avg180, confidence: 0.65 }
        : { months: Infinity, confidence: 0 };

    return {
      creditId,
      currentInventory,
      movingAverageVelocity: {
        days30: avg30,
        days90: avg90,
        days180: avg180,
      },
      projectedDepletionMonths: {
        days30: projection30,
        days90: projection90,
        days180: projection180,
      },
      projectionDate: now,
    };
  }

  private calculateMovingAverage(
    history: Array<{ date: Date; tonnesRetired: number }>,
    windowDays: number,
    referenceDate: Date,
  ): number {
    const cutoffDate = new Date(referenceDate);
    cutoffDate.setDate(cutoffDate.getDate() - windowDays);

    const relevantRetirements = history
      .filter((r) => r.date >= cutoffDate && r.date <= referenceDate)
      .reduce((sum, r) => sum + r.tonnesRetired, 0);

    return relevantRetirements > 0
      ? relevantRetirements / (windowDays / 30)
      : 0;
  }
}
