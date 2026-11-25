import { CalculatorService } from './calculator.service';
import { BadRequestException } from '@nestjs/common';

describe('CalculatorService', () => {
  let service: CalculatorService;

  beforeEach(() => {
    service = new CalculatorService();
  });

  it('calculates short-haul flight emissions (DEFRA benchmark)', () => {
    const result = service.estimate([
      { type: 'flight_short_haul', quantity: 1000 },
    ]);
    // 1000 km × 0.000255 tCO2e/km = 0.255 → rounded to 0.1 = 0.3
    expect(result.total_tonnes_co2e).toBeCloseTo(0.3, 1);
  });

  it('calculates long-haul flight emissions (DEFRA benchmark)', () => {
    const result = service.estimate([
      { type: 'flight_long_haul', quantity: 10000 },
    ]);
    // 10 000 km × 0.000195 = 1.95 → rounded to 0.1 = 2.0
    expect(result.total_tonnes_co2e).toBeCloseTo(2.0, 1);
  });

  it('calculates electricity emissions', () => {
    const result = service.estimate([{ type: 'electricity', quantity: 1000 }]);
    // 1000 kWh × 0.000233 = 0.233 → 0.2
    expect(result.total_tonnes_co2e).toBeCloseTo(0.2, 1);
  });

  it('calculates server-hour emissions', () => {
    const result = service.estimate([{ type: 'server_hours', quantity: 1000 }]);
    expect(result.total_tonnes_co2e).toBeGreaterThanOrEqual(0);
  });

  it('sums multiple activities', () => {
    const result = service.estimate([
      { type: 'flight_short_haul', quantity: 1000 },
      { type: 'electricity', quantity: 500 },
    ]);
    expect(result.activities).toHaveLength(2);
    expect(result.total_tonnes_co2e).toBeGreaterThan(0);
  });

  it('recommends at least 0.1 credits', () => {
    const result = service.estimate([{ type: 'train', quantity: 1 }]);
    expect(result.recommended_credits).toBeGreaterThanOrEqual(0.1);
  });

  it('throws on empty activities', () => {
    expect(() => service.estimate([])).toThrow(BadRequestException);
  });

  it('throws on negative quantity', () => {
    expect(() =>
      service.estimate([{ type: 'electricity', quantity: -1 }]),
    ).toThrow(BadRequestException);
  });

  it('throws on unknown activity type', () => {
    expect(() =>
      service.estimate([{ type: 'unknown_type' as any, quantity: 100 }]),
    ).toThrow(BadRequestException);
  });

  it('returns methodology string', () => {
    const result = service.estimate([{ type: 'car_petrol', quantity: 100 }]);
    expect(result.methodology).toContain('DEFRA');
  });
});
