import { IsOptional, IsInt, Min, Max, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Issue #942 — Pagination for retirement listing endpoints.
 * pageSize is hard-capped at MAX_PAGE_SIZE by the validator.
 */
export const MAX_PAGE_SIZE = 100;

export class ListRetirementsDto {
  @ApiPropertyOptional({
    description: 'Page number (1-indexed)',
    default: 1,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  page?: number = 1;

  @ApiPropertyOptional({
    description: `Number of records per page (max ${MAX_PAGE_SIZE})`,
    default: 20,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize?: number = 20;

  @ApiPropertyOptional({ description: 'Filter by buyer Stellar address' })
  @IsOptional()
  @IsString()
  buyer?: string;

  @ApiPropertyOptional({ description: 'Filter by retirement status' })
  @IsOptional()
  @IsString()
  status?: string;
}

/** Generic paginated response shape used by retirement listing endpoints. */
export interface PaginatedRetirements<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  /** String-encoded next page number, or null when on the last page. */
  nextCursor: string | null;
}
