/**
 * #1306 — Public SVG badge and embeddable iframe widget for verified retirement proof.
 *
 * GET /retirement/certificate/:id/badge
 *
 * Renders a Shields.io-style SVG badge showing:
 *  - Retiree name (buyer address, truncated)
 *  - Tonnes retired
 *  - Verified status anchored to the Stellar network
 *
 * Query parameters:
 *   style  — 'flat' (default) | 'plastic' | 'dark'
 *
 * Returns 200 image/svg+xml for a known, verified retirement.
 * Returns 404 with a gray 'Unverified' SVG badge for unknown certificate IDs.
 */
import { Controller, Get, Param, Query, Res, HttpStatus } from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RetirementService } from './retirement.service';

// ── Style definitions ──────────────────────────────────────────────────────────

type BadgeStyle = 'flat' | 'plastic' | 'dark';

interface StyleConfig {
  bg: string;
  labelBg: string;
  textColor: string;
  font: string;
  shadow: boolean;
}

const STYLES: Record<BadgeStyle, StyleConfig> = {
  flat: {
    bg: '#4c8c4a',
    labelBg: '#555',
    textColor: '#fff',
    font: 'DejaVu Sans,Verdana,Geneva,sans-serif',
    shadow: false,
  },
  plastic: {
    bg: '#4c8c4a',
    labelBg: '#444',
    textColor: '#fff',
    font: 'DejaVu Sans,Verdana,Geneva,sans-serif',
    shadow: true,
  },
  dark: {
    bg: '#1b4d1b',
    labelBg: '#222',
    textColor: '#d4f7d4',
    font: 'DejaVu Sans,Verdana,Geneva,sans-serif',
    shadow: false,
  },
};

// ── SVG builders ───────────────────────────────────────────────────────────────

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Approximate character-width for the badge value text in px (11px font). */
function textWidth(text: string): number {
  // Rough estimate: average 6.5px per character.
  return Math.ceil(text.length * 6.5) + 10;
}

function buildSvg(opts: {
  label: string;
  value: string;
  style: StyleConfig;
  shadow: boolean;
}): string {
  const { label, value, style } = opts;

  const labelW = textWidth(label);
  const valueW = textWidth(value);
  const totalW = labelW + valueW;
  const height = 20;

  const labelX = (labelW / 2 + 1).toFixed(1);
  const valueX = (labelW + valueW / 2 - 1).toFixed(1);

  const gradient = style.shadow
    ? `<linearGradient id="s" x2="0" y2="100%">
        <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
        <stop offset="1" stop-opacity=".1"/>
      </linearGradient>`
    : '';

  const gradientRect = style.shadow
    ? `<rect rx="3" width="${totalW}" height="${height}" fill="url(#s)"/>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${totalW}" height="${height}" role="img" aria-label="${escapeXml(label)}: ${escapeXml(value)}">
  <title>${escapeXml(label)}: ${escapeXml(value)}</title>
  <defs>${gradient}</defs>
  <rect rx="3" width="${totalW}" height="${height}" fill="${escapeXml(style.labelBg)}"/>
  <rect rx="3" x="${labelW}" width="${valueW}" height="${height}" fill="${escapeXml(style.bg)}"/>
  <rect x="${labelW}" width="4" height="${height}" fill="${escapeXml(style.bg)}"/>
  ${gradientRect}
  <g fill="${escapeXml(style.textColor)}" text-anchor="middle" font-family="${escapeXml(style.font)}" font-size="11" text-rendering="geometricPrecision">
    <text x="${labelX}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text>
    <text x="${labelX}" y="14">${escapeXml(label)}</text>
    <text x="${valueX}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(value)}</text>
    <text x="${valueX}" y="14">${escapeXml(value)}</text>
  </g>
</svg>`;
}

function buildUnverifiedSvg(style: StyleConfig): string {
  const unverifiedStyle: StyleConfig = {
    ...style,
    bg: '#9f9f9f',
    labelBg: '#555',
    textColor: '#fff',
  };
  return buildSvg({
    label: 'carbon retirement',
    value: 'Unverified',
    style: unverifiedStyle,
    shadow: style.shadow,
  });
}

// ── Controller ─────────────────────────────────────────────────────────────────

@ApiTags('retirement')
@Controller('retirement')
export class BadgeController {
  constructor(private readonly retirementService: RetirementService) {}

  /**
   * #1306 — Render a Shields.io-style SVG badge for a verified retirement.
   *
   * Returns 200 with a green badge for known certificates.
   * Returns 404 with a gray 'Unverified' badge for unknown IDs — the caller
   * still receives a valid SVG so embedded <img> tags render gracefully.
   */
  @ApiOperation({
    summary: 'Render a verified retirement proof SVG badge',
  })
  @ApiParam({
    name: 'id',
    description:
      'Retirement certificate ID (hex-encoded 32-byte retirement ID)',
  })
  @ApiQuery({
    name: 'style',
    required: false,
    enum: ['flat', 'plastic', 'dark'],
    description: 'Badge visual style (default: flat)',
  })
  @ApiResponse({
    status: 200,
    description: 'SVG badge for the verified retirement certificate',
    headers: { 'Content-Type': { description: 'image/svg+xml' } },
  })
  @ApiResponse({
    status: 404,
    description:
      'Certificate not found — gray Unverified SVG badge returned with 404 status',
  })
  @Get('certificate/:id/badge')
  async getBadge(
    @Param('id') id: string,
    @Query('style') styleParam: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    // Resolve and validate style.
    const validStyles: BadgeStyle[] = ['flat', 'plastic', 'dark'];
    const style: BadgeStyle =
      styleParam && validStyles.includes(styleParam as BadgeStyle)
        ? (styleParam as BadgeStyle)
        : 'flat';

    const styleConfig = STYLES[style];

    // Set common SVG headers.
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-cache, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Try to load the retirement record.
    let retirement: { buyer: string; tonnes_retired: string } | null = null;
    try {
      retirement = await this.retirementService.getRetirement(id);
    } catch {
      // NotFoundException or any other error → Unverified badge with 404.
      const svg = buildUnverifiedSvg(styleConfig);
      res.status(HttpStatus.NOT_FOUND).send(svg);
      return;
    }

    // Build value label: truncated buyer address + tonnes.
    const buyerShort =
      retirement.buyer.length > 12
        ? `${retirement.buyer.slice(0, 6)}…${retirement.buyer.slice(-4)}`
        : retirement.buyer;

    const tonnes = retirement.tonnes_retired;
    const value = `${tonnes}t · ${buyerShort} · Stellar`;

    const svg = buildSvg({
      label: 'carbon retired',
      value,
      style: styleConfig,
      shadow: styleConfig.shadow,
    });

    res.status(HttpStatus.OK).send(svg);
  }
}
