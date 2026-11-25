import { Injectable, BadRequestException } from '@nestjs/common';

/** DEFRA / GHG-Protocol emission factors (kgCO2e per unit) */
const EMISSION_FACTORS = {
  // Flights — DEFRA 2023 (economy class, radiative forcing included)
  flight_short_haul_km: 0.000255, // <3700 km
  flight_long_haul_km: 0.000195, // ≥3700 km

  // Ground travel
  car_petrol_km: 0.00017, // average petrol car
  car_diesel_km: 0.000156, // average diesel car
  train_km: 0.0000037, // UK national rail average

  // Energy — DEFRA / EPA
  electricity_kwh: 0.000233, // UK grid average 2023 (tCO2e/kWh)
  natural_gas_kwh: 0.000203,

  // Data-centre / cloud
  data_center_kwh: 0.000000475, // AWS global average PUE 1.2 × 0.000396 tCO2e/kWh
  server_hour: 0.0000000988, // 400 W typical server × data_center factor
} as const;

export type ActivityType =
  | 'flight_short_haul'
  | 'flight_long_haul'
  | 'car_petrol'
  | 'car_diesel'
  | 'train'
  | 'electricity'
  | 'natural_gas'
  | 'data_center_kwh'
  | 'server_hours';

export interface ActivityInput {
  type: ActivityType;
  /** Quantity in the unit associated with the activity type */
  quantity: number;
  /** Optional: distance in km (required for flight/ground-travel types) */
  unit?: string;
}

export interface EstimateResult {
  activities: Array<{
    type: ActivityType;
    quantity: number;
    tonnes_co2e: number;
    factor_used: number;
    factor_source: string;
  }>;
  total_tonnes_co2e: number;
  recommended_credits: number;
  methodology: string;
}

@Injectable()
export class CalculatorService {
  estimate(activities: ActivityInput[]): EstimateResult {
    if (!activities || activities.length === 0) {
      throw new BadRequestException('At least one activity is required');
    }

    const results: EstimateResult['activities'] = [];

    for (const activity of activities) {
      if (activity.quantity == null || typeof activity.quantity !== 'number') {
        throw new BadRequestException(
          `Activity "${activity.type}" is missing a numeric quantity`,
        );
      }
      if (activity.quantity < 0) {
        throw new BadRequestException(
          `Quantity for "${activity.type}" must be non-negative`,
        );
      }
      if (activity.quantity > 1_000_000_000) {
        throw new BadRequestException(
          `Quantity for "${activity.type}" exceeds maximum allowed value (1,000,000,000)`,
        );
      }

      let factor: number;
      let source: string;

      switch (activity.type) {
        case 'flight_short_haul':
          factor = EMISSION_FACTORS.flight_short_haul_km;
          source = 'DEFRA 2023 — short-haul economy (radiative forcing)';
          break;
        case 'flight_long_haul':
          factor = EMISSION_FACTORS.flight_long_haul_km;
          source = 'DEFRA 2023 — long-haul economy (radiative forcing)';
          break;
        case 'car_petrol':
          factor = EMISSION_FACTORS.car_petrol_km;
          source = 'DEFRA 2023 — average petrol car';
          break;
        case 'car_diesel':
          factor = EMISSION_FACTORS.car_diesel_km;
          source = 'DEFRA 2023 — average diesel car';
          break;
        case 'train':
          factor = EMISSION_FACTORS.train_km;
          source = 'DEFRA 2023 — national rail';
          break;
        case 'electricity':
          factor = EMISSION_FACTORS.electricity_kwh;
          source = 'DEFRA 2023 — UK grid average';
          break;
        case 'natural_gas':
          factor = EMISSION_FACTORS.natural_gas_kwh;
          source = 'DEFRA 2023 — natural gas combustion';
          break;
        case 'data_center_kwh':
          factor = EMISSION_FACTORS.data_center_kwh;
          source = 'GHG Protocol / AWS — data-centre kWh (PUE 1.2)';
          break;
        case 'server_hours':
          factor = EMISSION_FACTORS.server_hour;
          source = 'GHG Protocol — 400 W server × data-centre factor';
          break;
        default:
          throw new BadRequestException(
            `Unknown activity type: "${activity.type}"`,
          );
      }

      const tonnes_co2e = activity.quantity * factor;
      results.push({
        type: activity.type,
        quantity: activity.quantity,
        tonnes_co2e: Math.round(tonnes_co2e * 1e6) / 1e6,
        factor_used: factor,
        factor_source: source,
      });
    }

    const total = results.reduce((sum, r) => sum + r.tonnes_co2e, 0);
    const totalRounded = Math.round(total * 10) / 10; // 0.1 tonne resolution

    return {
      activities: results,
      total_tonnes_co2e: totalRounded,
      // Always recommend at least 1 credit; round up to nearest 0.1 tonne
      recommended_credits: Math.max(0.1, Math.ceil(totalRounded * 10) / 10),
      methodology: 'DEFRA 2023 / GHG Protocol Scope 1-3',
    };
  }
}
