/**
 * Issue #1297 — Keyset pagination using cursor-based approach
 * Replaces offset/limit pagination for high-volume transaction history
 * Cursor is composite of (timestamp, id) for consistent ordering
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Cursor-based pagination request (instead of offset/limit)
 * Cursor = base64(timestamp:id) pointing to record after which to fetch
 */
export class CursorPaginationDto {
  @ApiPropertyOptional({
    description: 'Opaque cursor from previous response.next_cursor',
    example: 'eyJ0czogIjIwMjQtMDEtMDFUMDA6MDA6MDBaIiwgImlkIjogInV1aWQtc3RyaW5nIn0=',
  })
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Number of records to return (1-500, default 100)',
    example: 50,
    minimum: 1,
    maximum: 500,
  })
  limit?: number;

  constructor(cursor?: string, limit?: number) {
    this.cursor = cursor;
    this.limit = Math.min(limit ?? 100, 500);
  }
}

/**
 * Decoded cursor object
 */
export interface CursorData {
  timestamp: string;
  id: string;
}

/**
 * Response wrapper with pagination metadata
 */
export class PaginatedResponseDto<T> {
  @ApiProperty({ description: 'Array of records' })
  data: T[];

  @ApiPropertyOptional({
    description: 'Opaque cursor for next page (null if no more records)',
    example: 'eyJ0czogIjIwMjQtMDEtMDJUMDA6MDA6MDBaIiwgImlkIjogInV1aWQtc3RyaW5nMiJ9',
  })
  next_cursor?: string;

  @ApiProperty({ description: 'Total records in this page' })
  count: number;

  constructor(data: T[], next_cursor?: string) {
    this.data = data;
    this.next_cursor = next_cursor;
    this.count = data.length;
  }
}

/**
 * Utility to encode cursor
 */
export function encodeCursor(timestamp: string, id: string): string {
  const data: CursorData = { timestamp, id };
  return Buffer.from(JSON.stringify(data)).toString('base64');
}

/**
 * Utility to decode cursor
 */
export function decodeCursor(cursor: string): CursorData {
  try {
    const data = JSON.parse(Buffer.from(cursor, 'base64').toString());
    return data as CursorData;
  } catch {
    throw new Error('Invalid cursor format');
  }
}
