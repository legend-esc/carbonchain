/**
 * Unit tests for BadgeController (#1306).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { BadgeController } from './badge.controller';
import { RetirementService } from './retirement.service';

// ── Mock response helper ───────────────────────────────────────────────────────

function buildMockResponse() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown;

  return {
    res: {
      setHeader: jest.fn((k: string, v: string) => { headers[k] = v; }),
      status: jest.fn().mockReturnThis(),
      send: jest.fn((b: unknown) => { body = b; }),
    } as unknown as import('express').Response,
    getStatusCode: () => statusCode,
    getBody: () => body,
    getHeader: (k: string) => headers[k],
    // Capture the last status() call.
    captureStatus: () => {
      return (body as undefined, statusCode);
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BadgeController', () => {
  let controller: BadgeController;
  let retirementService: { getRetirement: jest.Mock };

  beforeEach(async () => {
    retirementService = { getRetirement: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BadgeController],
      providers: [
        { provide: RetirementService, useValue: retirementService },
      ],
    }).compile();

    controller = module.get<BadgeController>(BadgeController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('GET /retirement/certificate/:id/badge', () => {
    it('returns 200 with a green SVG badge for a known retirement', async () => {
      retirementService.getRetirement.mockResolvedValueOnce({
        buyer: 'GBSOK5REZRYMHX5ZJNDZUPUKLDVSAXTJ6D5OKXWOEENUTLZHOP2TWZDY',
        tonnes_retired: '50',
      });

      const { res } = buildMockResponse();
      await controller.getBadge('deadbeef01020304', undefined, res);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/svg+xml');
      // 200 status means status() was NOT called with 404.
      const statusMock = res.status as jest.Mock;
      if (statusMock.mock.calls.length > 0) {
        expect(statusMock.mock.calls[0][0]).toBe(200);
      }
      const body = (res.send as jest.Mock).mock.calls[0][0] as string;
      expect(body).toContain('<svg');
      expect(body).toContain('carbon retired');
      // Value label should contain tonnes and truncated buyer address.
      expect(body).toContain('50t');
      expect(body).toContain('Stellar');
    });

    it('returns 404 with an Unverified SVG badge for an unknown certificate', async () => {
      retirementService.getRetirement.mockRejectedValueOnce(
        new NotFoundException('not found'),
      );

      const { res } = buildMockResponse();
      await controller.getBadge('unknownid', undefined, res);

      const statusMock = res.status as jest.Mock;
      expect(statusMock).toHaveBeenCalledWith(404);

      const body = (res.send as jest.Mock).mock.calls[0][0] as string;
      expect(body).toContain('<svg');
      expect(body).toContain('Unverified');
    });

    it('sets no-cache headers', async () => {
      retirementService.getRetirement.mockResolvedValueOnce({
        buyer: 'GBSOK5',
        tonnes_retired: '10',
      });

      const { res } = buildMockResponse();
      await controller.getBadge('abc', undefined, res);

      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache, max-age=0');
      expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    });

    describe('style parameter', () => {
      const styles = ['flat', 'plastic', 'dark'] as const;

      for (const style of styles) {
        it(`accepts style="${style}" and returns a valid SVG`, async () => {
          retirementService.getRetirement.mockResolvedValueOnce({
            buyer: 'GBSOK5',
            tonnes_retired: '20',
          });

          const { res } = buildMockResponse();
          await controller.getBadge('abc', style, res);

          const body = (res.send as jest.Mock).mock.calls[0][0] as string;
          expect(body).toContain('<svg');
        });
      }

      it('falls back to "flat" for an unknown style', async () => {
        retirementService.getRetirement.mockResolvedValueOnce({
          buyer: 'GBSOK5',
          tonnes_retired: '5',
        });

        const { res } = buildMockResponse();
        await controller.getBadge('abc', 'neon' as unknown as string, res);

        // Should not throw and should return SVG.
        const body = (res.send as jest.Mock).mock.calls[0][0] as string;
        expect(body).toContain('<svg');
      });
    });

    it('truncates a long buyer address in the value label', async () => {
      const longBuyer = 'GBSOK5REZRYMHX5ZJNDZUPUKLDVSAXTJ6D5OKXWOEENUTLZHOP2TWZDY';
      retirementService.getRetirement.mockResolvedValueOnce({
        buyer: longBuyer,
        tonnes_retired: '100',
      });

      const { res } = buildMockResponse();
      await controller.getBadge('abc', undefined, res);

      const body = (res.send as jest.Mock).mock.calls[0][0] as string;
      // Truncated form: first 6 chars + ellipsis + last 4 chars.
      expect(body).toContain('GBSOK5');
      expect(body).toContain('WZDY');
      // Full address should not appear verbatim.
      expect(body).not.toContain(longBuyer);
    });

    it('returns XML-safe SVG (escapes & < > in buyer address)', async () => {
      retirementService.getRetirement.mockResolvedValueOnce({
        buyer: '<script>alert(1)</script>',
        tonnes_retired: '1',
      });

      const { res } = buildMockResponse();
      await controller.getBadge('abc', undefined, res);

      const body = (res.send as jest.Mock).mock.calls[0][0] as string;
      expect(body).not.toContain('<script>');
    });
  });
});
