import { IsString, IsNotEmpty, IsNumberString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Canonical DTO for retiring a single carbon credit.
 *
 * ## Canonical retirement path
 * `POST /retirement` (RetirementController) is the **canonical** retire
 * entrypoint.  `POST /credits/:id/retire` (CreditsController) is a thin
 * proxy that constructs this same DTO and delegates directly to
 * `RetirementService.retire()` — both routes produce an identical response
 * shape `{ retirementId: string; certificateIpfsHash: string }`.
 *
 * Any changes to the retire flow MUST be made in `RetirementService.retire()`
 * only; the proxy route must never add independent logic.
 */
export class RetireDto {
  @ApiProperty({
    example: 'GABC...XYZ',
    description: 'Stellar public key of the buyer',
  })
  @IsString()
  @IsNotEmpty()
  buyerPublicKey: string;

  @ApiProperty({ example: '037176a1...', description: 'Hex-encoded credit ID' })
  @IsString()
  @IsNotEmpty()
  creditId: string;

  @ApiProperty({ example: '1000000', description: '1 tonne = 1_000_000 units' })
  @IsNumberString()
  @IsNotEmpty()
  tonnes: string;

  @ApiProperty({ example: '2024 Scope 3 offset' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}
