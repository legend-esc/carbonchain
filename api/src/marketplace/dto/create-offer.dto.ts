import { IsNotEmpty, IsString } from 'class-validator';
import { IsStellarAddress } from '../../common/validators/is-stellar-address.decorator';

export class CreateOfferDto {
  @IsStellarAddress()
  sellerPublicKey!: string;

  @IsString()
  @IsNotEmpty()
  creditId!: string;

  @IsString()
  @IsNotEmpty()
  priceXlm!: string;

  @IsString()
  @IsNotEmpty()
  tonnes!: string;
}
