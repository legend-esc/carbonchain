import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';
import { IsIpfsCid } from '../../common/validators/is-ipfs-cid.decorator';
import { IsStellarAddress } from '../../common/validators/is-stellar-address.decorator';
import { IsValidMethodology } from '../validators/methodology.validator';

export class IssueCreditDto {
  @IsStellarAddress()
  issuerPublicKey!: string;

  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @IsInt()
  @Min(0)
  vintageYear!: number;

  @IsValidMethodology()
  methodology!: string;

  @IsString()
  @IsNotEmpty()
  geography!: string;

  @IsString()
  @IsNotEmpty()
  tonnes!: string;

  @IsIpfsCid()
  ipfsHash!: string;
}
