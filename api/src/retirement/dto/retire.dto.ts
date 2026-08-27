import { IsNotEmpty, IsString } from 'class-validator';
import { IsStellarAddress } from '../../common/validators/is-stellar-address.decorator';

export class RetireDto {
  @IsStellarAddress()
  buyerPublicKey!: string;

  @IsString()
  @IsNotEmpty()
  creditId!: string;

  @IsString()
  @IsNotEmpty()
  tonnes!: string;

  @IsString()
  @IsNotEmpty()
  reason!: string;
}
