/**
 * Issue #1295 — GeoJSON polygon boundary validation for forestry carbon projects
 * Validates polygon coordinates, checks for self-intersections, calculates area
 */

import { Injectable, BadRequestException } from '@nestjs/common';

@Injectable()
export class GeoJsonValidationService {
  /**
   * Validate GeoJSON polygon coordinates
   * - Must form closed ring (first and last coordinate equal)
   * - No self-intersections
   * - Surface area in hectares
   */
  validatePolygon(coordinates: number[][][]): {
    valid: boolean;
    area_hectares: number;
    error?: string;
  } {
    if (!coordinates || coordinates.length === 0) {
      throw new BadRequestException('Polygon coordinates required');
    }

    const ring = coordinates[0]; // exterior ring

    // Validate closed ring
    if (ring.length < 4) {
      throw new BadRequestException('Polygon ring must have at least 4 coordinates');
    }

    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      throw new BadRequestException('Polygon ring must be closed (first and last coordinates must match)');
    }

    // Check for self-intersections using line segment intersection
    for (let i = 0; i < ring.length - 2; i++) {
      for (let j = i + 2; j < ring.length - 1; j++) {
        if (this.segmentsIntersect(ring[i], ring[i + 1], ring[j], ring[j + 1])) {
          throw new BadRequestException('Polygon has self-intersecting segments');
        }
      }
    }

    // Calculate area using Shoelace formula (approximation)
    const area = this.calculatePolygonArea(ring);
    const hectares = area / 10000; // 1 hectare = 10000 m² (approximate)

    if (hectares < 0.01) {
      throw new BadRequestException('Polygon area must be at least 0.01 hectares');
    }

    if (hectares > 10000000) {
      throw new BadRequestException('Polygon area must be less than 10,000,000 hectares');
    }

    return {
      valid: true,
      area_hectares: parseFloat(hectares.toFixed(4)),
    };
  }

  /**
   * Check if two line segments intersect
   * Uses parametric line equations
   */
  private segmentsIntersect(
    p1: number[],
    p2: number[],
    p3: number[],
    p4: number[],
  ): boolean {
    const [x1, y1] = p1;
    const [x2, y2] = p2;
    const [x3, y3] = p3;
    const [x4, y4] = p4;

    const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);

    if (Math.abs(denom) < 1e-10) {
      return false; // parallel
    }

    const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
    const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;

    return ua > 0 && ua < 1 && ub > 0 && ub < 1;
  }

  /**
   * Calculate polygon area using Shoelace formula
   * Assumes coordinates are in degrees (lat/lon)
   * Returns approximate area in square meters
   */
  private calculatePolygonArea(ring: number[][]): number {
    let area = 0;
    const radius = 6371000; // Earth radius in meters

    for (let i = 0; i < ring.length - 1; i++) {
      const [lon1, lat1] = ring[i];
      const [lon2, lat2] = ring[i + 1];

      const lat1Rad = this.toRad(lat1);
      const lat2Rad = this.toRad(lat2);
      const dLon = this.toRad(lon2 - lon1);

      area += Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dLon);
      area -= Math.sin(lat2Rad) * Math.cos(lat1Rad) * Math.sin(dLon);
    }

    area = Math.abs(area) * radius * radius / 2;
    return area;
  }

  private toRad(degrees: number): number {
    return (degrees * Math.PI) / 180;
  }

  /**
   * Validate project coordinates are within country bounds
   */
  validateCountryBounds(
    coordinates: number[][][],
    country: string,
  ): boolean {
    // Simplified: check latitude bounds for major regions
    const bounds: Record<string, [number, number]> = {
      'US': [25, 50],
      'CA': [42, 85],
      'BR': [-34, 5],
      'NG': [3, 14],
      'ID': [-11, 6],
      'RU': [42, 82],
      'CN': [18, 53],
      'AU': [-44, -10],
    };

    const bounds_range = bounds[country];
    if (!bounds_range) return true; // Unknown country, skip validation

    const ring = coordinates[0];
    const lats = ring.map((c) => c[1]);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);

    return minLat >= bounds_range[0] && maxLat <= bounds_range[1];
  }
}
