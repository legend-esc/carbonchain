import { Test, TestingModule } from '@nestjs/testing';
import { CreditsController } from './credits.controller';
import { CreditsService } from './credits.service';

// === Mock service

const mockCreditsService = {
  listCredits: jest.fn(),
  listCreditsCursor: jest.fn(),
  issueCredit: jest.fn(),
  getCredit: jest.fn(),
  getBulkCredits: jest.fn(),
  getCreditCount: jest.fn(),
  getCreditProvenance: jest.fn(),
  listCreditsByProject: jest.fn(),
  listCreditsByOwner: jest.fn(),
  transferCredit: jest.fn(),
  splitCredit: jest.fn(),
  expireCredit: jest.fn(),
  disputeCredit: jest.fn(),
  resolveDispute: jest.fn(),
  mergeCredits: jest.fn(),
};

// === Setup

describe('CreditsController — listCredits pagination bounds', () => {
  let controller: CreditsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CreditsController],
      providers: [{ provide: CreditsService, useValue: mockCreditsService }],
    }).compile();

    controller = module.get<CreditsController>(CreditsController);
  });

  afterEach(() => jest.clearAllMocks());

  // === limit clamping (offset path)

  describe('limit clamping — offset path', () => {
    it('passes the default limit (20) unchanged', async () => {
      mockCreditsService.listCredits.mockResolvedValueOnce({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
      });

      await controller.listCredits(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        '1',
        '20',
      );

      expect(mockCreditsService.listCredits).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 20, page: 1 }),
      );
    });

    it('clamps limit above 100 down to 100', async () => {
      mockCreditsService.listCredits.mockResolvedValueOnce({
        data: [],
        total: 0,
        page: 1,
        limit: 100,
      });

      await controller.listCredits(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        '1',
        '9999',
      );

      expect(mockCreditsService.listCredits).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 }),
      );
    });

    it('clamps limit of 0 up to 1', async () => {
      mockCreditsService.listCredits.mockResolvedValueOnce({
        data: [],
        total: 0,
        page: 1,
        limit: 1,
      });

      await controller.listCredits(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        '1',
        '0',
      );

      expect(mockCreditsService.listCredits).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1 }),
      );
    });

    it('clamps a negative limit up to 1', async () => {
      mockCreditsService.listCredits.mockResolvedValueOnce({
        data: [],
        total: 0,
        page: 1,
        limit: 1,
      });

      await controller.listCredits(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        '1',
        '-5',
      );

      expect(mockCreditsService.listCredits).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1 }),
      );
    });

    it('treats a non-numeric limit string as 1', async () => {
      mockCreditsService.listCredits.mockResolvedValueOnce({
        data: [],
        total: 0,
        page: 1,
        limit: 1,
      });

      await controller.listCredits(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        '1',
        'abc',
      );

      expect(mockCreditsService.listCredits).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1 }),
      );
    });
  });

  // === page clamping (offset path)

  describe('page clamping — offset path', () => {
    it('passes page 2 unchanged', async () => {
      mockCreditsService.listCredits.mockResolvedValueOnce({
        data: [],
        total: 0,
        page: 2,
        limit: 20,
      });

      await controller.listCredits(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        '2',
        '20',
      );

      expect(mockCreditsService.listCredits).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2 }),
      );
    });

    it('clamps page 0 up to 1', async () => {
      mockCreditsService.listCredits.mockResolvedValueOnce({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
      });

      await controller.listCredits(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        '0',
        '20',
      );

      expect(mockCreditsService.listCredits).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1 }),
      );
    });

    it('clamps a negative page up to 1', async () => {
      mockCreditsService.listCredits.mockResolvedValueOnce({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
      });

      await controller.listCredits(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        '-10',
        '20',
      );

      expect(mockCreditsService.listCredits).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1 }),
      );
    });

    it('treats a non-numeric page string as 1', async () => {
      mockCreditsService.listCredits.mockResolvedValueOnce({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
      });

      await controller.listCredits(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'nope',
        '20',
      );

      expect(mockCreditsService.listCredits).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1 }),
      );
    });
  });

  // === limit clamping (cursor path)

  describe('limit clamping — cursor path', () => {
    it('clamps limit above 100 to 100 on the cursor path', async () => {
      mockCreditsService.listCreditsCursor.mockResolvedValueOnce({
        data: [],
        next_cursor: null,
        limit: 100,
        pagination_mode: 'cursor',
      });

      await controller.listCredits(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'someCursor',
        '1',
        '500',
      );

      expect(mockCreditsService.listCreditsCursor).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 }),
      );
    });

    it('clamps limit of 0 to 1 on the cursor path', async () => {
      mockCreditsService.listCreditsCursor.mockResolvedValueOnce({
        data: [],
        next_cursor: null,
        limit: 1,
        pagination_mode: 'cursor',
      });

      await controller.listCredits(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'someCursor',
        '1',
        '0',
      );

      expect(mockCreditsService.listCreditsCursor).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1 }),
      );
    });

    it('routes to cursor path when cursor is provided, ignoring page', async () => {
      mockCreditsService.listCreditsCursor.mockResolvedValueOnce({
        data: [],
        next_cursor: null,
        limit: 20,
        pagination_mode: 'cursor',
      });

      await controller.listCredits(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'abc123',
        '5',
        '20',
      );

      expect(mockCreditsService.listCreditsCursor).toHaveBeenCalled();
      expect(mockCreditsService.listCredits).not.toHaveBeenCalled();
    });
  });
});
