import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StellarService } from './stellar.service';
import { StellarKeypairService } from './stellar-keypair.service';
import { SequenceNumberManager } from './sequence-number-manager.service';

@Module({
  imports: [ConfigModule],
  providers: [StellarService, StellarKeypairService, SequenceNumberManager],
  exports: [StellarService, StellarKeypairService, SequenceNumberManager],
})
export class StellarModule {}
